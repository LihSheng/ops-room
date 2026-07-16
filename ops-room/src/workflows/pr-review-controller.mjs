import { randomUUID } from 'node:crypto';

import {
  claimTask,
  checkConcurrency,
  countActiveTasks,
  createOrClaimTask,
  readTask,
  transitionTask,
} from '../services/review-task-store.mjs';
import { evaluateAutoFixPolicy } from '../services/review-policy.mjs';

const REVIEW_CONTEXT = 'OpenAB PR Review';

function normalizeRequest(request) {
  const repository = String(request.repository || '').trim();
  const pr = Number(request.pr);
  const headSha = String(request.head_sha || request.headSha || '').trim();
  const agent = String(request.agent || '').trim();
  const requestedMode = request.mode === 'auto-fix' ? 'auto-fix' : 'review';
  const policy = request.policy || {};
  const autoFixPolicy = evaluateAutoFixPolicy({ requestedMode, policy });
  const mode = autoFixPolicy.allowed ? 'auto-fix' : 'review';

  if (!repository || !Number.isInteger(pr) || pr <= 0 || !headSha || !agent) {
    throw new Error('Invalid PR review request: repository, pr, head_sha, and agent are required');
  }

  return {
    repository,
    pr,
    headSha,
    agent,
    mode,
    trigger: request.trigger || 'unknown',
    policy: request.policy || {},
    taskType: request.task_type || request.taskType || 'review',
    commentId: request.comment_id || request.commentId || null,
  };
}

export function createPrReviewController({
  fetchPullRequest,
  setCommitStatus,
  dispatchReview,
  instanceId = `ops-room-${process.pid}`,
  clock = () => new Date(),
}) {
  if (typeof fetchPullRequest !== 'function') throw new Error('fetchPullRequest is required');
  if (typeof setCommitStatus !== 'function') throw new Error('setCommitStatus is required');
  if (typeof dispatchReview !== 'function') throw new Error('dispatchReview is required');

  async function submit(request) {
    const normalized = normalizeRequest(request);
    const prData = await fetchPullRequest({
      repository: normalized.repository,
      pr: normalized.pr,
      agent: normalized.agent,
    });
    const currentSha = prData?.head?.sha;

    if (prData?.state !== 'open') {
      return { status: 'CANCELLED', queued: false, reason: 'pr_closed' };
    }
    if (prData?.draft && !normalized.policy.allow_draft) {
      return { status: 'CANCELLED', queued: false, reason: 'draft_pr' };
    }
    if (!currentSha) throw new Error(`PR ${normalized.repository}#${normalized.pr} has no head SHA`);

    const { created, task } = await createOrClaimTask({
      dir: request.dir,
      input: {
        ...normalized,
        headSha: normalized.headSha,
        reviewedSha: normalized.headSha,
        taskType: normalized.taskType,
        commentId: normalized.commentId,
        task: request.task,
        commenter: request.commenter,
      },
      trigger: normalized.trigger,
      policy: normalized.policy,
    });

    if (currentSha !== normalized.headSha) {
      if (task.state === 'QUEUED') {
        await transitionTask({
          dir: request.dir,
          id: task.id,
          to: 'SUPERSEDED',
          reason: 'requested_sha_is_not_current_head',
          patch: { current_sha: currentSha, completed_at: clock().toISOString() },
        });
      }
      return {
        task_id: task.id,
        status: 'SUPERSEDED',
        queued: false,
        requested_sha: normalized.headSha,
        current_sha: currentSha,
      };
    }

    if (!created) {
      return {
        task_id: task.id,
        status: task.state,
        queued: false,
        deduplicated: true,
      };
    }

    // Concurrency gate: before claiming and dispatching, verify we are within
    // bounded concurrency limits. If limits are exceeded, leave the task queued
    // for later pickup by reconciliation.
    const counts = await countActiveTasks({ dir: request.dir, repository: normalized.repository, pr: normalized.pr });
    const concurrency = checkConcurrency({ counts, limits: request.policy?.concurrency || {} });
    if (!concurrency.allowed) {
      return {
        task_id: task.id,
        status: 'QUEUED',
        queued: true,
        reason: concurrency.reason,
        concurrency: counts,
      };
    }

    const leaseId = randomUUID();
    const claimed = await claimTask({
      dir: request.dir,
      id: task.id,
      instanceId,
      leaseId,
      leaseEpoch: 1,
    });
    if (!claimed.claimed) {
      const existing = await readTask({ dir: request.dir, id: task.id });
      return { task_id: task.id, status: existing?.state || 'CLAIMED', queued: false, deduplicated: true };
    }

    const running = await transitionTask({
      dir: request.dir,
      id: task.id,
      to: 'CLAIMED',
      reason: 'atomic_claim',
      patch: { attempt: 1, lease: claimed.claim },
    });
    await transitionTask({
      dir: request.dir,
      id: running.id,
      to: 'RUNNING',
      reason: 'review_dispatched',
      patch: { started_at: clock().toISOString(), heartbeat_at: clock().toISOString() },
    });

    await dispatchReview({
      task_id: task.id,
      lease: claimed.claim,
      dir: request.dir,
      task: request.task,
      commenter: request.commenter,
      ...normalized,
    });

    // Chat tasks must NOT write the canonical review pending status.
    if (normalized.taskType !== 'chat') {
      await setCommitStatus({
        repository: normalized.repository,
        sha: normalized.headSha,
        state: 'pending',
        description: 'Review in progress',
        targetUrl: request.target_url,
        context: REVIEW_CONTEXT,
        agent: normalized.agent,
        dir: request.dir,
        taskId: task.id,
      });
    }

    return { task_id: task.id, status: 'RUNNING', queued: true };
  }

  return { submit };
}

export { REVIEW_CONTEXT };
