import { verifyOperatorBootstrapAuth } from './helpers.js';
import { appendAuditEvent } from '../services/audit-log.js';
import { resolveOperatorIdentity } from '../services/operator-identity.js';
import {
  clearOperatorSessionCookie,
  createOperatorSession,
  extractOperatorSessionToken,
  readOperatorSession,
  revokeOperatorSession,
  serializeOperatorSessionCookie,
} from '../services/operator-session-store.js';
import {
  deriveOperatorCsrfToken,
  verifyOperatorCsrfToken,
} from '../services/operator-request-auth.js';
import {
  AUDIT_DIR,
  HUMAN_AUTH_ENABLED,
  OPERATOR_CONFIGURED_ROLES,
  OPERATOR_SESSION_COOKIE_SECURE,
  OPERATOR_SESSION_DIR,
  OPERATOR_SESSION_TTL_SECONDS,
} from '../services/runtime-paths.js';

export type OperatorSessionRouteResult = {
  status: number;
  body: Record<string, any>;
  headers?: Record<string, string>;
};

function hidden(): OperatorSessionRouteResult {
  return { status: 404, body: { error: 'Not found' } };
}

function unauthorized(headers?: Record<string, string>): OperatorSessionRouteResult {
  return { status: 401, body: { error: 'Unauthorized' }, headers };
}

function unavailable(headers?: Record<string, string>): OperatorSessionRouteResult {
  return {
    status: 503,
    body: {
      error: 'Operator session unavailable',
      error_code: 'operator_session_unavailable',
    },
    headers,
  };
}

function actorFromSession(session: any) {
  return Object.freeze({
    ...session.actor,
    session_id: session.session_id,
  });
}

export async function handleCreateOperatorSession({
  authorization,
  enabled = HUMAN_AUTH_ENABLED,
  sessionDir = OPERATOR_SESSION_DIR,
  auditDir = AUDIT_DIR,
  roles = OPERATOR_CONFIGURED_ROLES,
  ttlSeconds = OPERATOR_SESSION_TTL_SECONDS,
  secureCookie = OPERATOR_SESSION_COOKIE_SECURE,
  verifyBootstrapAuth = verifyOperatorBootstrapAuth,
  resolveActor = resolveOperatorIdentity,
  createSession = createOperatorSession,
  revokeSession = revokeOperatorSession,
  appendAudit = appendAuditEvent,
  now,
}: {
  authorization: unknown;
  enabled?: boolean;
  sessionDir?: string;
  auditDir?: string;
  roles?: unknown;
  ttlSeconds?: number;
  secureCookie?: boolean;
  verifyBootstrapAuth?: (authorization: unknown) => boolean;
  resolveActor?: () => Readonly<Record<string, any>>;
  createSession?: typeof createOperatorSession;
  revokeSession?: typeof revokeOperatorSession;
  appendAudit?: typeof appendAuditEvent;
  now?: () => string | Date;
}): Promise<OperatorSessionRouteResult> {
  if (!enabled) return hidden();
  if (!verifyBootstrapAuth(authorization)) return unauthorized();

  let created: any = null;
  try {
    const actor = resolveActor();
    created = await createSession({
      dir: sessionDir,
      actor,
      roles,
      ttlSeconds,
      now,
    });
    await appendAudit({
      dir: auditDir,
      operation: 'operator.session.create',
      actor,
      target: { type: 'operator_session', id: created.session.session_id },
      reason: 'bootstrap_operator_session',
      previousState: null,
      resultingState: 'active',
      outcome: 'accepted',
      metadata: {
        roles: created.session.roles,
        expires_at: created.session.expires_at,
      },
    });
    return {
      status: 201,
      headers: {
        'Set-Cookie': serializeOperatorSessionCookie({
          token: created.token,
          ttlSeconds: created.ttl_seconds,
          secure: secureCookie,
        }),
      },
      body: {
        session: created.session,
        csrf_token: deriveOperatorCsrfToken(created.token),
      },
    };
  } catch {
    if (created?.token) {
      await revokeSession({ dir: sessionDir, token: created.token, now }).catch(() => null);
    }
    return unavailable();
  }
}

export async function handleReadOperatorSession({
  cookieHeader,
  enabled = HUMAN_AUTH_ENABLED,
  sessionDir = OPERATOR_SESSION_DIR,
  readSession = readOperatorSession,
  now,
}: {
  cookieHeader: unknown;
  enabled?: boolean;
  sessionDir?: string;
  readSession?: typeof readOperatorSession;
  now?: () => string | Date;
}): Promise<OperatorSessionRouteResult> {
  if (!enabled) return hidden();

  const token = extractOperatorSessionToken(cookieHeader);
  if (!token) return unauthorized();

  try {
    const session = await readSession({ dir: sessionDir, token, now });
    if (!session) return unauthorized();

    return {
      status: 200,
      body: {
        session,
        csrf_token: deriveOperatorCsrfToken(token),
      },
    };
  } catch {
    return unavailable();
  }
}

export async function handleRevokeOperatorSession({
  cookieHeader,
  csrfHeader,
  enabled = HUMAN_AUTH_ENABLED,
  sessionDir = OPERATOR_SESSION_DIR,
  auditDir = AUDIT_DIR,
  secureCookie = OPERATOR_SESSION_COOKIE_SECURE,
  readSession = readOperatorSession,
  revokeSession = revokeOperatorSession,
  appendAudit = appendAuditEvent,
  now,
}: {
  cookieHeader: unknown;
  csrfHeader: unknown;
  enabled?: boolean;
  sessionDir?: string;
  auditDir?: string;
  secureCookie?: boolean;
  readSession?: typeof readOperatorSession;
  revokeSession?: typeof revokeOperatorSession;
  appendAudit?: typeof appendAuditEvent;
  now?: () => string | Date;
}): Promise<OperatorSessionRouteResult> {
  if (!enabled) return hidden();

  const clearHeader = {
    'Set-Cookie': clearOperatorSessionCookie({ secure: secureCookie }),
  };
  const token = extractOperatorSessionToken(cookieHeader);
  if (!token) return unauthorized(clearHeader);

  try {
    const session = await readSession({ dir: sessionDir, token, now });
    if (!session) return unauthorized(clearHeader);
    const actor = actorFromSession(session);

    if (!verifyOperatorCsrfToken({ sessionToken: token, csrfToken: csrfHeader })) {
      await appendAudit({
        dir: auditDir,
        operation: 'operator.authorization.denied',
        actor,
        target: { type: 'operator_session', id: session.session_id },
        reason: 'operator_csrf_invalid',
        previousState: 'authenticated',
        resultingState: 'denied',
        outcome: 'rejected',
        errorCode: 'operator_csrf_invalid',
        metadata: { method: 'DELETE', path: '/api/auth/session' },
      });
      return {
        status: 403,
        body: { error: 'Forbidden', error_code: 'operator_csrf_invalid' },
      };
    }

    const revoked = await revokeSession({ dir: sessionDir, token, now });
    if (!revoked) return unauthorized(clearHeader);
    await appendAudit({
      dir: auditDir,
      operation: 'operator.session.revoke',
      actor,
      target: { type: 'operator_session', id: session.session_id },
      reason: 'operator_logout',
      previousState: 'active',
      resultingState: 'revoked',
      outcome: 'accepted',
    });
    return {
      status: 200,
      headers: clearHeader,
      body: { ok: true, session_id: session.session_id },
    };
  } catch {
    return unavailable(clearHeader);
  }
}
