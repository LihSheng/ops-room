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
  try { return JSON.parse(await readFile(effectPath(dir, id), 'utf-8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Claim an external effect for a task.  Accepts optional lease parameters:
 *   - leaseId / leaseEpoch: persisted on new effects for later fencing
 *   - taskLeaseId / taskLeaseEpoch: the task's CURRENT lease; if supplied,
 *     a brand-new effect is rejected when the worker's lease doesn't match.
 *     This prevents a stale worker from creating a new effect after a
 *     replacement worker has taken over.
 */
export async function claimEffect({ dir, taskId, kind, fingerprint, leaseId, leaseEpoch, taskLeaseId, taskLeaseEpoch }) {
  const id = effectId({ taskId, kind, fingerprint });
  const path = effectPath(dir, id);
  await mkdir(join(dir, 'effects'), { recursive: true });

  // If the caller supplied the task's current lease, validate ownership
  // BEFORE attempting to create a new effect.
  if (taskLeaseId && leaseId && taskLeaseId !== leaseId) {
    return { claimed: false, state: null, fenced: true, reason: 'task_lease_mismatch' };
  }
  if (taskLeaseEpoch !== undefined && leaseEpoch !== undefined && taskLeaseEpoch !== leaseEpoch) {
    return { claimed: false, state: null, fenced: true, reason: 'task_lease_epoch_mismatch' };
  }

  const effect = {
    id, task_id: taskId, kind, fingerprint, state: 'CLAIMED',
    created_at: new Date().toISOString(),
    claimed_by_lease_id: leaseId || null,
    claimed_by_lease_epoch: leaseEpoch ?? null,
  };
  try {
    const handle = await open(path, 'wx');
    try { await handle.writeFile(`${JSON.stringify(effect, null, 2)}\n`); } finally { await handle.close(); }
    return { claimed: true, state: 'CLAIMED', effect };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
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
 * Complete a previously claimed effect.  If leaseId/leaseEpoch are supplied,
 * the effect's claimed-by lease must match — a stale worker cannot complete
 * an effect created by a superseded worker.
 */
export async function completeEffect({ dir, effectId: id, result = {}, leaseId, leaseEpoch }) {
  const current = await readEffect(dir, id);
  if (!current) throw new Error(`Effect not found: ${id}`);
  if (leaseId && current.claimed_by_lease_id && current.claimed_by_lease_id !== leaseId) {
    throw new Error(`Cannot complete effect claimed by lease ${current.claimed_by_lease_id} with lease ${leaseId}`);
  }
  if (leaseEpoch !== undefined && current.claimed_by_lease_epoch !== undefined && current.claimed_by_lease_epoch !== leaseEpoch) {
    throw new Error(`Cannot complete effect with lease epoch ${current.claimed_by_lease_epoch} using epoch ${leaseEpoch}`);
  }
  const effect = { ...current, state: 'COMPLETED', completed_at: new Date().toISOString(), result };
  const { writeAtomic } = await import('./review-task-store.mjs');
  await writeAtomic(effectPath(dir, id), effect);
  return effect;
}

export async function listEffects({ dir, taskId, kind, state }) {
  const { readdir } = await import('node:fs/promises');
  const effectsDir = join(dir, 'effects');
  let names;
  try { names = await readdir(effectsDir); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const effects = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const effect = JSON.parse(await readFile(join(effectsDir, name), 'utf-8'));
      if (taskId && effect.task_id !== taskId) continue;
      if (kind && effect.kind !== kind) continue;
      if (state && effect.state !== state) continue;
      effects.push(effect);
    } catch { /* skip corrupt */ }
  }
  return effects.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function resolveAmbiguousEffect({ dir, effectId: id, resolution, notes = '' }) {
  const current = await readEffect(dir, id);
  if (!current) throw new Error(`Effect not found: ${id}`);
  if (current.state !== 'CLAIMED') throw new Error(`Can only resolve CLAIMED effects, not ${current.state}`);
  const resolvedState = resolution === 'complete' ? 'COMPLETED' : resolution === 'abandon' ? 'ABANDONED' : resolution;
  const effect = {
    ...current,
    state: resolvedState,
    resolved_at: new Date().toISOString(),
    resolution_notes: notes || `Operator resolved as ${resolvedState}`,
  };
  const { writeAtomic } = await import('./review-task-store.mjs');
  await writeAtomic(effectPath(dir, id), effect);
  return effect;
}

/**
 * Atomically transition an ABANDONED effect back to CLAIMED so the caller
 * can retry the external action.  Uses an exclusive reclaim lock file plus
 * re-read-under-lock to prevent two concurrent retries from both observing
 * ABANDONED and both performing the effect.
 *
 * Accepts optional leaseId/leaseEpoch to update the effect's claimed-by
 * lease on reclaim.
 */
export async function reclaimEffect({ dir, effectId: id, leaseId, leaseEpoch }) {
  const { mkdir, open, rm } = await import('node:fs/promises');
  const reclaimLockDir = join(dir, 'effects', '.reclaim-locks');
  await mkdir(reclaimLockDir, { recursive: true });
  const lockPath = join(reclaimLockDir, `${id}.lock`);

  let lockHandle;
  try {
    lockHandle = await open(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') return { reclaimed: false, reason: 'concurrent_reclaim' };
    throw error;
  }

  try {
    // Re-read under lock to confirm still ABANDONED
    const current = await readEffect(dir, id);
    if (!current) throw new Error(`Effect not found: ${id}`);
    if (current.state !== 'ABANDONED') {
      return { reclaimed: false, reason: `not_abandoned:${current.state}` };
    }
    const effect = {
      ...current,
      state: 'CLAIMED',
      reclaimed_at: new Date().toISOString(),
      claimed_by_lease_id: leaseId || current.claimed_by_lease_id,
      claimed_by_lease_epoch: leaseEpoch ?? current.claimed_by_lease_epoch,
    };
    const { writeAtomic } = await import('./review-task-store.mjs');
    await writeAtomic(effectPath(dir, id), effect);
    return { reclaimed: true, effect };
  } finally {
    await lockHandle.close();
    try { await rm(lockPath, { force: true }); } catch { /* best-effort */ }
  }
}
