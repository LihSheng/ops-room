export class FixSupersededError extends Error {
  constructor(reviewedSha, currentSha) {
    super(`Fix task superseded: reviewed SHA ${reviewedSha} is not current SHA ${currentSha}`);
    this.name = 'FixSupersededError';
    this.reviewedSha = reviewedSha;
    this.currentSha = currentSha;
  }
}

export async function runFixChildWorker({ task, deps }) {
  const reviewedSha = task?.reviewed_sha;
  const currentAtStart = await deps.fetchCurrentHead(task);
  assertFixHeadCurrent({ reviewedSha, currentSha: currentAtStart });

  let workspace;
  try {
    workspace = await deps.prepareWorkspace(task);
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
    const pushed = await deps.pushWorkspace({ task, workspace });
    if (!pushed?.newSha) throw new Error('Fix push did not return a new SHA');
    return { outcome: 'FIX_PUSHED', new_sha: pushed.newSha };
  } finally {
    if (workspace) await deps.cleanupWorkspace?.({ task, workspace });
  }
}

export function assertFixHeadCurrent({ reviewedSha, currentSha }) {
  if (!reviewedSha || !currentSha || reviewedSha !== currentSha) {
    throw new FixSupersededError(reviewedSha, currentSha);
  }
}
