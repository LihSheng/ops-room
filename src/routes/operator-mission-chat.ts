import { registerRouteExtension, type RouteEntry } from '../lib/router.js';
import { readMission } from '../services/mission-store.js';
import {
  missionAllowsChatMutation,
  readMissionChatSession,
  readMissionChatSessionForMission,
  serializeMissionChatSession,
} from '../services/mission-chat-store.js';
import {
  AUDIT_DIR,
  MISSIONS_DIR,
  MISSION_CHAT_SESSIONS_DIR,
} from '../services/runtime-paths.js';
import { authorizeOperatorRequest } from '../services/operator-request-auth.js';
import {
  handleAppendMissionChatMessage,
  handleCloseMissionChatSession,
  handleCreateMissionChatSession,
} from '../services/operator-mission-chat.js';
import { parseBody, sendJSON } from './helpers.js';

function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function loadMissionOrNull(missionId: string) {
  try {
    return await readMission({ dir: MISSIONS_DIR, missionId });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function matchMissionParticipantChatRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/missions\/([^/]+)\/participant-chat$/);
  if (!match) return null;
  const missionId = decode(match[1]);
  return missionId ? { missionId } : null;
}

export function matchMissionChatSessionRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/mission-chat-sessions\/([^/]+)$/);
  if (!match) return null;
  const sessionId = decode(match[1]);
  return sessionId ? { sessionId } : null;
}

export function matchMissionChatMessageRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/mission-chat-sessions\/([^/]+)\/messages$/);
  if (!match) return null;
  const sessionId = decode(match[1]);
  return sessionId ? { sessionId } : null;
}

export function matchMissionChatCloseRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/mission-chat-sessions\/([^/]+)\/close$/);
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

const missionParticipantChat: RouteEntry = {
  method: ['GET', 'POST'],
  match: matchMissionParticipantChatRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, res, req.method === 'GET' ? false : undefined);
    if (!authorization) return;
    if (req.method === 'GET') {
      const mission = await loadMissionOrNull(params.missionId);
      if (!mission) {
        sendJSON(res, 404, { error: 'Mission not found', error_code: 'mission_chat_mission_not_found' });
        return;
      }
      const session = await readMissionChatSessionForMission({
        dir: MISSION_CHAT_SESSIONS_DIR,
        missionId: params.missionId,
      });
      sendJSON(res, 200, {
        mission_id: params.missionId,
        mission_state: mission.state,
        can_mutate: missionAllowsChatMutation(mission),
        session: session ? serializeMissionChatSession(session) : null,
      });
      return;
    }
    const result = await handleCreateMissionChatSession({
      missionId: params.missionId,
      body: await parseBody(req),
      actor: authorization.actor,
      missionsDir: MISSIONS_DIR,
      chatDir: MISSION_CHAT_SESSIONS_DIR,
      auditDir: AUDIT_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

const readSession: RouteEntry = {
  method: 'GET',
  match: matchMissionChatSessionRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, res, false);
    if (!authorization) return;
    const session = await readMissionChatSession({ dir: MISSION_CHAT_SESSIONS_DIR, sessionId: params.sessionId });
    if (!session) {
      sendJSON(res, 404, { error: 'Mission chat session not found', error_code: 'mission_chat_session_not_found' });
      return;
    }
    const mission = await loadMissionOrNull(session.mission_id);
    if (!mission) {
      sendJSON(res, 404, { error: 'Mission not found', error_code: 'mission_chat_mission_not_found' });
      return;
    }
    sendJSON(res, 200, {
      mission_id: mission.mission_id,
      mission_state: mission.state,
      can_mutate: missionAllowsChatMutation(mission),
      session: serializeMissionChatSession(session),
    });
  },
};

const appendMessage: RouteEntry = {
  method: 'POST',
  match: matchMissionChatMessageRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, res);
    if (!authorization) return;
    const result = await handleAppendMissionChatMessage({
      sessionId: params.sessionId,
      body: await parseBody(req),
      actor: authorization.actor,
      missionsDir: MISSIONS_DIR,
      chatDir: MISSION_CHAT_SESSIONS_DIR,
      auditDir: AUDIT_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

const closeSession: RouteEntry = {
  method: 'POST',
  match: matchMissionChatCloseRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, res);
    if (!authorization) return;
    const result = await handleCloseMissionChatSession({
      sessionId: params.sessionId,
      body: await parseBody(req),
      actor: authorization.actor,
      missionsDir: MISSIONS_DIR,
      chatDir: MISSION_CHAT_SESSIONS_DIR,
      auditDir: AUDIT_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

registerRouteExtension(missionParticipantChat);
registerRouteExtension(readSession);
registerRouteExtension(appendMessage);
registerRouteExtension(closeSession);
