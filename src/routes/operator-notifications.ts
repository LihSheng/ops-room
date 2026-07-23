import { registerRouteExtension, type RouteEntry } from '../lib/router.js';
import {
  buildOperatorNotificationInbox,
  findOperatorNotification,
  handleAcknowledgeNotification,
  handleMarkNotificationRead,
} from '../services/operator-notifications.js';
import { authorizeOperatorRequest } from '../services/operator-request-auth.js';
import {
  AUDIT_DIR,
  IDEMPOTENCY_DIR,
  MISSIONS_DIR,
  OPERATOR_NOTIFICATION_STATE_DIR,
  WORKFLOW_EFFECTS_DIR,
  WORKFLOW_RUNS_DIR,
  WORKSPACE_RECORDS_DIR,
} from '../services/runtime-paths.js';
import { parseBody, sendJSON } from './helpers.js';

export function matchNotificationListRoute(pathname: string) {
  return pathname === '/api/operator/notifications' ? {} : null;
}

export function matchNotificationDetailRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/notifications\/([^/]+)$/);
  return match ? { notificationId: match[1] } : null;
}

export function matchNotificationActionRoute(pathname: string) {
  const match = pathname.match(/^\/api\/operator\/notifications\/([^/]+)\/(read|acknowledge)$/);
  return match ? { notificationId: match[1], action: match[2] } : null;
}

function decodeNotificationId(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('notification_id_invalid');
  }
}

function notificationDeps() {
  return {
    notificationStateDir: OPERATOR_NOTIFICATION_STATE_DIR,
    missionsDir: MISSIONS_DIR,
    workflowRunsDir: WORKFLOW_RUNS_DIR,
    workflowEffectsDir: WORKFLOW_EFFECTS_DIR,
    workspaceRecordsDir: WORKSPACE_RECORDS_DIR,
  };
}

async function authorize(req: any, requireCsrf: boolean) {
  return authorizeOperatorRequest({
    req,
    permission: 'dashboard.read',
    requireCsrf,
    requireStepUp: false,
  });
}

function sendAuthorizationFailure(res: any, authorization: any) {
  sendJSON(res, authorization.status, {
    error: authorization.error,
    error_code: authorization.error_code,
  });
}

function readFailure(error: any) {
  const code = String(error?.message || 'notification_inbox_unavailable').trim().toLowerCase();
  if (code.includes('filter_invalid') || code === 'notification_id_invalid') {
    return { status: 400, code, message: code.replaceAll('_', ' ') };
  }
  return { status: 503, code: 'notification_inbox_unavailable', message: 'Notification inbox is unavailable' };
}

const notificationListRoute: RouteEntry = {
  method: 'GET',
  match: matchNotificationListRoute,
  handler: async (req, res, _params, url) => {
    const authorization = await authorize(req, false);
    if (!authorization.ok) {
      sendAuthorizationFailure(res, authorization);
      return;
    }
    try {
      const result = await buildOperatorNotificationInbox({
        actor: authorization.actor,
        ...notificationDeps(),
        filters: {
          state: url.searchParams.get('state') || 'all',
          notificationType: url.searchParams.get('type'),
          missionId: url.searchParams.get('mission_id'),
          limit: Number(url.searchParams.get('limit') || 100),
        },
      });
      sendJSON(res, 200, result);
    } catch (error: any) {
      const failure = readFailure(error);
      sendJSON(res, failure.status, { error: failure.message, error_code: failure.code });
    }
  },
};

const notificationDetailRoute: RouteEntry = {
  method: 'GET',
  match: matchNotificationDetailRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, false);
    if (!authorization.ok) {
      sendAuthorizationFailure(res, authorization);
      return;
    }
    try {
      const notification = await findOperatorNotification({
        notificationId: decodeNotificationId(params.notificationId),
        actor: authorization.actor,
        ...notificationDeps(),
      });
      if (!notification) {
        sendJSON(res, 404, { error: 'Notification not found', error_code: 'notification_not_found' });
        return;
      }
      sendJSON(res, 200, { notification });
    } catch (error: any) {
      const failure = readFailure(error);
      sendJSON(res, failure.status, { error: failure.message, error_code: failure.code });
    }
  },
};

const notificationActionRoute: RouteEntry = {
  method: 'POST',
  match: matchNotificationActionRoute,
  handler: async (req, res, params) => {
    const authorization = await authorize(req, true);
    if (!authorization.ok) {
      sendAuthorizationFailure(res, authorization);
      return;
    }
    let notificationId: string;
    try {
      notificationId = decodeNotificationId(params.notificationId);
    } catch {
      sendJSON(res, 400, { error: 'notification id invalid', error_code: 'notification_id_invalid' });
      return;
    }
    const body = await parseBody(req);
    const handler = params.action === 'acknowledge'
      ? handleAcknowledgeNotification
      : handleMarkNotificationRead;
    const result = await handler({
      notificationId,
      body,
      actor: authorization.actor,
      ...notificationDeps(),
      idempotencyDir: IDEMPOTENCY_DIR,
      auditDir: AUDIT_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

registerRouteExtension(notificationListRoute);
registerRouteExtension(notificationDetailRoute);
registerRouteExtension(notificationActionRoute);
