import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const SAFE_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
export class IdempotencyConflictError extends Error {
    code = 'IDEMPOTENCY_CONFLICT';
}
export class IdempotencyInProgressError extends Error {
    code = 'IDEMPOTENCY_IN_PROGRESS';
}
function stable(value) {
    if (Array.isArray(value))
        return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}
function digest(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}
function recordPath(dir, actorId, operation, key) {
    return join(dir, `request-${digest(`${actorId}\0${operation}\0${key}`)}.json`);
}
async function writeAtomic(path, value) {
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o640 });
    await rename(temp, path);
}
async function readRecord(path) {
    try {
        return JSON.parse(await readFile(path, 'utf-8'));
    }
    catch (error) {
        if (error instanceof SyntaxError || error?.code === 'ENOENT')
            return null;
        throw error;
    }
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function awaitExisting(path, requestHash, waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() <= deadline) {
        const record = await readRecord(path);
        if (!record) {
            await delay(20);
            continue;
        }
        if (record.request_hash !== requestHash) {
            throw new IdempotencyConflictError('Idempotency key was already used for a different request');
        }
        if (record.status === 'completed') {
            return { replayed: true, response: record.response };
        }
        await delay(20);
    }
    throw new IdempotencyInProgressError('An identical request is still in progress');
}
export function validateIdempotencyKey(value) {
    const key = String(value || '').trim();
    if (!SAFE_KEY.test(key)) {
        throw new Error('idempotency_key must be 8-128 characters using letters, numbers, dot, colon, underscore, or dash');
    }
    return key;
}
export async function executeIdempotent({ dir, actorId, operation, targetId, key, payload, execute, waitMs = 5000, }) {
    const normalizedKey = validateIdempotencyKey(key);
    const path = recordPath(dir, actorId, operation, normalizedKey);
    const requestHash = digest(JSON.stringify(stable({ target_id: targetId, payload })));
    await mkdir(dir, { recursive: true });
    let owner = false;
    try {
        const handle = await open(path, 'wx', 0o640);
        owner = true;
        try {
            await handle.writeFile(`${JSON.stringify({
                schema: 'ops-room.idempotency.v1',
                actor_id: actorId,
                operation,
                target_id: targetId,
                key: normalizedKey,
                request_hash: requestHash,
                status: 'in_progress',
                created_at: new Date().toISOString(),
            }, null, 2)}\n`, 'utf-8');
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error?.code !== 'EEXIST')
            throw error;
    }
    if (!owner)
        return awaitExisting(path, requestHash, waitMs);
    try {
        const response = await execute();
        await writeAtomic(path, {
            schema: 'ops-room.idempotency.v1',
            actor_id: actorId,
            operation,
            target_id: targetId,
            key: normalizedKey,
            request_hash: requestHash,
            status: 'completed',
            response,
            completed_at: new Date().toISOString(),
        });
        return { replayed: false, response };
    }
    catch (error) {
        await rm(path, { force: true });
        throw error;
    }
}
//# sourceMappingURL=idempotency-store.js.map