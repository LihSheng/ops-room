import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { validateIdempotencyKey } from './idempotency-store.js';
import { writeAtomic } from './review-task-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const MISSION_CHAT_SCHEMA = 'ops-room.mission-chat-session.v1';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SESSION_STATES = new Set(['open', 'needs_human', 'closed']);
const TURN_STATES = new Set(['provider_pending', 'completed', 'needs_human']);
const TERMINAL_MISSION_STATES = new Set(['completed', 'cancelled']);
const MAX_MESSAGE = 4_000;
const MAX_REPLY = 12_000;
const MAX_TURNS = 80;
const CHAT_LOCK_STALE_MS = 10 * 60 * 1000;

function digest(value: unknown) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function bounded(value: unknown, maximum: number) {
  return String(value ?? '').trim().slice(0, maximum);
}

function validateId(value: unknown, field: string) {
  const normalized = bounded(value, 200);
  if (!SAFE_ID.test(normalized)) throw new Error(`mission_chat_${field}_invalid`);
  return normalized;
}

function validateActor(actor: any) {
  const actorId = validateId(actor?.actor_id, 'actor_id');
  return {
    actor_id: actorId,
    actor_type: bounded(actor?.actor_type || 'human', 60),
    actor_display_name: bounded(actor?.actor_display_name || actor?.display_name || actorId, 120),
  };
}

function normalizeMessage(value: unknown) {
  const message = bounded(value, MAX_MESSAGE);
  if (!message) throw new Error('mission_chat_message_required');
  return message;
}

function normalizeReply(value: unknown) {
  const reply = bounded(value, MAX_REPLY);
  if (!reply) throw new Error('mission_chat_provider_empty_response');
  return reply;
}

function publicActor(actor: any) {
  return {
    actor_id: String(actor?.actor_id || ''),
    actor_type: String(actor?.actor_type || ''),
    actor_display_name: String(actor?.actor_display_name || ''),
  };
}

function normalizeParticipants(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error('mission_chat_participants_invalid');
  }
  const seen = new Set<string>();
  return value.map((participant: any) => {
    const agentId = validateId(participant?.agent_id, 'participant_agent_id');
    if (seen.has(agentId)) throw new Error('mission_chat_participant_duplicate');
    seen.add(agentId);
    const roles = Array.isArray(participant?.roles)
      ? participant.roles.map((role: unknown) => bounded(role, 80)).filter(Boolean)
      : [];
    if (roles.length < 1 || roles.length > 20) throw new Error('mission_chat_participant_roles_invalid');
    return { agent_id: agentId, roles: [...new Set(roles)] };
  });
}

function sessionIdFor(missionId: string) {
  return `mission-chat:${digest(missionId).slice(0, 40)}`;
}

function turnIdFor(sessionId: string, idempotencyKey: string) {
  return `mission-turn:${digest(`${sessionId}\n${idempotencyKey}`).slice(0, 40)}`;
}

function sessionPath(dir: string, sessionId: string) {
  return join(dir, `session-${digest(validateId(sessionId, 'session_id'))}.json`);
}

function lockName(sessionId: string) {
  return `mission-chat-${digest(sessionId).slice(0, 48)}`;
}

function missionParticipants(mission: any) {
  if (!mission || typeof mission !== 'object') throw new Error('mission_chat_mission_invalid');
  validateId(mission.mission_id, 'mission_id');
  return normalizeParticipants(mission.participants);
}

export function missionAllowsChatMutation(mission: any) {
  return !TERMINAL_MISSION_STATES.has(String(mission?.state || ''));
}

function participantForMission(mission: any, agentId: unknown) {
  const normalizedAgentId = validateId(agentId, 'target_agent_id');
  const participant = missionParticipants(mission).find((candidate) => candidate.agent_id === normalizedAgentId);
  if (!participant) throw new Error('mission_chat_target_not_participant');
  return participant;
}

