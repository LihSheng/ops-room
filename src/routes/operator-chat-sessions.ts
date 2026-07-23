import { registerRouteExtension, type RouteEntry } from '../lib/router.js';
import { buildChatSessionIndex } from '../services/chat-session-index.js';
import {
  AGENT_CHAT_SESSIONS_DIR,
  MISSION_CHAT_SESSIONS_DIR,
} from '../services/runtime-paths.js';
import { authorizeOperatorRequest } from '../services/operator-request-auth.js';
import { sendJSON } from './helpers.js';

const SESSION_TYPES = new Set(['all', 'direct', 'mission']);
const SESSION_STATES = new Set(['all', 'open', 'needs_human', 'closed']);

export function matchChatSessionIndexRoute(pathname: string) {
  return pathname === '/api/operator/chat-sessions' ? {} : null;
}

function optionalBounded(value: string | null, maximum = 200) {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || normalized.includes('\u0000')) throw new Error('chat_session_index_filter_invalid');
  return normalized;
}

function parseFilters(url: URL) {
  const type = String(url.searchParams.get('type') || 'all').trim().toLowerCase();
  const state = String(url.searchParams.get('state') || 'all').trim().toLowerCase();
  if (!SESSION_TYPES.has(type)) throw new Error('chat_session_index_type_invalid');
  if (!SESSION_STATES.has(state)) throw new Error('chat_session_index_state_invalid');
  const attention = String(url.searchParams.get('attention') || '').trim().toLowerCase();
  if (attention && !['true', 'false', '1', '0'].includes(attention)) {
    throw new Error('chat_session_index_attention_invalid');
  }
  return {
    sessionType: type as 'all' | 'direct' | 'mission',
    state: state as 'all' | 'open' | 'needs_human' | 'closed',
    attentionOnly: attention === 'true' || attention === '1',
    agentId: optionalBounded(url.searchParams.get('agent_id')),
    missionId: optionalBounded(url.searchParams.get('mission_id')),
    limit: Number(url.searchParams.get('limit') || 100),
  };
}

const chatSessionIndex: RouteEntry = {
  method: 'GET',
  match: matchChatSessionIndexRoute,
  handler: async (req, res, _params, url) => {
    const authorization = await authorizeOperatorRequest({
      req,
      permission: 'agent.chat',
      requireCsrf: false,
    });
    if (!authorization.ok) {
      sendJSON(res, authorization.status, {
        error: authorization.error,
        error_code: authorization.error_code,
      });
      return;
    }
    try {
      const result = await buildChatSessionIndex({
        directDir: AGENT_CHAT_SESSIONS_DIR,
        missionDir: MISSION_CHAT_SESSIONS_DIR,
        filters: parseFilters(url),
      });
      sendJSON(res, 200, result);
    } catch (error: any) {
      const errorCode = String(error?.message || 'chat_session_index_invalid');
      sendJSON(res, 400, {
        error: errorCode.replaceAll('_', ' '),
        error_code: errorCode,
      });
    }
  },
};

registerRouteExtension(chatSessionIndex);
