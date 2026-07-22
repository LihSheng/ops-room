import { verifyOperatorBootstrapAuth } from './helpers.js';
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

export async function handleCreateOperatorSession({
  authorization,
  enabled = HUMAN_AUTH_ENABLED,
  sessionDir = OPERATOR_SESSION_DIR,
  roles = OPERATOR_CONFIGURED_ROLES,
  ttlSeconds = OPERATOR_SESSION_TTL_SECONDS,
  secureCookie = OPERATOR_SESSION_COOKIE_SECURE,
  verifyBootstrapAuth = verifyOperatorBootstrapAuth,
  resolveActor = resolveOperatorIdentity,
  createSession = createOperatorSession,
  now,
}: {
  authorization: unknown;
  enabled?: boolean;
  sessionDir?: string;
  roles?: unknown;
  ttlSeconds?: number;
  secureCookie?: boolean;
  verifyBootstrapAuth?: (authorization: unknown) => boolean;
  resolveActor?: () => Readonly<Record<string, any>>;
  createSession?: typeof createOperatorSession;
  now?: () => string | Date;
}): Promise<OperatorSessionRouteResult> {
  if (!enabled) return hidden();
  if (!verifyBootstrapAuth(authorization)) return unauthorized();

  try {
    const created = await createSession({
      dir: sessionDir,
      actor: resolveActor(),
      roles,
      ttlSeconds,
      now,
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
    return {
      status: 503,
      body: {
        error: 'Operator session unavailable',
        error_code: 'operator_session_unavailable',
      },
    };
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
  const session = await readSession({ dir: sessionDir, token, now });
  if (!session) return unauthorized();

  return {
    status: 200,
    body: {
      session,
      csrf_token: deriveOperatorCsrfToken(token),
    },
  };
}

export async function handleRevokeOperatorSession({
  cookieHeader,
  csrfHeader,
  enabled = HUMAN_AUTH_ENABLED,
  sessionDir = OPERATOR_SESSION_DIR,
  secureCookie = OPERATOR_SESSION_COOKIE_SECURE,
  readSession = readOperatorSession,
  revokeSession = revokeOperatorSession,
  now,
}: {
  cookieHeader: unknown;
  csrfHeader: unknown;
  enabled?: boolean;
  sessionDir?: string;
  secureCookie?: boolean;
  readSession?: typeof readOperatorSession;
  revokeSession?: typeof revokeOperatorSession;
  now?: () => string | Date;
}): Promise<OperatorSessionRouteResult> {
  if (!enabled) return hidden();

  const clearHeader = {
    'Set-Cookie': clearOperatorSessionCookie({ secure: secureCookie }),
  };
  const token = extractOperatorSessionToken(cookieHeader);
  if (!token) return unauthorized(clearHeader);

  const session = await readSession({ dir: sessionDir, token, now });
  if (!session) return unauthorized(clearHeader);
  if (!verifyOperatorCsrfToken({ sessionToken: token, csrfToken: csrfHeader })) {
    return {
      status: 403,
      body: { error: 'Forbidden', error_code: 'operator_csrf_invalid' },
    };
  }

  await revokeSession({ dir: sessionDir, token, now });
  return {
    status: 200,
    headers: clearHeader,
    body: { ok: true, session_id: session.session_id },
  };
}
