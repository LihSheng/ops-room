import { createOrClaimTask } from '../services/review-task-store.js';

export async function createFixChildTask({ dir, repository, pr, reviewedSha, parentTaskId, agent, policy = {}, reviewResult = null, headRef = null }) {
  if (!repository || !Number.isInteger(pr) || !reviewedSha || !parentTaskId || !agent) {
    throw new Error('Fix child requires repository, pr, reviewedSha, parentTaskId, and agent');
  }
  return createOrClaimTask({
    dir,
    kind: 'fix',
    trigger: 'review_changes_requested',
    parentTaskId,
    policy,
    input: { repository, pr, reviewedSha, agent: policy.fix_agent || agent, mode: 'auto-fix', review_result: reviewResult, headRef },
  });
}
