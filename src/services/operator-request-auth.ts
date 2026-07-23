import { createHash, timingSafeEqual } from 'node:crypto';

import { verifyOperatorAuth } from '../routes/helpers.js';
import { appendAuditEvent } from './audit-log.js';
import { hasOperatorPermission, type OperatorPermission } from './operator-rbac.js';
import { resolveOperatorIdentity } from './operator-identity.js';
import {
  extractOperatorSessionToken,
  readOperatorSession,
} from './operator-session-store.js';
import {
  AUDIT_DIR,
  EMERGENCY_READ_ONLY_ENABLED,
  HUMAN_AUTH_ENABLED,
  OPERATOR_API_ENABLED,
  OPERATOR_SESSION_DIR,
} from './runtime-paths.js';

export const OPERATOR_CSRF_HEADER_NAME = 'x-ops-room-csrf';
export const OPERATOR_CONFIRMATION_HEADER_NAME = 'x-ops-room-confirmation';

export const OPERATOR_STEP_UP_PERMISSIONS = Object.freeze([
  'mission.start',
  'workflow.approve',
  'agent.lifecycle',
  'agent.configure',
  'policy.manage',
  'session.manage',
  'repository.manage',
  'release.approve',
] as const satisfies readonly OperatorPermission[]);

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STEP_UP_PERMISSION_SET = new Set<OperatorPermission>(OPERATOR_STEP_UP_PERMISSIONS);

function normalizedHeader(value: unknown): string {
  return String(Array.isArray(value) ? value[0] || '' : value || '').trim();
}

function normalizeSessionToken(value: unknown): string {
  const token = String(value || '').trim();
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new Error('operator_session_token_invalid');
  return token;
}

function requestMethod(req: any): string {
  return String(req?.method || 'GET').trim().toUpperCase().slice(0, 16) || 'GET';
}