export function validateMissionChatSession(record: any) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('mission_chat_record_invalid');
  if (record.schema !== MISSION_CHAT_SCHEMA) throw new Error('mission_chat_schema_invalid');
  validateId(record.session_id, 'session_id');
  validateId(record.mission_id, 'mission_id');
  validateActor(record.created_by);
  normalizeParticipants(record.participants);
  validateIdempotencyKey(record.creation_idempotency_key);
  if (!SESSION_STATES.has(record.state)) throw new Error('mission_chat_state_invalid');
  if (!record.created_at || !record.updated_at) throw new Error('mission_chat_timestamp_missing');
  if (!Array.isArray(record.turns) || record.turns.length > MAX_TURNS) throw new Error('mission_chat_turns_invalid');
  const seen = new Set<string>();
  for (const turn of record.turns) {
    validateId(turn.turn_id, 'turn_id');
    validateIdempotencyKey(turn.idempotency_key);
    if (seen.has(turn.turn_id)) throw new Error('mission_chat_turn_duplicate');
    seen.add(turn.turn_id);
    if (!TURN_STATES.has(turn.state)) throw new Error('mission_chat_turn_state_invalid');
    if (!/^[a-f0-9]{64}$/i.test(String(turn.content_hash || ''))) throw new Error('mission_chat_turn_hash_invalid');
    const participant = participantForMission({ mission_id: record.mission_id, participants: record.participants }, turn.target_agent_id);
    if (JSON.stringify(participant.roles) !== JSON.stringify(turn.target_roles)) {
      throw new Error('mission_chat_turn_roles_invalid');
    }
    normalizeMessage(turn.human_message?.content);
    validateActor(turn.human_message?.actor);
    if (!turn.human_message?.created_at || !turn.created_at || !turn.updated_at) throw new Error('mission_chat_turn_timestamp_missing');
    if (turn.state === 'completed') {
      normalizeReply(turn.agent_message?.content);
      if (turn.agent_message?.agent_id !== turn.target_agent_id) throw new Error('mission_chat_reply_agent_invalid');
      if (!turn.agent_message?.created_at) throw new Error('mission_chat_reply_timestamp_missing');
    }
    if (turn.state === 'provider_pending' && (turn.agent_message || turn.error_code)) {
      throw new Error('mission_chat_pending_terminal_evidence_invalid');
    }
  }
  return record;
}

export function serializeMissionChatSession(record: any) {
  const session = validateMissionChatSession(record);
  return {
    session_id: session.session_id,
    mission_id: session.mission_id,
    title: session.title,
    state: session.state,
    participants: session.participants.map((participant: any) => ({
      agent_id: participant.agent_id,
      roles: [...participant.roles],
    })),
    created_by: publicActor(session.created_by),
    created_at: session.created_at,
    updated_at: session.updated_at,
    closed_at: session.closed_at || null,
    last_error: session.last_error || null,
    turn_count: session.turns.length,
    turns: session.turns.map((turn: any) => ({
      turn_id: turn.turn_id,
      target_agent_id: turn.target_agent_id,
      target_roles: [...turn.target_roles],
      state: turn.state,
      human_message: {
        role: 'human',
        content: turn.human_message.content,
        actor: publicActor(turn.human_message.actor),
        created_at: turn.human_message.created_at,
      },
      agent_message: turn.agent_message ? {
        role: 'agent',
        agent_id: turn.agent_message.agent_id,
        content: turn.agent_message.content,
        created_at: turn.agent_message.created_at,
        provider: turn.agent_message.provider,
        model: turn.agent_message.model,
      } : null,
      error_code: turn.error_code || null,
      created_at: turn.created_at,
      updated_at: turn.updated_at,
    })),
  };
}

export async function readMissionChatSession({ dir, sessionId }: any) {
  try {
    return validateMissionChatSession(JSON.parse(await readFile(sessionPath(dir, sessionId), 'utf-8')));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readMissionChatSessionForMission({ dir, missionId }: any) {
  return readMissionChatSession({ dir, sessionId: sessionIdFor(validateId(missionId, 'mission_id')) });
}

export async function listMissionChatSessions({ dir, limit = 100 }: any) {
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir)).filter((name) => name.startsWith('session-') && name.endsWith('.json'));
  const records = [];
  for (const name of names) {
    try {
      records.push(validateMissionChatSession(JSON.parse(await readFile(join(dir, name), 'utf-8'))));
    } catch {
      // Corrupt records fail closed and remain unavailable to public readers.
    }
  }
  return records
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
}

