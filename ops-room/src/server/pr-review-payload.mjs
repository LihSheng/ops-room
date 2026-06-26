export function normalizeAgent(agent) {
  const key = String(agent || '').toLowerCase().trim();
  const aliases = { alpha: 'berlin', beta: 'tokyo' };
  return aliases[key] || key;
}

export function parseOpenAbCommand(commentBody) {
  const comment = String(commentBody || '');
  const firstLine = comment.split('\n')[0] || '';
  const parts = firstLine.trim().split(/\s+/);

  if (parts[0] !== '/openab') {
    return null;
  }

  const agent = normalizeAgent(parts[1]);
  if (!agent) {
    throw new Error('Missing agent name. Usage: /openab <agent> [--chat|--code] <task>');
  }

  let taskType = 'auto';
  if (comment.includes('--code')) taskType = 'code';
  else if (comment.includes('--chat')) taskType = 'chat';

  let task = comment
    .replace(/^\/openab\s+\S+\s*/i, '')
    .replace(/--(code|chat)\s*/g, '')
    .trim();

  if (!task) {
    task = 'Please review this pull request and respond based on the PR description, linked issue, and code changes.';
  }

  return { agent, task_type: taskType, task };
}

export function buildPrReviewPayload({ commentBody, repository, prNumber, commenter }) {
  const parsed = parseOpenAbCommand(commentBody);
  if (!parsed) return null;

  return {
    ...parsed,
    repository,
    pr: Number(prNumber),
    commenter: commenter || 'unknown',
    trigger: 'issue_comment',
  };
}

export function buildPrReviewPrompt({ agent, task, repository, pr, prTitle, prBody, prAuthor, baseRef, headRef, diff }) {
  const safeDiff = String(diff || '').slice(0, 50000);

  return `You are ${agent}, an OpenAB pull request review agent.

Repository: ${repository}
Pull request: #${pr}
Task: ${task}

PR title:
${prTitle || '(empty)'}

PR body:
${prBody || '(empty)'}

Author: ${prAuthor || '(unknown)'}
Base: ${baseRef || '(unknown)'}
Head: ${headRef || '(unknown)'}

Review requirements:
1. Check whether the implementation matches the PR description and linked issue.
2. Check whether the PR scope is small, focused, and reviewable.
3. Look for bugs, risky logic, regressions, missing validation, or security concerns.
4. Check whether tests/lint/build expectations are clear.
5. End with one final status: APPROVE, REQUEST_CHANGES, or NEEDS_HUMAN_DECISION.

Changed diff:
\`\`\`diff
${safeDiff || '(no diff available)'}
\`\`\`

Write a concise GitHub PR review comment. Do not claim to have run tests unless the PR or diff says so.`;
}
