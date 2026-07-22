import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
function effectId({ taskId, kind, fingerprint }) {
    return createHash('sha256').update(`${taskId}\u0000${kind}\u0000${fingerprint}`).digest('hex');
}
function effectPath(dir, id) {
    return join(dir, 'effects', `${id}.json`);
}
async function readEffect(dir, id) {
    try {
        return JSON.parse(await readFile(effectPath(dir, id), 'utf-8'));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        throw error;
    }
}
/**
 * Read the task's durable record and validate that the supplied lease still
 * owns it.  This is the authoritative check: it reads the actual task file,
 * not a caller-provided copy.  Throws if the task's current lease does not
 * match the supplied leaseId/leaseEpoch.
 */
async function assertCurrentLease({ dir, taskId, leaseId, leaseEpoch }) {
    if (!leaseId && leaseEpoch === undefined)
        return; // no lease to validate
    const { readTask } = await import('./review-task-store.js');
    let task;
    try {
        task = await readTask({ dir, id: taskId });
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error(`Cannot create effect for task ${taskId}: task record not found`);
        }
        throw error;
    }
    if (!task) {
        throw new Error(`Cannot create effect for task ${taskId}: task record not found`);
    }
    // Fail closed: if the task has no current lease, any supplied lease is stale.
    if (leaseId && !task.lease?.lease_id) {
        throw new Error(`Stale lease: task ${taskId} has no current lease, caller has ${leaseId}`);
    }
    if (leaseEpoch !== undefined && task.lease?.lease_epoch === undefined) {
        throw new Error(`Stale lease: task ${taskId} has no current lease epoch, caller has ${leaseEpoch}`);
    }
    // Require exact equality.
    if (leaseId && task.lease?.lease_id && task.lease.lease_id !== leaseId) {
        throw new Error(`Stale lease: task ${taskId} owned by ${task.lease.lease_id}, caller has ${leaseId}`);
    }
    if (leaseEpoch !== undefined && task.lease?.lease_epoch !== undefined && task.lease.lease_epoch !== leaseEpoch) {
        throw new Error(`Stale lease: task ${taskId} has epoch ${task.lease.lease_epoch}, caller has ${leaseEpoch}`);
    }
}
/**
 * Claim an external effect for a task.  Accepts optional leaseId/leaseEpoch:
 *   - Before creating a brand-new effect, reads the task's current lease and
 *     rejects stale workers (whose lease no longer owns the task).
 *   - Persists lease ownership on new effects for later fencing.
 *   - For existing effects, fences against the stored lease.
 */
export async function claimEffect({ dir, taskId, kind, fingerprint, leaseId, leaseEpoch }) {
    const id = effectId({ taskId, kind, fingerprint });
    const path = effectPath(dir, id);
    await mkdir(join(dir, 'effects'), { recursive: true });
    // Validate against the task's CURRENT durable lease before creating a new effect.
    await assertCurrentLease({ dir, taskId, leaseId, leaseEpoch });
    const effect = {
        id, task_id: taskId, kind, fingerprint, state: 'CLAIMED',
        created_at: new Date().toISOString(),
        claimed_by_lease_id: leaseId || null,
        claimed_by_lease_epoch: leaseEpoch ?? null,
    };
    try {
        const handle = await open(path, 'wx');
        try {
            await handle.writeFile(`${JSON.stringify(effect, null, 2)}\n`);
        }
        finally {
            await handle.close();
        }
        return { claimed: true, state: 'CLAIMED', effect };
    }
    catch (error) {
        if (error?.code !== 'EEXIST')
            throw error;
        const existing = await readEffect(dir, id);
        // Fence: reject claims from a stale worker whose lease was superseded.
        if (leaseId && existing?.claimed_by_lease_id && existing.claimed_by_lease_id !== leaseId) {
            return { claimed: false, state: existing?.state || 'CLAIMED', effect: existing, fenced: true, reason: 'stale_lease' };
        }
        if (leaseEpoch !== undefined && existing?.claimed_by_lease_epoch !== undefined && existing.claimed_by_lease_epoch > leaseEpoch) {
            return { claimed: false, state: existing?.state || 'CLAIMED', effect: existing, fenced: true, reason: 'superseded_epoch' };
        }
        return { claimed: false, state: existing?.state || 'CLAIMED', effect: existing };
    }
}
/**
 * Complete a previously claimed effect.  Validates the lease against both
 * the effect's stored ownership AND the task's current durable lease before
 * marking COMPLETED.  A stale worker cannot complete an effect it created
 * after another worker has taken over.
 */