export async function createOrLoadMissionChatSession({
  dir,
  mission,
  actor,
  idempotencyKey,
  now = () => new Date().toISOString(),
}: any) {
  const missionId = validateId(mission?.mission_id, 'mission_id');
  if (!missionAllowsChatMutation(mission)) throw new Error(`mission_chat_mission_terminal:${String(mission?.state || 'unknown')}`);
  const participants = missionParticipants(mission);
  const normalizedActor = validateActor(actor);
  const key = validateIdempotencyKey(idempotencyKey);
  const sessionId = sessionIdFor(missionId);
  return withWorkspaceLock({
    dir: join(dir, '.locks'),
    name: lockName(sessionId),
    staleAfterMs: CHAT_LOCK_STALE_MS,
    execute: async () => {
      const existing = await readMissionChatSession({ dir, sessionId });
      if (existing) {
        if (existing.mission_id !== missionId || JSON.stringify(existing.participants) !== JSON.stringify(participants)) {
          throw new Error('mission_chat_session_conflict');
        }
        return { created: false, session: existing, idempotent: true };
      }
      const at = now();
      const session = validateMissionChatSession({
        schema: MISSION_CHAT_SCHEMA,
        session_id: sessionId,
        mission_id: missionId,
        title: bounded(`${mission.title || missionId} participant chat`, 160),
        state: 'open',
        participants,
        created_by: normalizedActor,
        creation_idempotency_key: key,
        created_at: at,
        updated_at: at,
        closed_at: null,
        closed_by: null,
        close_reason: null,
        close_idempotency_key: null,
        last_error: null,
        turns: [],
      });
      await mkdir(dir, { recursive: true });
      await writeAtomic(sessionPath(dir, sessionId), session);
      return { created: true, session, idempotent: false };
    },
  });
}

function transcriptFor(session: any) {
  const transcript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of session.turns) {
    transcript.push({
      role: 'user',
      content: `[Human ${turn.human_message.actor.actor_display_name}] To ${turn.target_agent_id}: ${turn.human_message.content}`,
    });
    if (turn.state === 'completed' && turn.agent_message?.content) {
      transcript.push({
        role: 'assistant',
        content: `[${turn.agent_message.agent_id}] ${turn.agent_message.content}`,
      });
    }
  }
  return transcript.slice(-30);
}

export async function appendMissionChatTurn({
  dir,
  mission,
  sessionId,
  targetAgentId,
  actor,
  content,
  idempotencyKey,
  invokeProvider,
  now = () => new Date().toISOString(),
}: any) {
  const normalizedSessionId = validateId(sessionId, 'session_id');
  const missionId = validateId(mission?.mission_id, 'mission_id');
  if (!missionAllowsChatMutation(mission)) throw new Error(`mission_chat_mission_terminal:${String(mission?.state || 'unknown')}`);
  const participant = participantForMission(mission, targetAgentId);
  const normalizedActor = validateActor(actor);
  const message = normalizeMessage(content);
  const key = validateIdempotencyKey(idempotencyKey);
  const turnId = turnIdFor(normalizedSessionId, key);
  const contentHash = digest(`${participant.agent_id}\n${message}`);
  return withWorkspaceLock({
    dir: join(dir, '.locks'),
    name: lockName(normalizedSessionId),
    timeoutMs: 15_000,
    staleAfterMs: CHAT_LOCK_STALE_MS,
    execute: async () => {
      let session = await readMissionChatSession({ dir, sessionId: normalizedSessionId });
      if (!session) throw new Error('mission_chat_session_not_found');
      if (session.mission_id !== missionId) throw new Error('mission_chat_mission_mismatch');
      const existing = session.turns.find((turn: any) => turn.turn_id === turnId || turn.idempotency_key === key);
      if (existing) {
        if (existing.content_hash !== contentHash) throw new Error('mission_chat_idempotency_conflict');
        return { session, turn: existing, idempotent: true, provider_invoked: false };
      }
      if (session.state !== 'open') throw new Error(`mission_chat_session_not_open:${session.state}`);
      if (session.turns.length >= MAX_TURNS) throw new Error('mission_chat_turn_limit_reached');
      if (typeof invokeProvider !== 'function') throw new Error('mission_chat_provider_unavailable');

      const at = now();
      const pendingTurn = {
        turn_id: turnId,
        idempotency_key: key,
        content_hash: contentHash,
        target_agent_id: participant.agent_id,
        target_roles: [...participant.roles],
        state: 'provider_pending',
        human_message: {
          role: 'human',
          content: message,
          actor: normalizedActor,
          created_at: at,
        },
        agent_message: null,
        error_code: null,
        created_at: at,
        updated_at: at,
      };
      session = validateMissionChatSession({
        ...session,
        updated_at: at,
        turns: [...session.turns, pendingTurn],
      });
      await writeAtomic(sessionPath(dir, normalizedSessionId), session);

      try {
        const response = await invokeProvider({
          mission,
          participant,
          transcript: transcriptFor(session),
        });
        const reply = normalizeReply(response?.text);
        const completedAt = now();
        const completedTurn = {
          ...pendingTurn,
          state: 'completed',
          agent_message: {
            role: 'agent',
            agent_id: participant.agent_id,
            content: reply,
            created_at: completedAt,
            provider: bounded(response?.provider || 'opencode', 80),
            model: bounded(response?.model || 'unknown', 120),
          },
          updated_at: completedAt,
        };
        session = validateMissionChatSession({
          ...session,
          updated_at: completedAt,
          last_error: null,
          turns: session.turns.map((turn: any) => turn.turn_id === turnId ? completedTurn : turn),
        });
        await writeAtomic(sessionPath(dir, normalizedSessionId), session);
        return { session, turn: completedTurn, idempotent: false, provider_invoked: true };
      } catch (error: any) {
        const failedAt = now();
        const raw = String(error?.message || '').toLowerCase();
        const errorCode = /^[a-z0-9][a-z0-9._:-]{0,119}$/.test(raw) ? raw : 'mission_chat_provider_failed';
        const failedTurn = {
          ...pendingTurn,
          state: 'needs_human',
          error_code: errorCode,
          updated_at: failedAt,
        };
        session = validateMissionChatSession({
          ...session,
          state: 'needs_human',
          updated_at: failedAt,
          last_error: errorCode,
          turns: session.turns.map((turn: any) => turn.turn_id === turnId ? failedTurn : turn),
        });
        await writeAtomic(sessionPath(dir, normalizedSessionId), session);
        return { session, turn: failedTurn, idempotent: false, provider_invoked: true };
      }
    },
  });
}

