import { verifyDashboardAuth, requestPath } from '../routes/helpers.js';
import { appendAuditEvent } from './audit-log.js';
import { hasOperatorPermission } from './operator-rbac.js';
import {
  extractOperatorSessionToken,
  readOperatorSession,
} from './operator-session-store.js';
import {
  AUDIT_DIR,
  HUMAN_AUTH_ENABLED,
  OPERATOR_SESSION_DIR,
} from './runtime-paths.js';

export type DashboardReadAuthorizationResult =
  | {
    ok: true;
    auth_method: 'dashboard_token' | 'operator_session';
    actor: Readonly<Record<string, any>> | null;
    session: any | null;
  }
  | {
    ok: false;
    status: number;
    error: string;
    error_code: string;
  };

function actorFromSession(session: any) {
  return Object.freeze({
    ...session.actor,
    session_id: session.session_id,
  });
}

export async function authorizeDashboardReadRequest({
  req,
  humanAuthEnabled = HUMAN_AUTH_ENABLED,
  sessionDir = OPERATOR_SESSION_DIR,
  auditDir = AUDIT_DIR,
  verifyDashboardBearer = verifyDashboardAuth,
  readSession = readOperatorSession,
  appendAudit = appendAuditEvent,
  now,
}: {
  req: any;
  humanAuthEnabled?: boolean;
  sessionDir?: string;
  auditDir?: string;
  verifyDashboardBearer?: (authorization: unknown) => boolean;
  readSession?: typeof readOperatorSession;
  appendAudit?: typeof appendAuditEvent;
  now?: () => string | Date;
}): Promise<DashboardReadAuthorizationResult> {
  if (verifyDashboardBearer(req?.headers?.authorization)) {
    return {
      ok: true,
      auth_method: 'dashboard_token',
      actor: null,
      session: null,
    };
  }

  if (!humanAuthEnabled) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized',
      error_code: 'dashboard_auth_required',
    };
  }

  const token = extractOperatorSessionToken(req?.headers?.cookie);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized',
      error_code: 'operator_session_required',
    };
  }

  let session;
  try {
    session = await readSession({ dir: sessionDir, token, now });
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'Operator session unavailable',
      error_code: 'operator_session_unavailable',
    };
  }

  if (!session) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized',
      error_code: 'operator_session_invalid',
    };
  }

  const actor = actorFromSession(session);
  if (!hasOperatorPermission(session.roles, 'dashboard.read')) {
    try {
      await appendAudit({
        dir: auditDir,
        operation: 'operator.authorization.denied',
        actor,
        target: { type: 'operator_permission', id: 'dashboard.read' },
        reason: 'operator_permission_denied',
        previousState: 'authenticated',
        resultingState: 'denied',
        outcome: 'rejected',
        errorCode: 'operator_permission_denied',
        metadata: {
          method: 'GET',
          path: requestPath(req).slice(0, 300),
        },
      });
    } catch {
      return {
        ok: false,
        status: 503,
        error: 'Operator audit unavailable',
        error_code: 'operator_audit_unavailable',
      };
    }

    return {
      ok: false,
      status: 403,
      error: 'Forbidden',
      error_code: 'operator_permission_denied',
    };
  }

  return {
    ok: true,
    auth_method: 'operator_session',
    actor,
    session,
  };
}
