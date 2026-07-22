import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_IDS, BOT_USERS, normalizeAgent } from '../lib/config.js';
import { REPO, REVIEW_TASKS_DIR, TASKS_DIR } from '../services/runtime-paths.js';
import { addIssueCommentReaction, listIssueCommentReactions, removeIssueCommentReaction } from '../services/github.js';
import { loadProcessedTasks, markTaskProcessed } from '../services/task-store.js';
import { appendToMemory } from './helpers.js';

let prReviewController = null;

export function configurePrReviewController(controller) {
  if (!controller || typeof controller.submit !== 'function') {
    throw new Error('PR review controller must provide submit()');
  }
  prReviewController = controller;
}

const inflightPrTasks = new Set();
const MANAGED_BOT_USERS = new Set(Object.values(BOT_USERS).map((user) => user.toLowerCase()));
const IN_PROGRESS_REACTION = 'eyes';
const SUCCESS_REACTION = 'rocket';
const FAILURE_REACTION = 'confused';

function isPrReviewWebhook(body) {
  return Boolean(
    body &&
    body.repository &&
    Number.isFinite(Number(body.pr))
  );
}

function sanitizeTaskIdPart(value, fallback = 'none') {
  const safe = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || fallback;
}

function buildPrTaskId({ pr, commentId, headSha, agent }) {
  return [
    'pr',
    Number(pr),
    'comment',
    sanitizeTaskIdPart(commentId, 'direct'),
    sanitizeTaskIdPart(headSha, 'no-sha'),
    sanitizeTaskIdPart(agent, 'agent'),
  ].join('-');
}

function taskFilePath(taskId) {
  return join(TASKS_DIR, `${taskId}.json`);
}

async function writeTaskEntry(taskEntry) {
  await writeFile(taskFilePath(taskEntry.id), JSON.stringify(taskEntry, null, 2));
}

async function findManagedReactionIds(commentId, content, agentKey) {
  const reactions = await listIssueCommentReactions(commentId, agentKey);
  return (Array.isArray(reactions) ? reactions : [])
    .filter((reaction) => reaction.content === content)
    .filter((reaction) => MANAGED_BOT_USERS.has(String(reaction.user?.login || '').toLowerCase()))
    .map((reaction) => reaction.id)
    .filter(Boolean);
}

async function ensureManagedReaction(commentId, content, agentKey) {
  if (!commentId) return;
  const existingIds = await findManagedReactionIds(commentId, content, agentKey);
  if (existingIds.length > 0) return;
  addIssueCommentReaction(commentId, content, agentKey);
}

async function clearManagedReaction(commentId, content, agentKey) {
  if (!commentId) return;
  const reactionIds = await findManagedReactionIds(commentId, content, agentKey);
  for (const reactionId of reactionIds) {
    removeIssueCommentReaction(commentId, reactionId, agentKey);
  }
}

async function safelyUpdateReaction(work, label) {
  try {
    await work();
  } catch (error) {
    const message = (error?.stderr && error.stderr.toString()) || error?.message || String(error);
    console.warn(`[pr-review] ${label} failed: ${message.slice(0, 200)}`);
  }
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

    if (!prReviewController) {
      throw new Error('PR review controller is not configured');
    }
    const result = await prReviewController.submit({
      ...body,
      agent: normalizedAgent,
      dir: REVIEW_TASKS_DIR,
      policy: body.policy || {},
    });
    return { ...result, agent: normalizedAgent };
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
