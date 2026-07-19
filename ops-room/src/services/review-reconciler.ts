import { mkdir, open, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  countActiveTasks,
  checkConcurrency,
  claimTask,
  transitionTask,
  recoverStaleTask,
  scanReviewTasks,
} from './review-task-store.js';

const ACTIVE_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);
const DISPATCHABLE_STATES = new Set(['QUEUED', 'FIX_QUEUED']);

export async function reconcileReviewTasks({ dir, now, staleMinutes = 30, retryLimit = 3 }) {
  const { scanned, tasks, corrupt } = await scanReviewTasks({ dir });
  const recovered = [];
  const reDispatched = [];
  for (const task of tasks) {
    if (!ACTIVE_STATES.has(task.state)) continue;
    const result = await recoverStaleTask({ dir, id: task.id, now, staleMinutes, retryLimit });
    if (result.recovered) {
      recovered.push(task.id);
      if (result.re_dispatched) reDispatched.push(task.id);
    }
  }
  return { scanned, recovered, re_dispatched: reDispatched, corrupt };
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

  const levels = [
    { key: 'global', path: join(locksDir, 'global.lock') },
    { key: `repo:${repository.replace(/\//g, '_')}`, path: join(locksDir, `repo_${repository.replace(/\//g, '_')}.lock`) },
    { key: `pr:${repository.replace(/\//g, '_')}:${pr}`, path: join(locksDir, `pr_${repository.replace(/\//g, '_')}_${pr}.lock`) },
  ];
  const acquired = [];
  const staleTimeoutMs = 120_000;

  for (const level of levels) {
    try {
      const handle = await open(level.path, 'wx');
      await handle.writeFile(meta, 'utf-8');
      await handle.close();
      acquired.push(level.path);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        try {
          const content = JSON.parse(await readFile(level.path, 'utf-8'));
          const age = now - (content.at || 0);
          if (age > staleTimeoutMs) {
            try {
              await rm(level.path, { force: true });
              const handle = await open(level.path, 'wx');
              await handle.writeFile(meta, 'utf-8');
              await handle.close();
              acquired.push(level.path);
              continue;
            } catch { }
          }
        } catch { }
        await releaseSlotLocks(acquired);
        return { acquired: false };
      }
      throw error;
    }
  }
  return { acquired: true, paths: acquired };
}

async function releaseSlotLocks(paths) {
  for (const path of paths) {
    try { await rm(path, { force: true }); } catch { }
  }
}

async function releaseSlotLock(result) {
  if (result?.paths) await releaseSlotLocks(result.paths);
}

async function dispatchAllowed(canDispatchAgent, agent) {
  try {
    return await canDispatchAgent(agent) !== false;
  } catch {
    return false;
  }
}

/**
 * Scan QUEUED and FIX_QUEUED tasks, atomically claim them within
 * concurrency limits using a slot reservation lock, then dispatch by
 * task.kind. Tasks are left in CLAIMED state with the lease attached.
 */
export async function dispatchEligibleTasks({
  dir,
  instanceId,
  canDispatchAgent = async () => true,
}) {
  const { tasks } = await scanReviewTasks({ dir });
  const dispatched = [];
  for (const task of tasks) {
    if (!DISPATCHABLE_STATES.has(task.state)) continue;
    if (!(await dispatchAllowed(canDispatchAgent, task.agent))) continue;

    const lock = await acquireSlotLock(dir, task.repository, task.pr);
    if (!lock.acquired) continue;

    try {
      if (!(await dispatchAllowed(canDispatchAgent, task.agent))) continue;
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

      const claimedTask = await transitionTask({
        dir,
        id: task.id,
        to: 'CLAIMED',
        reason: 'reconciler_claimed',
        patch: {
          lease: claimed.claim,
          attempt: (task.attempt || 0) + 1,
          started_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
        },
      });
      dispatched.push({ ...claimedTask, lease: claimed.claim });
    } finally {
      await releaseSlotLock(lock);
    }
  }
  return { dispatched: dispatched.length, tasks: dispatched };
}
