import { createHash } from 'node:crypto';

import { getAgentProfile } from './agent-profile/registry.js';
import { appendAuditEvent } from './audit-log.js';
import { validateIdempotencyKey } from './idempotency-store.js';
import { readMission } from './mission-store.js';
import { invokeBoundedMissionParticipantChat } from './mission-chat-provider.js';
import {
  appendMissionChatTurn,
  closeMissionChatSession,
  createOrLoadMissionChatSession,
  readMissionChatSession,
  serializeMissionChatSession,
} from './mission-chat-store.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9._:-]{0,119}$/;

function bounded(value: unknown, maximum: number) {
  return String(value ?? '').trim().slice(0, maximum);
}

function validateId(value: unknown, field: string) {
  const normalized = bounded(value, 200);
  if (!SAFE_ID.test(normalized)) throw new Error(`mission_chat_${field}_invalid`);
  return normalized;
}

function reasonFrom(body: any) {
  const reason = bounded(body?.reason, 500);
  if (!reason) throw new Error('mission_chat_reason_required');
  return reason;
}

function messageFrom(body: any) {
  const content = bounded(body?.content, 4_000);
  if (!content) throw new Error('mission_chat_message_required');
  return content;
}

function idempotencyFrom(body: any) {
  return validateIdempotencyKey(body?.idempotency_key);
}

async function loadMission(missionsDir: string, missionId: string) {
  try {
    return await readMission({ dir: missionsDir, missionId });
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error('mission_chat_mission_not_found');
    throw error;
  }
}

function participantForMission(mission: any, agentId: unknown) {
  const normalizedAgentId = validateId(agentId, 'target_agent_id');
  const participant = Array.isArray(mission?.participants)
    ? mission.participants.find((candidate: any) => candidate?.agent_id === normalizedAgentId)
    : null;
  if (!participant) throw new Error('mission_chat_target_not_participant');
  return participant;
}

function participantProfileEnabled(agentId: string, profileLookup = getAgentProfile) {
  const profile = profileLookup(agentId);
  if (!profile || profile.id !== agentId) throw new Error('mission_chat_profile_missing');
  if (!profile.enabled) throw new Error('mission_chat_profile_disabled');
  return profile;
}

function boundedFailure(error: any) {
  const raw = String(error?.message || 'mission_chat_action_failed').trim().toLowerCase();
  const code = SAFE_ERROR_CODE.test(raw) ? raw : 'mission_chat_action_failed';
  if (code === 'mission_chat_session_not_found' || code === 'mission_chat_mission_not_found' || code === 'mission_chat_profile_missing') {
    const message = code === 'mission_chat_session_not_found'
      ? 'Mission chat session not found'
      : code === 'mission_chat_mission_not_found'
        ? 'Mission not found'
        : 'Participant profile not found';
    return { status: 404, code, message };
  }
  if (code.includes('invalid') || code.includes('required')) {
    return { status: 400, code, message: code.replaceAll('_', ' ') };
  }
  if (code === 'mission_chat_provider_unconfigured' || code === 'mission_chat_provider_unavailable') {
    return { status: 503, code, message: 'Mission chat provider is unavailable' };
  }
  if (code === 'mission_chat_profile_disabled') {
    return { status: 409, code, message: 'The selected Mission participant is disabled' };
  }
  if (code.startsWith('mission_chat_mission_terminal:')) {
    return { status: 409, code, message: 'This terminal Mission is read only' };
  }
  return { status: 409, code, message: code.replaceAll('_', ' ') };
}

async function rejected({
  auditDir,
  actor,
  operation,
  targetType,
  targetId,
  reason,
  idempotencyKey,
  error,
  metadata = {},
}: any) {
  const failure = boundedFailure(error);
  const event = await appendAuditEvent({
    dir: auditDir,
    operation,
    actor,
    target: { type: targetType, id: bounded(targetId, 300) },
    reason: reason || failure.code,
    idempotencyKey: idempotencyKey || null,
    previousState: null,
    resultingState: null,
    outcome: 'rejected',
    errorCode: failure.code,
    metadata,
  });
  return {
    status: failure.status,
    body: {
      error: failure.message,
      error_code: failure.code,
      audit_event_id: event.event_id,
    },
  };
}

async function accepted({
  auditDir,
  actor,
  operation,
  targetType,
  targetId,
  reason,
  idempotencyKey,
  previousState,
  resultingState,
  metadata,
}: any) {
  return appendAuditEvent({
    dir: auditDir,
    operation,
    actor,
    target: { type: targetType, id: bounded(targetId, 300) },
    reason,
    idempotencyKey,
    previousState,
    resultingState,
    outcome: 'accepted',
    metadata,
  });
}

