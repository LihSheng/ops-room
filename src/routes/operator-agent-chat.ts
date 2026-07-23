import { registerRouteExtension, type RouteEntry } from '../lib/router.js';
import { getAgentProfile } from '../services/agent-profile/registry.js';
import {
  listAgentChatSessions,
  readAgentChatSession,
  serializeAgentChatSession,
} from '../services/agent-chat-store.js';
import {
  AUDIT_DIR,
  AGENT_CHAT_SESSIONS_DIR,
} from '../services/runtime-paths.js';
import { authorizeOperatorRequest } from '../services/operator-request-auth.js';
import {
  handleAppendAgentChatMessage,
  handleCloseAgentChatSession,
  handleCreateAgentChatSession,
} from '../services/operator-agent-chat.js';
import { parseBody, sendJSON } from './helpers.js';

function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function serializeAgentChatSessionSummary(record: any) {
  const session = serializeAgentChatSession(record);
  return { ...session, turns: [] };
}

export function matchAgentChatSessionsRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/agents\/([^/]+)\/chat-sessions$/);
  if (!match) return null;
  const agentId = decode(match[1]);
  return agentId ? { agentId } : null;
}

export function matchAgentChatSessionRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/chat-sessions\/([^/]+)$/);
  if (!match) return null;
  const sessionId = decode(match[1]);
  return sessionId ? { sessionId } : null;
}

export function matchAgentChatMessageRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/chat-sessions\/([^/]+)\/messages$/);
  if (!match) return null;
  const sessionId = decode(match[1]);
  return sessionId ? { sessionId } : null;
}

export function matchAgentChatCloseRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/chat-sessions\/([^/]+)\/close$/);
  if (!match) return null;
  const sessionId = decode(match[1]);
  return sessionId ? { sessionId } : null;
}

async function authorize(req: any, res: any, requireCsrf?: boolean) {
  const authorization = await authorizeOperatorRequest({
    req,
    permission: 'agent.chat',
    ...(requireCsrf === undefined ? {} : { requireCsrf }),
  });
  if (!authorization.ok) {
    sendJSON(res, authorization.status, {
      error: authorization.error,
      error_code: authorization.error_code,
    });
    return null;
  }
  return authorization;
}

const listOrCreateSessions: RouteEntry = {
  method: ['GET', 'POST'],
  match: matchAgentChatSessionsRoute,
  handler: async (req, res, params, url) => {
    const authorization = await authorize(req, res, req.method === 'GET' ? false : undefined);
    if (!authorization) return;
    const profile = getAgentProfile(params.agentId);
    if (!profile) {
      sendJSON(res, 404, { error: 'Agent profile not found', error_code: 'agent_chat_profile_missing' });
      return;
    }
    if (!profile.enabled) {
      sendJSON(res, 409, { error: 'Agent profile is disabled', error_code: 'agent_chat_profile_disabled' });
      return;
    }
    if (req.method === 'GET') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 100));
      const sessions = await listAgentChatSessions({
        dir: AGENT_CHAT_SESSIONS_DIR,
        agentId: params.agentId,
        limit,
      });
      sendJSON(res, 200, {
        agent_id: params.agentId,
        sessions: sessions.map(serializeAgentChatSessionSummary),
        count: sessions.length,
      });
      return;
    }
    const result = await handleCreateAgentChatSession({
      agentId: params.agentId,
      body: await parseBody(req),
      actor: authorization.actor,
      chatDir: AGENT_CHAT_SESSIONS_DIR,
      auditDir: AUDIT_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

const readSession: RouteEntry = {
  method: 'GET',
  match: matchAgentChatSessionRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, res, false);
    if (!authorization) return;
    const session = await readAgentChatSession({ dir: AGENT_CHAT_SESSIONS_DIR, sessionId: params.sessionId });
    if (!session) {
      sendJSON(res, 404, { error: 'Chat session not found', error_code: 'agent_chat_session_not_found' });
      return;
    }
    sendJSON(res, 200, { session: serializeAgentChatSession(session) });
  },
};

const appendMessage: RouteEntry = {
  method: 'POST',
  match: matchAgentChatMessageRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, res);
    if (!authorization) return;
    const result = await handleAppendAgentChatMessage({
      sessionId: params.sessionId,
      body: await parseBody(req),
      actor: authorization.actor,
      chatDir: AGENT_CHAT_SESSIONS_DIR,
      auditDir: AUDIT_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

const closeSession: RouteEntry = {
  method: 'POST',
  match: matchAgentChatCloseRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, res);
    if (!authorization) return;
    const result = await handleCloseAgentChatSession({
      sessionId: params.sessionId,
      body: await parseBody(req),
      actor: authorization.actor,
      chatDir: AGENT_CHAT_SESSIONS_DIR,
      auditDir: AUDIT_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

registerRouteExtension(listOrCreateSessions);
registerRouteExtension(readSession);
registerRouteExtension(appendMessage);
registerRouteExtension(closeSession);
