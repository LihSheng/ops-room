import { readdir, mkdir, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  countActiveTasks,
  checkConcurrency,
  readTask,
  claimTask,
  transitionTask,
  recoverStaleTask,
} from './review-task-store.mjs';

const ACTIVE_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);
const DISPATCHABLE_STATES = new Set(['QUEUED', 'FIX_QUEUED']);

export async function reconcileReviewTasks({ dir, now, staleMinutes = 30, retryLimit = 3 }) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { scanned: 0, recovered: [], re_dispatched: [] };
    throw error;
  }
  const ids = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  const recovered = [];
  const reDispatched = [];
  const corrupt = [];
  for (const id of ids) {
    let task;
    try {
      task = await readTask({ dir, id });
    } catch (error) {
      if (error instanceof SyntaxError) { corrupt.push(id); continue; }
      throw error;
    }
    if (!task || !ACTIVE_STATES.has(task.state)) continue;
    const result = await recoverStaleTask({ dir, id, now, staleMinutes, retryLimit });
    if (result.recovered) {
      recovered.push(id);
      if (result.re_dispatched) reDispatched.push(id);
    }
  }
  return { scanned: ids.length, recovered, re_dispatched: reDispatched, corrupt };
}

/**
 * Acquire a short-lived slot reservation lock.  Two processes that both see
 * available concurrency cannot both claim and exceed the limit because only
 * one can acquire the lock at a time.
 */
async function acquireSlotLock(dir, slotKey) {
  const locksDir = join(dir, '.locks');
  await mkdir(locksDir, { recursive: true });
  // Sanitize the slot key: replace '/' that would create nested directories.
  const safeKey = slotKey.replace(/\//g, '_');
  const lockPath = join(locksDir, `${safeKey}.lock`);
  try {
    const handle = await open(lockPath, 'wx');
    await handle.close();
    return { acquired: true, path: lockPath };
  } catch (error) {
    if (error?.code === 'EEXIST') return { acquired: false };
    throw error;
  }
}

async function releaseSlotLock(lockPath) {
  try { await rm(lockPath, { force: true }); } catch { /* best-effort */ }
}

/**
 * Scan QUEUED and FIX_QUEUED tasks, atomically claim them within
 * concurrency limits using a slot reservation lock, then dispatch by
 * task.kind.  Tasks are left in CLAIMED state with the lease attached;
 * the caller must pass the lease to the executor so it can own the
 * transition to RUNNING / FIXING and terminal states.
 *
 * This is the single durable dispatch path: it ensures queued work
 * does not stay stuck forever when concurrency frees up or after
 * operator retry / resume.
 */
export async function dispatchEligibleTasks({ dir, instanceId }) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { dispatched: 0, tasks: [] };
    throw error;
  }
  const ids = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));

  const dispatched = [];
  for (const id of ids) {
    let task;
    try {
      task = await readTask({ dir, id });
    } catch {
      continue; // skip corrupt
    }
    if (!task || !DISPATCHABLE_STATES.has(task.state)) continue;

    // Slot reservation prevents two processes from both seeing capacity and
    // claiming beyond the limit.
    const slotKey = `${task.kind}:${task.repository}:${task.pr}`;
    const lock = await acquireSlotLock(dir, slotKey);
    if (!lock.acquired) continue;

    try {
      // Re-read inside the lock to get accurate counts
      const counts = await countActiveTasks({ dir, repository: task.repository, pr: task.pr });
      const concurrency = checkConcurrency({ counts, limits: task.policy?.concurrency || {} });
      if (!concurrency.allowed) continue;

      const leaseEpoch = (task.lease?.lease_epoch || 0) + 1;
      const claimed = await claimTask({
        dir,
        id: task.id,
        instanceId,
        leaseId: randomUUID(),
        leaseEpoch,
      });
      if (!claimed.claimed) continue;

      // Transition to CLAIMED — the caller's executor will move to RUNNING/FIXING.
      // Only increment attempt once (the CLAIMED transition sets it; no second
      // increment in the RUNNING transition).
      const claimedTask = await transitionTask({
        dir,
        id: task.id,
        to: 'CLAIMED',
        reason: 'reconciler_claimed',
        patch: { lease: claimed.claim, attempt: (task.attempt || 0) + 1, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() },
      });
      dispatched.push({ ...claimedTask, lease: claimed.claim });
    } finally {
      await releaseSlotLock(lock.path);
    }
  }

  return { dispatched: dispatched.length, tasks: dispatched };
}
