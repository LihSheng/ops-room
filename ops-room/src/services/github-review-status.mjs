import { claimEffect, completeEffect } from './review-effect-ledger.mjs';

export const REVIEW_STATUS_CONTEXT = 'OpenAB PR Review';

export function createGitHubReviewStatusService({ getCommitStatuses, createCommitStatus }) {
  if (typeof getCommitStatuses !== 'function') throw new Error('getCommitStatuses is required');
  if (typeof createCommitStatus !== 'function') throw new Error('createCommitStatus is required');

  async function set({ repository, sha, state, description, targetUrl, agent = 'professor', dir, taskId }) {
    const statuses = await getCommitStatuses({ repository, sha, agent });
    const latest = (Array.isArray(statuses) ? statuses : [])
      .find((status) => status.context === REVIEW_STATUS_CONTEXT);
    if (latest?.state === state && latest?.description === description) {
      return { written: false, status: latest };
    }

    const payload = {
      repository,
      sha,
      state,
      description,
      targetUrl,
      context: REVIEW_STATUS_CONTEXT,
      agent,
    };
    let effect;
    if (dir && taskId) {
      effect = await claimEffect({
        dir,
        taskId,
        kind: 'github_commit_status',
        fingerprint: `${sha}:${REVIEW_STATUS_CONTEXT}:${state}:${description}:${targetUrl || ''}`,
      });
      if (!effect.claimed) {
        // COMPLETED: silently reuse. CLAIMED: ambiguous — return explicit signal.
        if (effect.state === 'CLAIMED') {
          return { written: false, ambiguous_effect: true, effect: effect.effect };
        }
        if (effect.state === 'COMPLETED') {
          return { written: false, duplicate_effect: true, effect: effect.effect };
        }
        // ABANDONED: fall through to re-attempt.
      }
    }
    await createCommitStatus(payload);
    if (effect) await completeEffect({ dir, effectId: effect.effect.id, result: { sha, state, description, context: REVIEW_STATUS_CONTEXT } });
    return { written: true, status: payload };
  }

  return { set };
}
