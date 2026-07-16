import { randomUUID } from 'node:crypto';

import { claimTask, readTask, transitionTask } from '../services/review-task-store.mjs';

function stateForFixOutcome(outcome) {
  if (outcome === 'FIX_PUSHED') return 'FIX_PUSHED';
  if (outcome === 'SUPERSEDED') return 'SUPERSEDED';
  if (outcome === 'CANCELLED') return 'CANCELLED';
  if (outcome === 'NEEDS_HUMAN') return 'NEEDS_HUMAN';
  return 'ERROR';
}

export async function executeFixChildTask({ dir, id, instanceId, runWorker }) {
  const task = await readTask({ dir, id });
  if (!task) throw new Error(`Fix task not found: ${id}`);
  if (!['QUEUED', 'FIX_QUEUED'].includes(task.state)) return { state: task.state, deduplicated: true };

  const claimed = await claimTask({ dir, id, instanceId, leaseId: randomUUID(), leaseEpoch: (task.lease?.lease_epoch || 0) + 1 });
  if (!claimed.claimed) return { state: (await readTask({ dir, id }))?.state || 'CLAIMED', deduplicated: true };
  await transitionTask({ dir, id, to: 'CLAIMED', reason: 'fix_child_claimed', patch: { lease: claimed.claim, started_at: new Date().toISOString() } });
  await transitionTask({ dir, id, to: 'FIXING', reason: 'fix_child_started', patch: { heartbeat_at: new Date().toISOString() } });

  try {
    const result = await runWorker({ task: await readTask({ dir, id }), lease: claimed.claim });
    const state = stateForFixOutcome(result?.outcome);
    return transitionTask({ dir, id, to: state, reason: `fix_${String(result?.outcome || 'error').toLowerCase()}`, patch: { completed_at: new Date().toISOString(), result } });
  } catch (error) {
    const state = error?.name === 'FixSupersededError' ? 'SUPERSEDED' : 'ERROR';
    return transitionTask({ dir, id, to: state, reason: state === 'SUPERSEDED' ? 'fix_stale_sha' : 'fix_worker_error', patch: { completed_at: new Date().toISOString(), error: error?.message || String(error) } });
  }
}
