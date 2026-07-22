import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeOperatorRoles, type OperatorRole } from './operator-rbac.js';

export const OPERATOR_SESSION_COOKIE_NAME = 'ops_room_session';

const SESSION_SCHEMA = 'ops-room.operator-session.v1';
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ACTOR_ID = /^[A-Za-z0-9._:-]{2,100}$/;
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

function asDate(value: unknown, errorCode: string): Date {
  const parsed = new Date(String(value || ''));
  if (!Number.isFinite(parsed.getTime())) throw new Error(errorCode);
  return parsed;
}

function normalizeNow(now: () => string | Date): Date {
  const value = now();
  return value instanceof Date ? value : asDate(value, 'operator_session_now_invalid');
}

function normalizeTtlSeconds(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TTL_SECONDS || parsed > MAX_TTL_SECONDS) {
    throw new Error('operator_session_ttl_invalid');
  }
  return parsed;
}

function normalizeActor(actor: any) {
  const actorId = String(actor?.actor_id || '').trim();
  const displayName = String(actor?.actor_display_name || '').trim();
  if (!SAFE_ACTOR_ID.test(actorId)) throw new Error('operator_session_actor_invalid');
  if (!displayName || displayName.length > 120) throw new Error('operator_session_display_name_invalid');
  return Object.freeze({ actor_id: actorId, actor_display_name: displayName });
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function validateToken(token: unknown): string {
  const normalized = String(token || '').trim();
  if (!SESSION_TOKEN_PATTERN.test(normalized)) throw new Error('operator_session_token_invalid');
  return normalized;
}

function sessionPath(dir: string, hash: string): string {
  return join(dir, `session-${hash}.json`);
}

function validateRecord(input: any) {
  if (!input || input.schema !== SESSION_SCHEMA || input.version !== 1) {
    throw new Error('operator_session_record_invalid');
  }
  if (!/^session:[0-9a-f-]{36}$/i.test(String(input.session_id || ''))) {
    throw new Error('operator_session_id_invalid');
  }
  if (!/^[0-9a-f]{64}$/i.test(String(input.token_hash || ''))) {
    throw new Error('operator_session_hash_invalid');
  }

  const actor = normalizeActor(input);
  const roles = normalizeOperatorRoles(input.roles);
  const createdAt = asDate(input.created_at, 'operator_session_created_at_invalid');
  const expiresAt = asDate(input.expires_at, 'operator_session_expires_at_invalid');
  if (expiresAt.getTime() <= createdAt.getTime()) throw new Error('operator_session_expiry_invalid');

  let revokedAt: string | null = null;
  if (input.revoked_at !== null && input.revoked_at !== undefined) {
    revokedAt = asDate(input.revoked_at, 'operator_session_revoked_at_invalid').toISOString();
  }

  return Object.freeze({
    schema: SESSION_SCHEMA,
    version: 1,
    session_id: String(input.session_id),
    token_hash: String(input.token_hash).toLowerCase(),
    actor_id: actor.actor_id,
    actor_display_name: actor.actor_display_name,
    roles,
    auth_method: 'operator_session',
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    revoked_at: revokedAt,
  });
}

async function writeNewRecord(path: string, record: any): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceRecord(path: string, record: any): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function readRecordByToken({ dir, token }: { dir: string; token: unknown }) {
  let normalizedToken: string;
  try {
    normalizedToken = validateToken(token);
  } catch {
    return null;
  }

  const expectedHash = tokenHash(normalizedToken);
  try {
    const parsed = JSON.parse(await readFile(sessionPath(dir, expectedHash), 'utf8'));
    const record = validateRecord(parsed);
    if (record.token_hash !== expectedHash) return null;
    return record;
  } catch {
    return null;
  }
}

export function publicOperatorSession(record: any) {
  const validated = validateRecord(record);
  return Object.freeze({
    session_id: validated.session_id,
    actor: Object.freeze({
      actor_type: 'human_operator',
      actor_id: validated.actor_id,
      actor_display_name: validated.actor_display_name,
      auth_method: validated.auth_method,
    }),
    roles: validated.roles,
    created_at: validated.created_at,
    expires_at: validated.expires_at,
  });
}

export async function createOperatorSession({
  dir,
  actor,
  roles,
  ttlSeconds,
  now = () => new Date(),
  generateToken = () => randomBytes(32).toString('base64url'),
}: {
  dir: string;
  actor: any;
  roles: unknown;
  ttlSeconds: unknown;
  now?: () => string | Date;
  generateToken?: () => string;
}) {
  const normalizedActor = normalizeActor(actor);
  const normalizedRoles = normalizeOperatorRoles(roles);
  const normalizedTtlSeconds = normalizeTtlSeconds(ttlSeconds);
  const createdAt = normalizeNow(now);
  const expiresAt = new Date(createdAt.getTime() + normalizedTtlSeconds * 1000);

  await mkdir(dir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = validateToken(generateToken());
    const hash = tokenHash(token);
    const record = validateRecord({
      schema: SESSION_SCHEMA,
      version: 1,
      session_id: `session:${randomUUID()}`,
      token_hash: hash,
      actor_id: normalizedActor.actor_id,
      actor_display_name: normalizedActor.actor_display_name,
      roles: normalizedRoles,
      auth_method: 'operator_session',
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      revoked_at: null,
    });

    try {
      await writeNewRecord(sessionPath(dir, hash), record);
      return Object.freeze({
        token,
        session: publicOperatorSession(record),
        ttl_seconds: normalizedTtlSeconds,
      });
    } catch (error: any) {
      if (error?.code !== 'EEXIST' || attempt === 2) throw error;
    }
  }

  throw new Error('operator_session_creation_failed');
}

export async function readOperatorSession({
  dir,
  token,
  now = () => new Date(),
}: {
  dir: string;
  token: unknown;
  now?: () => string | Date;
}) {
  const record = await readRecordByToken({ dir, token });
  if (!record || record.revoked_at) return null;
  if (asDate(record.expires_at, 'operator_session_expires_at_invalid').getTime() <= normalizeNow(now).getTime()) {
    return null;
  }
  return publicOperatorSession(record);
}

export async function revokeOperatorSession({
  dir,
  token,
  now = () => new Date(),
}: {
  dir: string;
  token: unknown;
  now?: () => string | Date;
}) {
  const normalizedToken = validateToken(token);
  const record = await readRecordByToken({ dir, token: normalizedToken });
  if (!record) return null;
  if (record.revoked_at) return publicOperatorSession(record);

  const revoked = validateRecord({
    ...record,
    revoked_at: normalizeNow(now).toISOString(),
  });
  await replaceRecord(sessionPath(dir, tokenHash(normalizedToken)), revoked);
  return publicOperatorSession(revoked);
}

export function extractOperatorSessionToken(cookieHeader: unknown): string | null {
  const normalizedHeader = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!normalizedHeader) return null;

  const matches = String(normalizedHeader)
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${OPERATOR_SESSION_COOKIE_NAME}=`));
  if (matches.length !== 1) return null;

  try {
    const token = decodeURIComponent(matches[0].slice(OPERATOR_SESSION_COOKIE_NAME.length + 1));
    return validateToken(token);
  } catch {
    return null;
  }
}

export function serializeOperatorSessionCookie({
  token,
  ttlSeconds,
  secure = true,
}: {
  token: unknown;
  ttlSeconds: unknown;
  secure?: boolean;
}): string {
  const normalizedToken = validateToken(token);
  const normalizedTtlSeconds = normalizeTtlSeconds(ttlSeconds);
  const attributes = [
    `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(normalizedToken)}`,
    'Path=/api',
    `Max-Age=${normalizedTtlSeconds}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearOperatorSessionCookie({ secure = true }: { secure?: boolean } = {}): string {
  const attributes = [
    `${OPERATOR_SESSION_COOKIE_NAME}=`,
    'Path=/api',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export type OperatorSessionRole = OperatorRole;