export async function closeMissionChatSession({
  dir,
  mission,
  sessionId,
  actor,
  reason,
  idempotencyKey,
  now = () => new Date().toISOString(),
}: any) {
  const normalizedSessionId = validateId(sessionId, 'session_id');
  const missionId = validateId(mission?.mission_id, 'mission_id');
  const normalizedActor = validateActor(actor);
  const key = validateIdempotencyKey(idempotencyKey);
  const normalizedReason = bounded(reason, 500);
  if (!normalizedReason) throw new Error('mission_chat_close_reason_required');
  return withWorkspaceLock({
    dir: join(dir, '.locks'),
    name: lockName(normalizedSessionId),
    staleAfterMs: CHAT_LOCK_STALE_MS,
    execute: async () => {
      const session = await readMissionChatSession({ dir, sessionId: normalizedSessionId });
      if (!session) throw new Error('mission_chat_session_not_found');
      if (session.mission_id !== missionId) throw new Error('mission_chat_mission_mismatch');
      if (session.state === 'closed') return { session, idempotent: true };
      const at = now();
      const closed = validateMissionChatSession({
        ...session,
        state: 'closed',
        updated_at: at,
        closed_at: at,
        closed_by: normalizedActor,
        close_reason: normalizedReason,
        close_idempotency_key: key,
      });
      await writeAtomic(sessionPath(dir, normalizedSessionId), closed);
      return { session: closed, idempotent: false };
    },
  });
}

export async function reconcileInterruptedMissionChatTurns({ dir, now = () => new Date().toISOString() }: any) {
  const sessions = await listMissionChatSessions({ dir, limit: 500 });
  const recovered: string[] = [];
  for (const record of sessions) {
    if (!record.turns.some((turn: any) => turn.state === 'provider_pending')) continue;
    await withWorkspaceLock({
      dir: join(dir, '.locks'),
      name: lockName(record.session_id),
      staleAfterMs: CHAT_LOCK_STALE_MS,
      execute: async () => {
        const current = await readMissionChatSession({ dir, sessionId: record.session_id });
        if (!current) return;
        const at = now();
        let changed = false;
        const turns = current.turns.map((turn: any) => {
          if (turn.state !== 'provider_pending') return turn;
          changed = true;
          recovered.push(turn.turn_id);
          return {
            ...turn,
            state: 'needs_human',
            error_code: 'mission_chat_provider_interrupted',
            updated_at: at,
          };
        });
        if (!changed) return;
        await writeAtomic(sessionPath(dir, current.session_id), validateMissionChatSession({
          ...current,
          state: current.state === 'closed' ? 'closed' : 'needs_human',
          last_error: current.state === 'closed' ? current.last_error : 'mission_chat_provider_interrupted',
          updated_at: at,
          turns,
        }));
      },
    });
  }
  return { scanned_sessions: sessions.length, recovered_turns: recovered.length, recovered };
}

export { MAX_MESSAGE, MAX_REPLY, MAX_TURNS, sessionIdFor as missionChatSessionIdFor };
