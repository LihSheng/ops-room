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
    throw new Error('Missing agent name. Usage: /openab <agent> [--chat|--code] [--auto-fix] <task>');
  }

  let mode = comment.includes('--auto-fix') ? 'auto-fix' : 'review';

  let taskType = 'auto';
  if (comment.includes('--code')) taskType = 'code';
  else if (comment.includes('--chat')) taskType = 'chat';

  let task = comment
    .replace(/^\/openab\s+\S+\s*/i, '')
    .replace(/--(code|chat|auto-fix)\s*/g, '')
    .trim();

  if (!task) {
    task = 'Please review this pull request for correctness, security, maintainability, scope control, and test/build risk. Post one concise PR review comment with a final status.';
  }

  return { agent, task_type: taskType, task, mode };
}

export function buildPrReviewPayload({
  commentBody,
  repository,
  prNumber,
  commenter,
  commentId,
  headSha,
}) {
  const parsed = parseOpenAbCommand(commentBody);
  if (!parsed) return null;

  return {
    ...parsed,
    repository,
    pr: Number(prNumber),
    commenter: commenter || 'unknown',
    comment_id: commentId ? Number(commentId) : null,
    trigger: 'issue_comment',
    source: 'ops-room',
    head_sha: headSha || null,
  };
}

export function buildPrReviewPrompt({
  agent,
  task,
  repository,
  pr,
  prTitle,
  prBody,
  prAuthor,
  baseRef,
  headRef,
  headSha,
  mode = 'review',
  diff,
}) {
  const safeDiff = String(diff || '').slice(0, 50000);
  const safeMode = mode === 'auto-fix' ? 'auto-fix' : 'review';

  return `You are ${agent}, an OpenAB agent assigned to review this GitHub pull request.

Use the shared PR Review Skill for all review standards, checklist, severity rules, auto-fix rules, and output format.

Repository: ${repository}
Pull request: #${pr}
Author: ${prAuthor || '(unknown)'}
Base branch: ${baseRef || '(unknown)'}
Head branch: ${headRef || '(unknown)'}
Head commit: ${headSha || '(unknown)'}
Mode: ${safeMode}

Assigned task:
${task || 'Please review this pull request.'}

PR title:
${prTitle || '(empty)'}

PR body:
${prBody || '(empty)'}

Changed diff:
\`\`\`diff
${safeDiff || '(no diff available)'}
\`\`\`

Return ONLY valid JSON matching this schema; do not wrap it in Markdown:

{
  "summary": "brief review summary",
  "verdict": "APPROVE | REQUEST_CHANGES | NEEDS_HUMAN",
  "requires_human": false,
  "findings": [
    {
      "severity": "low | medium | high | critical",
      "file": "path relative to repository root",
      "line": 1,
      "title": "short finding title",
      "description": "what is wrong and why it matters",
      "suggestion": "smallest safe remediation",
      "auto_fixable": false
    }
  ]
}

Use APPROVE only when there are no blocking findings. Use REQUEST_CHANGES only when findings are present. Use NEEDS_HUMAN for ambiguous, security-critical, authorization, deployment, migration, or other findings that require maintainer judgment.
`;
}