function requestPath(req: any): string {
  try {
    return new URL(req?.url || '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function isMutationRequest(req: any): boolean {
  return !SAFE_METHODS.has(requestMethod(req));
}

function actorFromSession(session: any) {
  return Object.freeze({
    ...session.actor,
    session_id: session.session_id,
  });
}

function safeTextEqual(providedValue: string, expectedValue: string): boolean {
  const provided = Buffer.from(providedValue);
  const expected = Buffer.from(expectedValue);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
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
    return safeTextEqual(providedValue, deriveOperatorCsrfToken(sessionToken));
  } catch {
    return false;
  }
}

export function requiresOperatorStepUp(permission: OperatorPermission): boolean {
  return STEP_UP_PERMISSION_SET.has(permission);
}

export function operatorStepUpConfirmationValue({
  permission,
  method,
  path,
}: {
  permission: OperatorPermission;
  method: unknown;
  path: unknown;
}): string {
  if (!requiresOperatorStepUp(permission)) {
    throw new Error(`operator_step_up_not_required:${permission}`);
  }
  const normalizedMethod = String(method || '').trim().toUpperCase();
  if (!normalizedMethod || SAFE_METHODS.has(normalizedMethod)) {
    throw new Error('operator_step_up_method_invalid');
  }
  let normalizedPath: string;
  try {
    normalizedPath = new URL(String(path || '/'), 'http://localhost').pathname;
  } catch {
    throw new Error('operator_step_up_path_invalid');
  }
  return `confirm:${permission}:${normalizedMethod}:${normalizedPath}`;
}

export function verifyOperatorStepUpConfirmation({
  req,
  permission,
}: {
  req: any;
  permission: OperatorPermission;
}): boolean {
  try {
    const provided = normalizedHeader(req?.headers?.[OPERATOR_CONFIRMATION_HEADER_NAME]);
    if (!provided || provided.length > 512) return false;
    const expected = operatorStepUpConfirmationValue({
      permission,
      method: requestMethod(req),
      path: requestPath(req),
    });
    return safeTextEqual(provided, expected);
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

type OperatorAuthorizationDenialCode =
  | 'operator_permission_denied'
  | 'operator_csrf_invalid'
  | 'operator_step_up_required'
  | 'operator_emergency_read_only';

async function auditedAuthorizationDenial({
  req,
  permission,
  actor,
  errorCode,
  status,
  error,
  auditDir,
  appendAudit,
}: {
  req: any;
  permission: OperatorPermission;
  actor: Readonly<Record<string, any>>;
  errorCode: OperatorAuthorizationDenialCode;
  status: number;
  error: string;
  auditDir: string;
  appendAudit: typeof appendAuditEvent;
}): Promise<OperatorAuthorizationResult> {
  try {
    await appendAudit({
      dir: auditDir,
      operation: 'operator.authorization.denied',
      actor,
      target: { type: 'operator_permission', id: permission },
      reason: errorCode,
      previousState: 'authenticated',
      resultingState: 'denied',
      outcome: 'rejected',
      errorCode,
      metadata: {
        method: requestMethod(req),
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
    status,
    error,
    error_code: errorCode,
  };
}

export async function authorizeOperatorRequest({
  req,
  permission,
  requireCsrf = isMutationRequest(req),
  requireStepUp,
  operatorApiEnabled = OPERATOR_API_ENABLED,
  humanAuthEnabled = HUMAN_AUTH_ENABLED,
  emergencyReadOnlyEnabled = EMERGENCY_READ_ONLY_ENABLED,
  sessionDir = OPERATOR_SESSION_DIR,
  auditDir = AUDIT_DIR,
  verifyOperatorBearer = verifyOperatorAuth,
  resolveBearerActor = resolveOperatorIdentity,
  readSession = readOperatorSession,
  appendAudit = appendAuditEvent,
  now,
}: {
  req: any;
  permission: OperatorPermission;
  requireCsrf?: boolean;
  requireStepUp?: boolean;
  operatorApiEnabled?: boolean;
  humanAuthEnabled?: boolean;
  emergencyReadOnlyEnabled?: boolean;
  sessionDir?: string;
  auditDir?: string;
  verifyOperatorBearer?: (authorization: unknown) => boolean;
  resolveBearerActor?: () => Readonly<Record<string, any>>;
  readSession?: typeof readOperatorSession;
  appendAudit?: typeof appendAuditEvent;
  now?: () => string | Date;
}): Promise<OperatorAuthorizationResult> {
  if (!operatorApiEnabled) {
    return { ok: false, status: 404, error: 'Not found', error_code: 'operator_api_disabled' };
  }

  const mutation = isMutationRequest(req);
  let actor: Readonly<Record<string, any>>;
  let authMethod: 'operator_token' | 'operator_session';
  let session: any | null = null;
  let sessionToken: string | null = null;

  if (verifyOperatorBearer(req?.headers?.authorization)) {
    try {
      actor = resolveBearerActor();
      authMethod = 'operator_token';
    } catch {
      return {
        ok: false,
        status: 503,
        error: 'Operator identity unavailable',
        error_code: 'operator_identity_unavailable',
      };
    }
  } else {
    if (!humanAuthEnabled) {
      return { ok: false, status: 401, error: 'Unauthorized', error_code: 'operator_auth_required' };
    }

    sessionToken = extractOperatorSessionToken(req?.headers?.cookie);
    if (!sessionToken) {
      return { ok: false, status: 401, error: 'Unauthorized', error_code: 'operator_session_required' };
    }

    try {
      session = await readSession({ dir: sessionDir, token: sessionToken, now });
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

    actor = actorFromSession(session);
    authMethod = 'operator_session';

    if (!hasOperatorPermission(session.roles, permission)) {
      return auditedAuthorizationDenial({
        req,
        permission,
        actor,
        errorCode: 'operator_permission_denied',
        status: 403,
        error: 'Forbidden',
        auditDir,
        appendAudit,
      });
    }

    if (requireCsrf && !verifyOperatorCsrfToken({
      sessionToken,
      csrfToken: req?.headers?.[OPERATOR_CSRF_HEADER_NAME],
    })) {
      return auditedAuthorizationDenial({
        req,
        permission,
        actor,
        errorCode: 'operator_csrf_invalid',
        status: 403,
        error: 'Forbidden',
        auditDir,
        appendAudit,
      });
    }
  }

  if (mutation && emergencyReadOnlyEnabled) {
    return auditedAuthorizationDenial({
      req,
      permission,
      actor,
      errorCode: 'operator_emergency_read_only',
      status: 423,
      error: 'Operator mutations are disabled',
      auditDir,
      appendAudit,
    });
  }

  const stepUpRequired = authMethod === 'operator_session'
    && mutation
    && (requireStepUp ?? requiresOperatorStepUp(permission));
  if (stepUpRequired && !verifyOperatorStepUpConfirmation({ req, permission })) {
    return auditedAuthorizationDenial({
      req,
      permission,
      actor,
      errorCode: 'operator_step_up_required',
      status: 428,
      error: 'Action confirmation required',
      auditDir,
      appendAudit,
    });
  }

  return {
    ok: true,
    actor,
    auth_method: authMethod,
    session,
  };
}
