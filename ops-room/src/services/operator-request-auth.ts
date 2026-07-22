import { createHash, timingSafeEqual } from 'node:crypto';

import { verifyOperatorAuth } from '../routes/helpers.js';
import { hasOperatorPermission, type OperatorPermission } from './operator-rbac.js';
import { resolveOperatorIdentity } from './operator-identity.js';
import {
  extractOperatorSessionToken,
  readOperatorSession,
} from './operator-session-store.js';
import {
  HUMAN_AUTH_ENABLED,
  OPERATOR_API_ENABLED,
  OPERATOR_SESSION_DIR,
} from './runtime-paths.js';

export const OPERATOR_CSRF_HEADER_NAME = 'x-ops-room-csrf';

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function normalizedHeader(value: unknown): string {
  return String(Array.isArray(value) ? value[0] || '' : value || '').trim();
}

function normalizeSessionToken(value: unknown): string {
  const token = String(value || '').trim();
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new Error('operator_session_token_invalid');
  return token;
}

export function deriveOperatorCsrfToken(sessionToken: unknown): string {
  const token = normalizeSessionToken(sessionToken);
  return createHash('sha256')
    .update(`ops-room.operator-csrf.v1:${token}`)
    .digest('base64url');
}

export function verifyOperatorCsrfToken({
  sessionToken,
  csrfToken,
}: {
  sessionToken: unknown;
  csrfToken: unknown;
}): boolean {
  try {
    const providedValue = normalizedHeader(csrfToken);
    if (!CSRF_TOKEN_PATTERN.test(providedValue)) return false;
    const provided = Buffer.from(providedValue);
    const expected = Buffer.from(deriveOperatorCsrfToken(sessionToken));
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

export type OperatorAuthorizationResult =
  | {
    ok: true;
    actor: Readonly<Record<string, any>>;
    auth_method: 'operator_token' | 'operator_session';
    session: any | null;
  }
  | {
    ok: false;
    status: number;
    error: string;
    error_code: string;
  };

export async function authorizeOperatorRequest({
  req,
  permission,
  requireCsrf = !['GET', 'HEAD', 'OPTIONS'].includes(String(req?.method || '').toUpperCase()),
  operatorApiEnabled = OPERATOR_API_ENABLED,
  humanAuthEnabled = HUMAN_AUTH_ENABLED,
  sessionDir = OPERATOR_SESSION_DIR,
  verifyOperatorBearer = verifyOperatorAuth,
  resolveBearerActor = resolveOperatorIdentity,
  readSession = readOperatorSession,
  now,
}: {
  req: any;
  permission: OperatorPermission;
  requireCsrf?: boolean;
  operatorApiEnabled?: boolean;
  humanAuthEnabled?: boolean;
  sessionDir?: string;
  verifyOperatorBearer?: (authorization: unknown) => boolean;
  resolveBearerActor?: () => Readonly<Record<string, any>>;
  readSession?: typeof readOperatorSession;
  now?: () => string | Date;
}): Promise<OperatorAuthorizationResult> {
  if (!operatorApiEnabled) {
    return { ok: false, status: 404, error: 'Not found', error_code: 'operator_api_disabled' };
  }

  if (verifyOperatorBearer(req?.headers?.authorization)) {
    try {
      return {
        ok: true,
        actor: resolveBearerActor(),
        auth_method: 'operator_token',
        session: null,
      };
    } catch {
      return {
        ok: false,
        status: 503,
        error: 'Operator identity unavailable',
        error_code: 'operator_identity_unavailable',
      };
    }
  }

  if (!humanAuthEnabled) {
    return { ok: false, status: 401, error: 'Unauthorized', error_code: 'operator_auth_required' };
  }

  const token = extractOperatorSessionToken(req?.headers?.cookie);
  if (!token) {
    return { ok: false, status: 401, error: 'Unauthorized', error_code: 'operator_session_required' };
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
    return { ok: false, status: 401, error: 'Unauthorized', error_code: 'operator_session_invalid' };
  }

  if (!hasOperatorPermission(session.roles, permission)) {
    return { ok: false, status: 403, error: 'Forbidden', error_code: 'operator_permission_denied' };
  }

  if (requireCsrf && !verifyOperatorCsrfToken({
    sessionToken: token,
    csrfToken: req?.headers?.[OPERATOR_CSRF_HEADER_NAME],
  })) {
    return { ok: false, status: 403, error: 'Forbidden', error_code: 'operator_csrf_invalid' };
  }

  return {
    ok: true,
    actor: Object.freeze({
      ...session.actor,
      session_id: session.session_id,
    }),
    auth_method: 'operator_session',
    session,
  };
}
