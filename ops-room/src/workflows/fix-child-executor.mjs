import { randomUUID } from 'node:crypto';

import { claimTask, readTask, transitionTask } from '../services/review-task-store.mjs';

function stateForFixOutcome(outcome) {
  if (outcome === 'FIX_PUSHED') return 'FIX_PUSHED';
  if (outcome === 'SUPERSEDED') return 'SUPERSEDED';
  if (outcome === 'CANCELLED') return 'CANCELLED';
  if (outcome === 'NEEDS_HUMAN') return 'NEEDS_HUMAN';
  return 'ERROR';
}

/**
 * Execute a fix child task.  Accepts an optional pre-claimed lease so the
 * durable dispatcher can atomically claim within concurrency limits and pass
 * ownership to this executor without a second claim+transition cycle.
 */
export async function executeFixChildTask({ dir, id, instanceId, runWorker, preClaimedLease }) {
  const task = await readTask({ dir, id });
  if (!task) throw new Error(`Fix task not found: ${id}`);

  let lease;
  if (preClaimedLease) {
    // Dispatcher already claimed and transitioned the task to CLAIMED (or
    // FIXING for a stale-recovered task).  Accept the lease if it matches.
    if (!['CLAIMED', 'FIXING', 'QUEUED', 'FIX_QUEUED'].includes(task.state)) {
      return { state: task.state, deduplicated: true };
    }
    lease = preClaimedLease;
  } else {
    // Fresh execution: claim the task ourselves.
    if (!['QUEUED', 'FIX_QUEUED'].includes(task.state)) {
      return { state: task.state, deduplicated: true };
    }
    const claimed = await claimTask({
      dir, id, instanceId, leaseId: randomUUID(),
      leaseEpoch: (task.lease?.lease_epoch || 0) + 1,
    });
    if (!claimed.claimed) {
      return { state: (await readTask({ dir, id }))?.state || 'CLAIMED', deduplicated: true };
    }
    lease = claimed.claim;
    await transitionTask({ dir, id, to: 'CLAIMED', reason: 'fix_child_claimed', patch: { lease, started_at: new Date().toISOString() } });
  }

  // Transition to FIXING if not already there (reconciler may have done it)
  if (task.state !== 'FIXING') {
    await transitionTask({ dir, id, to: 'FIXING', reason: 'fix_child_started', patch: { heartbeat_at: new Date().toISOString() }, leaseEpoch: lease.lease_epoch });
  }

  try {
    const result = await runWorker({ task: await readTask({ dir, id }), lease });
    const state = stateForFixOutcome(result?.outcome);
    return transitionTask({ dir, id, to: state, reason: `fix_${String(result?.outcome || 'error').toLowerCase()}`, patch: { completed_at: new Date().toISOString(), result }, leaseEpoch: lease.lease_epoch });
  } catch (error) {
    const state = error?.name === 'FixSupersededError' ? 'SUPERSEDED' : 'ERROR';
    return transitionTask({ dir, id, to: state, reason: state === 'SUPERSEDED' ? 'fix_stale_sha' : 'fix_worker_error', patch: { completed_at: new Date().toISOString(), error: error?.message || String(error) }, leaseEpoch: lease.lease_epoch });
  }
}
