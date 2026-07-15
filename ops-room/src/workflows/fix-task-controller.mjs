import { createOrClaimTask } from '../services/review-task-store.mjs';

export async function createFixChildTask({ dir, repository, pr, reviewedSha, parentTaskId, agent, policy = {} }) {
  if (!repository || !Number.isInteger(pr) || !reviewedSha || !parentTaskId || !agent) {
    throw new Error('Fix child requires repository, pr, reviewedSha, parentTaskId, and agent');
  }
  return createOrClaimTask({
    dir,
    kind: 'fix',
    trigger: 'review_changes_requested',
    parentTaskId,
    policy,
    input: { repository, pr, reviewedSha, agent, mode: 'auto-fix' },
  });
}