export async function handleCreateMissionChatSession({
  missionId,
  body,
  actor,
  missionsDir,
  chatDir,
  auditDir,
}: any) {
  let reason = '';
  let key = '';
  try {
    const normalizedMissionId = validateId(missionId, 'mission_id');
    reason = reasonFrom(body);
    key = idempotencyFrom(body);
    const mission = await loadMission(missionsDir, normalizedMissionId);
    const result = await createOrLoadMissionChatSession({
      dir: chatDir,
      mission,
      actor,
      idempotencyKey: key,
    });
    const event = await accepted({
      auditDir,
      actor,
      operation: 'mission.chat.session.create',
      targetType: 'mission_chat_session',
      targetId: result.session.session_id,
      reason,
      idempotencyKey: key,
      previousState: null,
      resultingState: result.session.state,
      metadata: {
        mission_id: normalizedMissionId,
        participant_ids: result.session.participants.map((participant: any) => participant.agent_id),
        domain_idempotent: result.idempotent,
        provider_invoked: false,
      },
    });
    return {
      status: result.created ? 201 : 200,
      body: {
        session: serializeMissionChatSession(result.session),
        domain_idempotent: result.idempotent,
        provider_invoked: false,
        audit_event_id: event.event_id,
      },
    };
  } catch (error: any) {
    return rejected({
      auditDir,
      actor,
      operation: 'mission.chat.session.create',
      targetType: 'mission',
      targetId: missionId,
      reason,
      idempotencyKey: key,
      error,
      metadata: { mission_id: bounded(missionId, 200), provider_invoked: false },
    });
  }
}

export async function handleAppendMissionChatMessage({
  sessionId,
  body,
  actor,
  missionsDir,
  chatDir,
  auditDir,
  profileLookup = getAgentProfile,
  invokeProvider = invokeBoundedMissionParticipantChat,
}: any) {
  let key = '';
  let content = '';
  let targetAgentId = '';
  try {
    const normalizedSessionId = validateId(sessionId, 'session_id');
    content = messageFrom(body);
    targetAgentId = validateId(body?.target_agent_id, 'target_agent_id');
    key = idempotencyFrom(body);
    const existing = await readMissionChatSession({ dir: chatDir, sessionId: normalizedSessionId });
    if (!existing) throw new Error('mission_chat_session_not_found');
    const mission = await loadMission(missionsDir, existing.mission_id);
    participantForMission(mission, targetAgentId);
    participantProfileEnabled(targetAgentId, profileLookup);
    const result = await appendMissionChatTurn({
      dir: chatDir,
      mission,
      sessionId: normalizedSessionId,
      targetAgentId,
      actor,
      content,
      idempotencyKey: key,
      invokeProvider: (input: any) => invokeProvider({ ...input, profileLookup }),
    });
    const publicSession = serializeMissionChatSession(result.session);
    const publicTurn = publicSession.turns.find((turn: any) => turn.turn_id === result.turn.turn_id);
    const event = await accepted({
      auditDir,
      actor,
      operation: 'mission.chat.message.send',
      targetType: 'mission_chat_turn',
      targetId: result.turn.turn_id,
      reason: 'mission_participant_chat_message',
      idempotencyKey: key,
      previousState: null,
      resultingState: result.turn.state,
      metadata: {
        mission_id: result.session.mission_id,
        session_id: normalizedSessionId,
        target_agent_id: targetAgentId,
        message_digest: createHash('sha256').update(content).digest('hex'),
        message_length: content.length,
        provider_invoked: result.provider_invoked,
        domain_idempotent: result.idempotent,
        error_code: result.turn.error_code || null,
      },
    });
    return {
      status: 202,
      body: {
        session: publicSession,
        turn: publicTurn,
        domain_idempotent: result.idempotent,
        provider_invoked: result.provider_invoked,
        audit_event_id: event.event_id,
      },
    };
  } catch (error: any) {
    return rejected({
      auditDir,
      actor,
      operation: 'mission.chat.message.send',
      targetType: 'mission_chat_session',
      targetId: sessionId,
      reason: 'mission_participant_chat_message',
      idempotencyKey: key,
      error,
      metadata: {
        session_id: bounded(sessionId, 200),
        target_agent_id: bounded(targetAgentId, 200) || null,
        message_digest: content ? createHash('sha256').update(content).digest('hex') : null,
        message_length: content.length,
        provider_invoked: false,
      },
    });
  }
}

export async function handleCloseMissionChatSession({
  sessionId,
  body,
  actor,
  missionsDir,
  chatDir,
  auditDir,
}: any) {
  let reason = '';
  let key = '';
  try {
    const normalizedSessionId = validateId(sessionId, 'session_id');
    reason = reasonFrom(body);
    key = idempotencyFrom(body);
    const existing = await readMissionChatSession({ dir: chatDir, sessionId: normalizedSessionId });
    if (!existing) throw new Error('mission_chat_session_not_found');
    const mission = await loadMission(missionsDir, existing.mission_id);
    const result = await closeMissionChatSession({
      dir: chatDir,
      mission,
      sessionId: normalizedSessionId,
      actor,
      reason,
      idempotencyKey: key,
    });
    const event = await accepted({
      auditDir,
      actor,
      operation: 'mission.chat.session.close',
      targetType: 'mission_chat_session',
      targetId: normalizedSessionId,
      reason,
      idempotencyKey: key,
      previousState: result.idempotent ? 'closed' : existing.state,
      resultingState: 'closed',
      metadata: {
        mission_id: existing.mission_id,
        domain_idempotent: result.idempotent,
        provider_invoked: false,
      },
    });
    return {
      status: 200,
      body: {
        session: serializeMissionChatSession(result.session),
        domain_idempotent: result.idempotent,
        provider_invoked: false,
        audit_event_id: event.event_id,
      },
    };
  } catch (error: any) {
    return rejected({
      auditDir,
      actor,
      operation: 'mission.chat.session.close',
      targetType: 'mission_chat_session',
      targetId: sessionId,
      reason,
      idempotencyKey: key,
      error,
      metadata: { session_id: bounded(sessionId, 200), provider_invoked: false },
    });
  }
}
