import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_IDS, normalizeAgent } from '../lib/config.mjs';
import { REPO, TASKS_DIR, SHARED_MEMORY } from '../services/runtime-paths.mjs';
import { appendToMemory } from './helpers.mjs';
import { runPrReviewWorkflow } from '../workflows/pr-review.mjs';

function isPrReviewWebhook(body) {
  return Boolean(
    body &&
    body.repository &&
    Number.isFinite(Number(body.pr))
  );
}

export async function handleWebhook(body) {
  if (body.repository !== REPO) {
    throw new Error(`Unsupported repository: ${body.repository}. Expected ${REPO}`);
  }

  if (isPrReviewWebhook(body)) {
    const normalizedAgent = normalizeAgent(body.agent);
    if (!AGENT_IDS[normalizedAgent]) {
      throw new Error(`Unknown agent for PR review: ${body.agent}`);
    }

    return runPrReviewWorkflow({
      agent: normalizedAgent,
      task: body.task || 'Please review this pull request and respond based on the PR description, linked issue, and code changes.',
      repository: body.repository,
      pr: Number(body.pr),
      commenter: body.commenter || 'unknown',
    });
  }

  const { agent, task, repository, issue_number, issue_title, issue_url, commenter } = body;
  const normalizedAgent = normalizeAgent(agent);
  const agentId = AGENT_IDS[normalizedAgent];
  const agentName = agentId ? normalizedAgent : 'unassigned';
  const taskEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'github_issue', received_at: new Date().toISOString(),
    agent: agentName, task, repository, issue_number, issue_title, issue_url, commenter, status: 'pending',
    task_type: body.task_type || 'auto',
    trigger: body.trigger || 'manual',
    pr: body.pr ? Number(body.pr) : null,
  };
  await writeFile(join(TASKS_DIR, `${taskEntry.id}.json`), JSON.stringify(taskEntry, null, 2));
  await appendToMemory(`Task from ${repository}#${issue_number} by @${commenter} → **${agentName}**: ${task}`);
  return { id: taskEntry.id, agent: agentName };
}

export { isPrReviewWebhook };
