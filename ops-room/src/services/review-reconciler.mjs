import { readdir, mkdir, open, rm, readFile } from 'node:fs/promises';
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
 * Acquire a short-lived concurrency reservation lock.  To prevent two
 * processes from both seeing available capacity and exceeding limits, we
 * acquire locks in hierarchy: global → repository → PR.  Each lock includes
 * metadata (PID + timestamp) so a crashed process's lock can be recovered.
 */
async function acquireSlotLock(dir, repository, pr) {
  const locksDir = join(dir, '.locks');
  await mkdir(locksDir, { recursive: true });
  const now = Date.now();
  const meta = JSON.stringify({ pid: process.pid, at: now });

  // Try locks in hierarchy order. If any can't be acquired, release all and retry later.
  const levels = [
    { key: 'global', path: join(locksDir, 'global.lock') },
    { key: `repo:${repository.replace(/\//g, '_')}`, path: join(locksDir, `repo_${repository.replace(/\//g, '_')}.lock`) },
    { key: `pr:${repository.replace(/\//g, '_')}:${pr}`, path: join(locksDir, `pr_${repository.replace(/\//g, '_')}_${pr}.lock`) },
  ];

  const acquired = [];
  const staleTimeoutMs = 120_000; // 2 min

  for (const level of levels) {
    try {
      const handle = await open(level.path, 'wx');
      await handle.writeFile(meta, 'utf-8');
      await handle.close();
      acquired.push(level.path);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        // Check if the lock is stale
        try {
          const content = JSON.parse(await readFile(level.path, 'utf-8'));
          const age = now - (content.at || 0);
          if (age > staleTimeoutMs) {
            // Stale lock — attempt recovery by replacing it
            try {
              const handle = await open(level.path, 'w');
              await handle.writeFile(meta, 'utf-8');
              await handle.close();
              acquired.push(level.path);
              continue;
            } catch { /* another process recovered it first */ }
          }
        } catch { /* corrupt lock file, try to claim */ }
        // Could not acquire this level — release all we have
        await releaseSlotLocks(acquired);
        return { acquired: false };
      }
      throw error;
    }
  }

  return { acquired: true, paths: acquired };
}

async function releaseSlotLocks(paths) {
  for (const p of paths) {
    try { await rm(p, { force: true }); } catch { /* best-effort */ }
  }
}

async function releaseSlotLock(result) {
  if (result?.paths) await releaseSlotLocks(result.paths);
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
    // claiming beyond the limit.  Locks are acquired in hierarchy: global →
    // repository → PR, with stale-lock recovery.
    const lock = await acquireSlotLock(dir, task.repository, task.pr);
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
      await releaseSlotLock(lock);
    }
  }

  return { dispatched: dispatched.length, tasks: dispatched };
}
