import { createHash } from 'node:crypto';

import { getAgentProfile } from './agent-profile/registry.js';
import { invokeBoundedAgentChat } from './agent-chat-provider.js';
import {
  appendAgentChatTurn,
  closeAgentChatSession,
  createOrLoadAgentChatSession,
  serializeAgentChatSession,
} from './agent-chat-store.js';
import { appendAuditEvent } from './audit-log.js';
import { validateIdempotencyKey } from './idempotency-store.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9._:-]{0,119}$/;

function bounded(value: unknown, maximum: number) {
  return String(value ?? '').trim().slice(0, maximum);
}

function validateId(value: unknown, field: string) {
  const normalized = bounded(value, 200);
  if (!SAFE_ID.test(normalized)) throw new Error(`agent_chat_${field}_invalid`);
  return normalized;
}

function reasonFrom(body: any) {
  const reason = bounded(body?.reason, 500);
  if (!reason) throw new Error('agent_chat_reason_required');
  return reason;
}

function messageFrom(body: any) {
  const content = bounded(body?.content, 4_000);
  if (!content) throw new Error('agent_chat_message_required');
  return content;
}

function idempotencyFrom(body: any) {
  return validateIdempotencyKey(body?.idempotency_key);
}

function profileExists(agentId: string, profileLookup = getAgentProfile) {
  const profile = profileLookup(agentId);
  if (!profile || profile.id !== agentId) throw new Error('agent_chat_profile_missing');
  if (!profile.enabled) throw new Error('agent_chat_profile_disabled');
  return profile;
}

function boundedFailure(error: any) {
  const raw = String(error?.message || 'agent_chat_action_failed').trim().toLowerCase();
  const code = SAFE_ERROR_CODE.test(raw) ? raw : 'agent_chat_action_failed';
  if (code === 'agent_chat_session_not_found' || code === 'agent_chat_profile_missing') {
    return { status: 404, code, message: code === 'agent_chat_profile_missing' ? 'Agent profile not found' : 'Chat session not found' };
  }
  if (code.includes('invalid') || code.includes('required')) {
    return { status: 400, code, message: code.replaceAll('_', ' ') };
  }
  if (code === 'agent_chat_provider_unconfigured' || code === 'agent_chat_provider_unavailable') {
    return { status: 503, code, message: 'Agent chat provider is unavailable' };
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

export async function handleCreateAgentChatSession({
  agentId,
  body,
  actor,
  chatDir,
  auditDir,
  profileLookup = getAgentProfile,
}: any) {
  let reason = '';
  let key = '';
  try {
    const normalizedAgentId = validateId(agentId, 'agent_id');
    profileExists(normalizedAgentId, profileLookup);
    reason = reasonFrom(body);
    key = idempotencyFrom(body);
    const result = await createOrLoadAgentChatSession({
      dir: chatDir,
      agentId: normalizedAgentId,
      actor,
      idempotencyKey: key,
      title: body?.title,
    });
    const event = await accepted({
      auditDir,
      actor,
      operation: 'agent.chat.session.create',
      targetType: 'agent_chat_session',
      targetId: result.session.session_id,
      reason,
      idempotencyKey: key,
      previousState: null,
      resultingState: result.session.state,
      metadata: {
        agent_id: normalizedAgentId,
        domain_idempotent: result.idempotent,
        provider_invoked: false,
      },
    });
    return {
      status: result.created ? 201 : 200,
      body: {
        session: serializeAgentChatSession(result.session),
        domain_idempotent: result.idempotent,
        provider_invoked: false,
        audit_event_id: event.event_id,
      },
    };
  } catch (error: any) {
    return rejected({
      auditDir,
      actor,
      operation: 'agent.chat.session.create',
      targetType: 'agent',
      targetId: agentId,
      reason,
      idempotencyKey: key,
      error,
      metadata: { agent_id: bounded(agentId, 200), provider_invoked: false },
    });
  }
}

export async function handleAppendAgentChatMessage({
  sessionId,
  body,
  actor,
  chatDir,
  auditDir,
  invokeProvider = invokeBoundedAgentChat,
}: any) {
  let key = '';
  let content = '';
  try {
    const normalizedSessionId = validateId(sessionId, 'session_id');
    content = messageFrom(body);
    key = idempotencyFrom(body);
    const result = await appendAgentChatTurn({
      dir: chatDir,
      sessionId: normalizedSessionId,
      actor,
      content,
      idempotencyKey: key,
      invokeProvider,
    });
    const publicSession = serializeAgentChatSession(result.session);
    const publicTurn = publicSession.turns.find((turn: any) => turn.turn_id === result.turn.turn_id);
    const event = await accepted({
      auditDir,
      actor,
      operation: 'agent.chat.message.send',
      targetType: 'agent_chat_turn',
      targetId: result.turn.turn_id,
      reason: 'direct_agent_chat_message',
      idempotencyKey: key,
      previousState: null,
      resultingState: result.turn.state,
      metadata: {
        session_id: normalizedSessionId,
        agent_id: result.session.agent_id,
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
      operation: 'agent.chat.message.send',
      targetType: 'agent_chat_session',
      targetId: sessionId,
      reason: 'direct_agent_chat_message',
      idempotencyKey: key,
      error,
      metadata: {
        session_id: bounded(sessionId, 200),
        message_digest: content ? createHash('sha256').update(content).digest('hex') : null,
        message_length: content.length,
        provider_invoked: false,
      },
    });
  }
}

export async function handleCloseAgentChatSession({
  sessionId,
  body,
  actor,
  chatDir,
  auditDir,
}: any) {
  let reason = '';
  let key = '';
  try {
    const normalizedSessionId = validateId(sessionId, 'session_id');
    reason = reasonFrom(body);
    key = idempotencyFrom(body);
    const result = await closeAgentChatSession({
      dir: chatDir,
      sessionId: normalizedSessionId,
      actor,
      reason,
      idempotencyKey: key,
    });
    const event = await accepted({
      auditDir,
      actor,
      operation: 'agent.chat.session.close',
      targetType: 'agent_chat_session',
      targetId: normalizedSessionId,
      reason,
      idempotencyKey: key,
      previousState: result.idempotent ? 'closed' : 'open',
      resultingState: 'closed',
      metadata: {
        agent_id: result.session.agent_id,
        domain_idempotent: result.idempotent,
        provider_invoked: false,
      },
    });
    return {
      status: 200,
      body: {
        session: serializeAgentChatSession(result.session),
        domain_idempotent: result.idempotent,
        provider_invoked: false,
        audit_event_id: event.event_id,
      },
    };
  } catch (error: any) {
    return rejected({
      auditDir,
      actor,
      operation: 'agent.chat.session.close',
      targetType: 'agent_chat_session',
      targetId: sessionId,
      reason,
      idempotencyKey: key,
      error,
      metadata: { session_id: bounded(sessionId, 200), provider_invoked: false },
    });
  }
}
