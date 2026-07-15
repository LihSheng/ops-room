import { claimEffect, completeEffect } from '../services/review-effect-ledger.mjs';

export class FixSupersededError extends Error {
  constructor(reviewedSha, currentSha) {
    super(`Fix task superseded: reviewed SHA ${reviewedSha} is not current SHA ${currentSha}`);
    this.name = 'FixSupersededError';
    this.reviewedSha = reviewedSha;
    this.currentSha = currentSha;
  }
}

export async function runFixChildWorker({ task, deps, dir }) {
  const reviewedSha = task?.reviewed_sha;
  const currentAtStart = await deps.fetchCurrentHead(task);
  assertFixHeadCurrent({ reviewedSha, currentSha: currentAtStart });

  let workspace;
  let heartbeatTimer;
  try {
    workspace = await deps.prepareWorkspace(task);
    const heartbeatIntervalMs = deps.heartbeatIntervalMs || 60_000;
    if (typeof deps.renewLease === 'function') {
      heartbeatTimer = setInterval(() => {
        deps.renewLease(task).catch((error) => console.error(`[fix-worker] lease heartbeat failed for ${task.id}:`, error?.message || error));
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }
    await deps.renewLease?.(task);
    const beforeApply = await deps.readTask?.(task);
    if (beforeApply?.state === 'CANCEL_REQUESTED' || beforeApply?.state === 'CANCELLED') {
      return { outcome: 'CANCELLED' };
    }
    const applied = await deps.applyFix({ task, workspace });
    await deps.renewLease?.(task);
    if (!applied?.changed) return { outcome: 'NEEDS_HUMAN', reason: 'no_source_changes' };

    const beforePush = await deps.fetchCurrentHead(task);
    assertFixHeadCurrent({ reviewedSha, currentSha: beforePush });
    const beforePushTask = await deps.readTask?.(task);
    if (beforePushTask?.state === 'CANCEL_REQUESTED' || beforePushTask?.state === 'CANCELLED') {
      return { outcome: 'CANCELLED' };
    }
    let pushEffect;
    if (dir) {
      pushEffect = await claimEffect({
        dir,
        taskId: task.id,
        kind: 'git_push',
        fingerprint: `${task.reviewed_sha}:${task.head_ref || ''}`,
      });
      if (!pushEffect.claimed) {
        if (pushEffect.effect?.state === 'COMPLETED' && pushEffect.effect.result?.new_sha) {
          return { outcome: 'FIX_PUSHED', new_sha: pushEffect.effect.result.new_sha, duplicate_effect: true };
        }
        return { outcome: 'NEEDS_HUMAN', reason: 'ambiguous_push_effect' };
      }
    }
    const pushed = await deps.pushWorkspace({ task, workspace });
    if (!pushed?.newSha) throw new Error('Fix push did not return a new SHA');
    if (pushEffect) await completeEffect({ dir, effectId: pushEffect.effect.id, result: { new_sha: pushed.newSha } });
    return { outcome: 'FIX_PUSHED', new_sha: pushed.newSha };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (workspace) await deps.cleanupWorkspace?.({ task, workspace });
  }
}

export function assertFixHeadCurrent({ reviewedSha, currentSha }) {
  if (!reviewedSha || !currentSha || reviewedSha !== currentSha) {
    throw new FixSupersededError(reviewedSha, currentSha);
  }
}
