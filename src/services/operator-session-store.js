import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeOperatorRoles } from './operator-rbac.js';
export const OPERATOR_SESSION_COOKIE_NAME = 'ops_room_session';
const SESSION_SCHEMA = 'ops-room.operator-session.v1';
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ACTOR_ID = /^[A-Za-z0-9._:-]{2,100}$/;
const SESSION_ID_PATTERN = /^session:[0-9a-f-]{36}$/i;
const SESSION_FILENAME_PATTERN = /^session-([0-9a-f]{64})\.json$/i;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const ADMIN_SESSION_STATES = new Set(['active', 'expired', 'revoked']);
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
function asDate(value, errorCode) {
    const parsed = new Date(String(value || ''));
    if (!Number.isFinite(parsed.getTime()))
        throw new Error(errorCode);
    return parsed;
}
function normalizeNow(now) {
    const value = now();
    return value instanceof Date ? value : asDate(value, 'operator_session_now_invalid');
}
function normalizeTtlSeconds(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_TTL_SECONDS || parsed > MAX_TTL_SECONDS) {
        throw new Error('operator_session_ttl_invalid');
    }
    return parsed;
}
function normalizeActor(actor) {
    const actorId = String(actor?.actor_id || '').trim();
    const displayName = String(actor?.actor_display_name || '').trim();
    if (!SAFE_ACTOR_ID.test(actorId))
        throw new Error('operator_session_actor_invalid');
    if (!displayName || displayName.length > 120)
        throw new Error('operator_session_display_name_invalid');
    return Object.freeze({ actor_id: actorId, actor_display_name: displayName });
}
function tokenHash(token) {
    return createHash('sha256').update(token).digest('hex');
}
function validateToken(token) {
    const normalized = String(token || '').trim();
    if (!SESSION_TOKEN_PATTERN.test(normalized))
        throw new Error('operator_session_token_invalid');
    return normalized;
}
function sessionPath(dir, hash) {
    return join(dir, `session-${hash}.json`);
}
function validateRecord(input) {
    if (!input || input.schema !== SESSION_SCHEMA || input.version !== 1) {
        throw new Error('operator_session_record_invalid');
    }
    if (!SESSION_ID_PATTERN.test(String(input.session_id || ''))) {
        throw new Error('operator_session_id_invalid');
    }
    if (!/^[0-9a-f]{64}$/i.test(String(input.token_hash || ''))) {
        throw new Error('operator_session_hash_invalid');
    }
    const actor = normalizeActor(input);
    const roles = normalizeOperatorRoles(input.roles);
    const createdAt = asDate(input.created_at, 'operator_session_created_at_invalid');
    const expiresAt = asDate(input.expires_at, 'operator_session_expires_at_invalid');
    if (expiresAt.getTime() <= createdAt.getTime())
        throw new Error('operator_session_expiry_invalid');
    let revokedAt = null;
    if (input.revoked_at !== null && input.revoked_at !== undefined) {
        revokedAt = asDate(input.revoked_at, 'operator_session_revoked_at_invalid').toISOString();
    }
    let revokedByActorId = null;
    let revocationReason = null;
    let revocationIdempotencyKey = null;
    if (input.revoked_by_actor_id !== null && input.revoked_by_actor_id !== undefined) {
        revokedByActorId = String(input.revoked_by_actor_id || '').trim();
        if (!SAFE_ACTOR_ID.test(revokedByActorId))
            throw new Error('operator_session_revoker_invalid');
    }
    if (input.revocation_reason !== null && input.revocation_reason !== undefined) {
        revocationReason = String(input.revocation_reason || '').trim();
        if (!revocationReason || revocationReason.length > 500)
            throw new Error('operator_session_revocation_reason_invalid');
    }
    if (input.revocation_idempotency_key !== null && input.revocation_idempotency_key !== undefined) {
        revocationIdempotencyKey = String(input.revocation_idempotency_key || '').trim();
        if (!SAFE_IDEMPOTENCY_KEY.test(revocationIdempotencyKey)) {
            throw new Error('operator_session_revocation_idempotency_invalid');
        }
    }
    if (!revokedAt && (revokedByActorId || revocationReason || revocationIdempotencyKey)) {
        throw new Error('operator_session_revocation_metadata_invalid');
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
        revoked_by_actor_id: revokedByActorId,
        revocation_reason: revocationReason,
        revocation_idempotency_key: revocationIdempotencyKey,
    });
}
async function writeNewRecord(path, record) {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function replaceRecord(path, record) {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    await rename(temporaryPath, path);
}
async function readRecordByToken({ dir, token }) {
    let normalizedToken;
    try {
        normalizedToken = validateToken(token);
    }
    catch {
        return null;
    }
    const expectedHash = tokenHash(normalizedToken);
    try {
        const parsed = JSON.parse(await readFile(sessionPath(dir, expectedHash), 'utf8'));
        const record = validateRecord(parsed);
        if (record.token_hash !== expectedHash)
            return null;
        return record;
    }
    catch {
        return null;
    }
}
export function publicOperatorSession(record) {
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
export function validateOperatorSessionId(value) {
    const sessionId = String(value || '').trim();
    if (!SESSION_ID_PATTERN.test(sessionId))
        throw new Error('operator_session_id_invalid');
    return sessionId;
}
function administrativeOperatorSession(record, now = () => new Date()) {
    const validated = validateRecord(record);
    const currentTime = normalizeNow(now).getTime();
    const status = validated.revoked_at
        ? 'revoked'
        : asDate(validated.expires_at, 'operator_session_expires_at_invalid').getTime() <= currentTime
            ? 'expired'
            : 'active';
    return Object.freeze({
        ...publicOperatorSession(validated),
        status,
        revoked_at: validated.revoked_at,
        revocation: validated.revoked_at
            ? Object.freeze({
                actor_id: validated.revoked_by_actor_id,
                reason: validated.revocation_reason,
                idempotency_key: validated.revocation_idempotency_key,
            })
            : null,
    });
}
async function readSessionRecords(dir) {
    let names;
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return [];
        throw error;
    }
    const records = [];
    const sessionIds = new Set();
    for (const name of names.filter((entry) => SESSION_FILENAME_PATTERN.test(entry)).sort()) {
        const match = name.match(SESSION_FILENAME_PATTERN);
        if (!match)
            continue;
        const parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
        const record = validateRecord(parsed);
        if (record.token_hash !== match[1].toLowerCase())
            throw new Error('operator_session_filename_hash_mismatch');
        if (sessionIds.has(record.session_id))
            throw new Error('operator_session_duplicate_id');
        sessionIds.add(record.session_id);
        records.push({ path: join(dir, name), record });
    }
    return records;
}
async function findSessionRecordById({ dir, sessionId }) {
    const normalizedSessionId = validateOperatorSessionId(sessionId);
    const records = await readSessionRecords(dir);
    return records.find((entry) => entry.record.session_id === normalizedSessionId) || null;
}
export async function listOperatorSessions({ dir, limit = 100, actorId, status, now = () => new Date(), }) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        throw new Error('operator_session_limit_filter_invalid');
    }
    const boundedLimit = parsedLimit;
    const normalizedActorId = String(actorId || '').trim();
    const normalizedStatus = String(status || '').trim();
    if (normalizedActorId && !SAFE_ACTOR_ID.test(normalizedActorId))
        throw new Error('operator_session_actor_filter_invalid');
    if (normalizedStatus && !ADMIN_SESSION_STATES.has(normalizedStatus))
        throw new Error('operator_session_status_filter_invalid');
    const records = await readSessionRecords(dir);
    return Object.freeze(records
        .map(({ record }) => administrativeOperatorSession(record, now))
        .filter((session) => !normalizedActorId || session.actor.actor_id === normalizedActorId)
        .filter((session) => !normalizedStatus || session.status === normalizedStatus)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, boundedLimit));
}
export async function readOperatorSessionById({ dir, sessionId, now = () => new Date(), }) {
    const found = await findSessionRecordById({ dir, sessionId });
    return found ? administrativeOperatorSession(found.record, now) : null;
}
export async function revokeOperatorSessionById({ dir, sessionId, actor, reason, idempotencyKey, now = () => new Date(), }) {
    const normalizedActor = normalizeActor(actor);
    const normalizedReason = String(reason || '').trim();
    const normalizedIdempotencyKey = String(idempotencyKey || '').trim();
    if (!normalizedReason || normalizedReason.length > 500)
        throw new Error('operator_session_revocation_reason_invalid');
    if (!SAFE_IDEMPOTENCY_KEY.test(normalizedIdempotencyKey)) {
        throw new Error('operator_session_revocation_idempotency_invalid');
    }
    const found = await findSessionRecordById({ dir, sessionId });
    if (!found)
        return null;
    if (found.record.revoked_at) {
        return Object.freeze({
            session: administrativeOperatorSession(found.record, now),
            already_revoked: true,
        });
    }
    const revoked = validateRecord({
        ...found.record,
        revoked_at: normalizeNow(now).toISOString(),
        revoked_by_actor_id: normalizedActor.actor_id,
        revocation_reason: normalizedReason,
        revocation_idempotency_key: normalizedIdempotencyKey,
    });
    await replaceRecord(found.path, revoked);
    return Object.freeze({
        session: administrativeOperatorSession(revoked, now),
        already_revoked: false,
    });
}
export async function createOperatorSession({ dir, actor, roles, ttlSeconds, now = () => new Date(), generateToken = () => randomBytes(32).toString('base64url'), }) {
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
        }
        catch (error) {
            if (error?.code !== 'EEXIST' || attempt === 2)
                throw error;
        }
    }
    throw new Error('operator_session_creation_failed');
}
export async function readOperatorSession({ dir, token, now = () => new Date(), }) {
    const record = await readRecordByToken({ dir, token });
    if (!record || record.revoked_at)
        return null;
    if (asDate(record.expires_at, 'operator_session_expires_at_invalid').getTime() <= normalizeNow(now).getTime()) {
        return null;
    }
    return publicOperatorSession(record);
}
export async function revokeOperatorSession({ dir, token, now = () => new Date(), }) {
    const normalizedToken = validateToken(token);
    const record = await readRecordByToken({ dir, token: normalizedToken });
    if (!record)
        return null;
    if (record.revoked_at)
        return publicOperatorSession(record);
    const revoked = validateRecord({
        ...record,
        revoked_at: normalizeNow(now).toISOString(),
    });
    await replaceRecord(sessionPath(dir, tokenHash(normalizedToken)), revoked);
    return publicOperatorSession(revoked);
}
export function extractOperatorSessionToken(cookieHeader) {
    const normalizedHeader = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    if (!normalizedHeader)
        return null;
    const matches = String(normalizedHeader)
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${OPERATOR_SESSION_COOKIE_NAME}=`));
    if (matches.length !== 1)
        return null;
    try {
        const token = decodeURIComponent(matches[0].slice(OPERATOR_SESSION_COOKIE_NAME.length + 1));
        return validateToken(token);
    }
    catch {
        return null;
    }
}
export function serializeOperatorSessionCookie({ token, ttlSeconds, secure = true, }) {
    const normalizedToken = validateToken(token);
    const normalizedTtlSeconds = normalizeTtlSeconds(ttlSeconds);
    const attributes = [
        `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(normalizedToken)}`,
        'Path=/api',
        `Max-Age=${normalizedTtlSeconds}`,
        'HttpOnly',
        'SameSite=Strict',
    ];
    if (secure)
        attributes.push('Secure');
    return attributes.join('; ');
}
export function clearOperatorSessionCookie({ secure = true } = {}) {
    const attributes = [
        `${OPERATOR_SESSION_COOKIE_NAME}=`,
        'Path=/api',
        'Max-Age=0',
        'HttpOnly',
        'SameSite=Strict',
    ];
    if (secure)
        attributes.push('Secure');
    return attributes.join('; ');
}
//# sourceMappingURL=operator-session-store.js.map