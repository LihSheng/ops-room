export const REVIEW_STATUS_CONTEXT = 'OpenAB PR Review';

export function createGitHubReviewStatusService({ getCommitStatuses, createCommitStatus }) {
  if (typeof getCommitStatuses !== 'function') throw new Error('getCommitStatuses is required');
  if (typeof createCommitStatus !== 'function') throw new Error('createCommitStatus is required');

  async function set({ repository, sha, state, description, targetUrl, agent = 'professor' }) {
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
    await createCommitStatus(payload);
    return { written: true, status: payload };
  }

  return { set };
}
