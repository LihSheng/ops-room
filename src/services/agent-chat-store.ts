import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { writeAtomic } from './review-task-store.js';
import { validateIdempotencyKey } from './idempotency-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const CHAT_SCHEMA = 'ops-room.agent-chat-session.v1';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SESSION_STATES = new Set(['open', 'needs_human', 'closed']);
const TURN_STATES = new Set(['provider_pending', 'completed', 'needs_human']);
const MAX_TITLE = 120;
const MAX_MESSAGE = 4_000;
const MAX_REPLY = 12_000;
const MAX_TURNS = 50;
const CHAT_LOCK_STALE_MS = 10 * 60 * 1000;

function digest(value: unknown) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function bounded(value: unknown, maximum: number) {
  return String(value ?? '').trim().slice(0, maximum);
}

function validateId(value: unknown, field: string) {
  const normalized = bounded(value, 200);
  if (!SAFE_ID.test(normalized)) throw new Error(`agent_chat_${field}_invalid`);
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

function sessionIdFor({ actorId, agentId, idempotencyKey }: any) {
  return `chat:${digest(`${actorId}\n${agentId}\n${idempotencyKey}`).slice(0, 40)}`;
}

function turnIdFor(sessionId: string, idempotencyKey: string) {
  return `turn:${digest(`${sessionId}\n${idempotencyKey}`).slice(0, 40)}`;
}

function sessionPath(dir: string, sessionId: string) {
  return join(dir, `session-${digest(validateId(sessionId, 'session_id'))}.json`);
}

function lockName(sessionId: string) {
  return `agent-chat-${digest(sessionId).slice(0, 48)}`;
}

function normalizeTitle(value: unknown, agentId: string) {
  return bounded(value || `Chat with ${agentId}`, MAX_TITLE) || `Chat with ${agentId}`;
}

function normalizeMessage(value: unknown) {
  const message = bounded(value, MAX_MESSAGE);
  if (!message) throw new Error('agent_chat_message_required');
  return message;
}

function normalizeReply(value: unknown) {
  const reply = bounded(value, MAX_REPLY);
  if (!reply) throw new Error('agent_chat_provider_empty_response');
  return reply;
}

function publicActor(actor: any) {
  return {
    actor_id: String(actor?.actor_id || ''),
    actor_type: String(actor?.actor_type || ''),
    actor_display_name: String(actor?.actor_display_name || ''),
  };
}

export function validateAgentChatSession(record: any) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('agent_chat_record_invalid');
  if (record.schema !== CHAT_SCHEMA) throw new Error('agent_chat_schema_invalid');
  validateId(record.session_id, 'session_id');
  validateId(record.agent_id, 'agent_id');
  validateActor(record.created_by);
  if (!SESSION_STATES.has(record.state)) throw new Error('agent_chat_state_invalid');
  if (!record.created_at || !record.updated_at) throw new Error('agent_chat_timestamp_missing');
  if (!Array.isArray(record.turns) || record.turns.length > MAX_TURNS) throw new Error('agent_chat_turns_invalid');
  const seen = new Set<string>();
  for (const turn of record.turns) {
    validateId(turn.turn_id, 'turn_id');
    validateIdempotencyKey(turn.idempotency_key);
    if (seen.has(turn.turn_id)) throw new Error('agent_chat_turn_duplicate');
    seen.add(turn.turn_id);
    if (!TURN_STATES.has(turn.state)) throw new Error('agent_chat_turn_state_invalid');
    if (!/^[a-f0-9]{64}$/i.test(String(turn.content_hash || ''))) throw new Error('agent_chat_turn_hash_invalid');
    normalizeMessage(turn.human_message?.content);
    validateActor(turn.human_message?.actor);
    if (!turn.human_message?.created_at || !turn.created_at || !turn.updated_at) throw new Error('agent_chat_turn_timestamp_missing');
    if (turn.state === 'completed') {
      normalizeReply(turn.agent_message?.content);
      if (!turn.agent_message?.created_at) throw new Error('agent_chat_reply_timestamp_missing');
    }
    if (turn.state === 'provider_pending' && (turn.agent_message || turn.error_code)) {
      throw new Error('agent_chat_pending_terminal_evidence_invalid');
    }
  }
  return record;
}