export async function completeEffect({ dir, effectId: id, result = {}, leaseId, leaseEpoch }) {
    const current = await readEffect(dir, id);
    if (!current)
        throw new Error(`Effect not found: ${id}`);
    // Validate against the task's CURRENT lease (authoritative).
    if (current.task_id) {
        await assertCurrentLease({ dir, taskId: current.task_id, leaseId, leaseEpoch });
    }
    // Also validate against the effect's stored ownership.
    if (leaseId && current.claimed_by_lease_id && current.claimed_by_lease_id !== leaseId) {
        throw new Error(`Cannot complete effect claimed by lease ${current.claimed_by_lease_id} with lease ${leaseId}`);
    }
    if (leaseEpoch !== undefined && current.claimed_by_lease_epoch !== undefined && current.claimed_by_lease_epoch !== leaseEpoch) {
        throw new Error(`Cannot complete effect with lease epoch ${current.claimed_by_lease_epoch} using epoch ${leaseEpoch}`);
    }
    const effect = { ...current, state: 'COMPLETED', completed_at: new Date().toISOString(), result };
    const { writeAtomic } = await import('./review-task-store.js');
    await writeAtomic(effectPath(dir, id), effect);
    return effect;
}
export async function listEffects({ dir, taskId, kind, state }) {
    const { readdir } = await import('node:fs/promises');
    const effectsDir = join(dir, 'effects');
    let names;
    try {
        names = await readdir(effectsDir);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return [];
        throw error;
    }
    const effects = [];
    for (const name of names) {
        if (!name.endsWith('.json'))
            continue;
        try {
            const effect = JSON.parse(await readFile(join(effectsDir, name), 'utf-8'));
            if (taskId && effect.task_id !== taskId)
                continue;
            if (kind && effect.kind !== kind)
                continue;
            if (state && effect.state !== state)
                continue;
            effects.push(effect);
        }
        catch { /* skip corrupt */ }
    }
    return effects.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
export async function resolveAmbiguousEffect({ dir, effectId: id, resolution, notes = '' }) {
    const current = await readEffect(dir, id);
    if (!current)
        throw new Error(`Effect not found: ${id}`);
    if (current.state !== 'CLAIMED')
        throw new Error(`Can only resolve CLAIMED effects, not ${current.state}`);
    const resolvedState = resolution === 'complete' ? 'COMPLETED' : resolution === 'abandon' ? 'ABANDONED' : resolution;
    const effect = {
        ...current,
        state: resolvedState,
        resolved_at: new Date().toISOString(),
        resolution_notes: notes || `Operator resolved as ${resolvedState}`,
    };
    const { writeAtomic } = await import('./review-task-store.js');
    await writeAtomic(effectPath(dir, id), effect);
    return effect;
}
/**
 * Atomically transition an ABANDONED effect back to CLAIMED so the caller
 * can retry the external action.  Uses an exclusive reclaim lock file plus
 * re-read-under-lock.  Before reclaiming, validates the lease against the
 * task's current durable lease.
 */
export async function reclaimEffect({ dir, effectId: id, leaseId, leaseEpoch }) {
    const { mkdir, open, rm } = await import('node:fs/promises');
    const reclaimLockDir = join(dir, 'effects', '.reclaim-locks');
    await mkdir(reclaimLockDir, { recursive: true });
    const lockPath = join(reclaimLockDir, `${id}.lock`);
    let lockHandle;
    try {
        lockHandle = await open(lockPath, 'wx');
    }
    catch (error) {
        if (error?.code === 'EEXIST')
            return { reclaimed: false, reason: 'concurrent_reclaim' };
        throw error;
    }
    try {
        const current = await readEffect(dir, id);
        if (!current)
            throw new Error(`Effect not found: ${id}`);
        if (current.state !== 'ABANDONED') {
            return { reclaimed: false, reason: `not_abandoned:${current.state}` };
        }
        // Validate against the task's current lease before reclaiming.
        if (current.task_id) {
            await assertCurrentLease({ dir, taskId: current.task_id, leaseId, leaseEpoch });
        }
        const effect = {
            ...current,
            state: 'CLAIMED',
            reclaimed_at: new Date().toISOString(),
            claimed_by_lease_id: leaseId || current.claimed_by_lease_id,
            claimed_by_lease_epoch: leaseEpoch ?? current.claimed_by_lease_epoch,
        };
        const { writeAtomic } = await import('./review-task-store.js');
        await writeAtomic(effectPath(dir, id), effect);
        return { reclaimed: true, effect };
    }
    finally {
        await lockHandle.close();
        try {
            await rm(lockPath, { force: true });
        }
        catch { /* best-effort */ }
    }
}
//# sourceMappingURL=review-effect-ledger.js.map