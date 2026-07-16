import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

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
 * Scan QUEUED and FIX_QUEUED tasks, atomically claim them within
 * concurrency limits, and dispatch by task.kind.  Returns the list
 * of tasks that were claimed and should be dispatched by the caller.
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

    // Concurrency gate
    const counts = await countActiveTasks({ dir, repository: task.repository, pr: task.pr });
    const concurrency = checkConcurrency({ counts, limits: task.policy?.concurrency || {} });
    if (!concurrency.allowed) continue;

    // Atomically claim
    const leaseEpoch = (task.lease?.lease_epoch || 0) + 1;
    const claimed = await claimTask({
      dir,
      id: task.id,
      instanceId,
      leaseId: randomUUID(),
      leaseEpoch,
    });
    if (!claimed.claimed) continue;

    // Transition to the right active state
    const activeState = task.kind === 'fix' ? 'FIXING' : 'RUNNING';
    const claimedTask = await transitionTask({
      dir,
      id: task.id,
      to: 'CLAIMED',
      reason: 'reconciler_claimed',
      patch: { lease: claimed.claim, attempt: (task.attempt || 0) + 1 },
    });
    const running = await transitionTask({
      dir,
      id: claimedTask.id,
      to: activeState,
      reason: 'reconciler_dispatched',
      patch: { started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() },
      leaseEpoch: claimed.claim.lease_epoch,
    });
    dispatched.push({ ...running, lease: claimed.claim });
  }

  return { dispatched: dispatched.length, tasks: dispatched };
}