export function serializeAgentChatSession(record: any) {
  const session = validateAgentChatSession(record);
  return {
    session_id: session.session_id,
    agent_id: session.agent_id,
    title: session.title,
    state: session.state,
    created_by: publicActor(session.created_by),
    created_at: session.created_at,
    updated_at: session.updated_at,
    closed_at: session.closed_at || null,
    last_error: session.last_error || null,
    turn_count: session.turns.length,
    turns: session.turns.map((turn: any) => ({
      turn_id: turn.turn_id,
      state: turn.state,
      human_message: {
        role: 'human',
        content: turn.human_message.content,
        actor: publicActor(turn.human_message.actor),
        created_at: turn.human_message.created_at,
      },
      agent_message: turn.agent_message ? {
        role: 'agent',
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

export async function readAgentChatSession({ dir, sessionId }: any) {
  try {
    return validateAgentChatSession(JSON.parse(await readFile(sessionPath(dir, sessionId), 'utf-8')));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listAgentChatSessions({ dir, agentId = null, limit = 50 }: any) {
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir)).filter((name) => name.startsWith('session-') && name.endsWith('.json'));
  const records = [];
  for (const name of names) {
    try {
      const record = validateAgentChatSession(JSON.parse(await readFile(join(dir, name), 'utf-8')));
      if (agentId && record.agent_id !== agentId) continue;
      records.push(record);
    } catch {
      // Corrupt records fail closed and are omitted from public lists.
    }
  }
  return records
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)));
}

export async function createOrLoadAgentChatSession({
  dir,
  agentId,
  actor,
  idempotencyKey,
  title,
  now = () => new Date().toISOString(),
}: any) {
  const normalizedAgentId = validateId(agentId, 'agent_id');
  const normalizedActor = validateActor(actor);
  const key = validateIdempotencyKey(idempotencyKey);
  const sessionId = sessionIdFor({ actorId: normalizedActor.actor_id, agentId: normalizedAgentId, idempotencyKey: key });
  return withWorkspaceLock({
    dir: join(dir, '.locks'),
    name: lockName(sessionId),
    staleAfterMs: CHAT_LOCK_STALE_MS,
    execute: async () => {
      const existing = await readAgentChatSession({ dir, sessionId });
      if (existing) {
        if (existing.agent_id !== normalizedAgentId || existing.created_by.actor_id !== normalizedActor.actor_id) {
          throw new Error('agent_chat_session_conflict');
        }
        return { created: false, session: existing, idempotent: true };
      }
      const at = now();
      const session = validateAgentChatSession({
        schema: CHAT_SCHEMA,
        session_id: sessionId,
        agent_id: normalizedAgentId,
        title: normalizeTitle(title, normalizedAgentId),
        state: 'open',
        created_by: normalizedActor,
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
    transcript.push({ role: 'user', content: turn.human_message.content });
    if (turn.state === 'completed' && turn.agent_message?.content) {
      transcript.push({ role: 'assistant', content: turn.agent_message.content });
    }
  }
  return transcript.slice(-20);
}

export async function appendAgentChatTurn({
  dir,
  sessionId,
  actor,
  content,
  idempotencyKey,
  invokeProvider,
  now = () => new Date().toISOString(),
}: any) {
  const normalizedSessionId = validateId(sessionId, 'session_id');
  const normalizedActor = validateActor(actor);
  const message = normalizeMessage(content);
  const key = validateIdempotencyKey(idempotencyKey);
  const turnId = turnIdFor(normalizedSessionId, key);
  const contentHash = digest(message);
  return withWorkspaceLock({
    dir: join(dir, '.locks'),
    name: lockName(normalizedSessionId),
    timeoutMs: 15_000,
    staleAfterMs: CHAT_LOCK_STALE_MS,
    execute: async () => {
      let session = await readAgentChatSession({ dir, sessionId: normalizedSessionId });
      if (!session) throw new Error('agent_chat_session_not_found');
      const existing = session.turns.find((turn: any) => turn.turn_id === turnId || turn.idempotency_key === key);
      if (existing) {
        if (existing.content_hash !== contentHash) throw new Error('agent_chat_idempotency_conflict');
        return {
          session,
          turn: existing,
          idempotent: true,
          provider_invoked: false,
        };
      }
      if (session.state !== 'open') throw new Error(`agent_chat_session_not_open:${session.state}`);
      if (session.turns.length >= MAX_TURNS) throw new Error('agent_chat_turn_limit_reached');
      if (typeof invokeProvider !== 'function') throw new Error('agent_chat_provider_unavailable');

      const at = now();
      const pendingTurn = {
        turn_id: turnId,
        idempotency_key: key,
        content_hash: contentHash,
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
      session = validateAgentChatSession({
        ...session,
        updated_at: at,
        turns: [...session.turns, pendingTurn],
      });
      await writeAtomic(sessionPath(dir, normalizedSessionId), session);

      try {
        const response = await invokeProvider({
          agentId: session.agent_id,
          session: serializeAgentChatSession(session),
          transcript: transcriptFor(session),
        });
        const reply = normalizeReply(response?.text);
        const completedAt = now();
        const completedTurn = {
          ...pendingTurn,
          state: 'completed',
          agent_message: {
            role: 'agent',
            content: reply,
            created_at: completedAt,
            provider: bounded(response?.provider || 'opencode', 80),
            model: bounded(response?.model || 'unknown', 120),
          },
          updated_at: completedAt,
        };
        session = validateAgentChatSession({
          ...session,
          updated_at: completedAt,
          last_error: null,
          turns: session.turns.map((turn: any) => turn.turn_id === turnId ? completedTurn : turn),
        });
        await writeAtomic(sessionPath(dir, normalizedSessionId), session);
        return { session, turn: completedTurn, idempotent: false, provider_invoked: true };
      } catch (error: any) {
        const failedAt = now();
        const errorCode = /^[a-z0-9][a-z0-9._:-]{0,119}$/.test(String(error?.message || '').toLowerCase())
          ? String(error.message).toLowerCase()
          : 'agent_chat_provider_failed';
        const failedTurn = {
          ...pendingTurn,
          state: 'needs_human',
          error_code: errorCode,
          updated_at: failedAt,
        };
        session = validateAgentChatSession({
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

export async function closeAgentChatSession({
  dir,
  sessionId,
  actor,
  reason,
  idempotencyKey,
  now = () => new Date().toISOString(),
}: any) {
  const normalizedSessionId = validateId(sessionId, 'session_id');
  const normalizedActor = validateActor(actor);
  const key = validateIdempotencyKey(idempotencyKey);
  const normalizedReason = bounded(reason, 500);
  if (!normalizedReason) throw new Error('agent_chat_close_reason_required');
  return withWorkspaceLock({
    dir: join(dir, '.locks'),
    name: lockName(normalizedSessionId),
    staleAfterMs: CHAT_LOCK_STALE_MS,
    execute: async () => {
      const session = await readAgentChatSession({ dir, sessionId: normalizedSessionId });
      if (!session) throw new Error('agent_chat_session_not_found');
      if (session.state === 'closed') {
        return { session, idempotent: true };
      }
      const at = now();
      const closed = validateAgentChatSession({
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

export async function reconcileInterruptedAgentChatTurns({ dir, now = () => new Date().toISOString() }: any) {
  const sessions = await listAgentChatSessions({ dir, limit: 100 });
  const recovered: string[] = [];
  for (const record of sessions) {
    if (!record.turns.some((turn: any) => turn.state === 'provider_pending')) continue;
    await withWorkspaceLock({
      dir: join(dir, '.locks'),
      name: lockName(record.session_id),
      staleAfterMs: CHAT_LOCK_STALE_MS,
      execute: async () => {
        const current = await readAgentChatSession({ dir, sessionId: record.session_id });
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
            error_code: 'agent_chat_provider_interrupted',
            updated_at: at,
          };
        });
        if (!changed) return;
        await writeAtomic(sessionPath(dir, current.session_id), validateAgentChatSession({
          ...current,
          state: current.state === 'closed' ? 'closed' : 'needs_human',
          last_error: current.state === 'closed' ? current.last_error : 'agent_chat_provider_interrupted',
          updated_at: at,
          turns,
        }));
      },
    });
  }
  return { scanned_sessions: sessions.length, recovered_turns: recovered.length, recovered };
}

export { MAX_MESSAGE, MAX_REPLY, MAX_TURNS };
