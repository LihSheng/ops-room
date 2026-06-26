#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_NAMES, POLL_AGENTS } from '../lib/config.mjs';
import { getTokenForAgent } from '../lib/github-app.mjs';
import { createGitHubOps } from '../lib/github-ops.mjs';
import { pollAgentIssues, startIssuePoller } from '../lib/issue-poller.mjs';
import { extractTask } from '../lib/task-routing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.OPENAB_REPO || 'LihSheng/LinkUp';
const POLL_INTERVAL_MS = parseInt(process.env.OPENAB_POLL_INTERVAL || '30', 10) * 1000;
const SHARED_MEMORY = process.env.OPENAB_SHARED_DIR
  ? join(process.env.OPENAB_SHARED_DIR, 'memory.md')
  : '/home/node/shared/memory.md';

function ts() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
}

function githubToken(agentKey) {
  return getTokenForAgent(agentKey, join(__dirname, 'github-app-token.mjs'));
}

const { addComment, ensureLabel, removeLabel, addLabel } = createGitHubOps({
  repo: REPO,
  tokenForAgent: githubToken,
  processEnv: process.env,
  logger: console,
});

function gh(args) {
  const isApi = args.startsWith('api ');
  const cmd = isApi ? `gh ${args}` : `gh ${args} --repo "${REPO}"`;
  try {
    const out = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  } catch (error) {
    const msg = error.stderr?.trim() || error.message;
    if (!msg.includes('not found') && !msg.includes('already exists')) {
      console.error(`[${ts()}] [poller] gh error: ${msg}`);
    }
    return null;
  }
}

async function listOpenIssuesForAgent(agentKey) {
  const raw = gh(`api repos/${REPO}/issues?labels=${encodeURIComponent(`openab/${agentKey}`)}&state=open&per_page=100&sort=created&direction=desc`);
  return Array.isArray(raw) ? raw.filter((issue) => !issue.pull_request || !issue.draft) : [];
}

function getComments(issueNumber) {
  const raw = gh(`api repos/${REPO}/issues/${issueNumber}/comments`);
  return Array.isArray(raw) ? raw.map((comment) => ({ body: comment.body, id: comment.id, user: comment.user?.login })) : [];
}

async function logToMemory(line) {
  try {
    await appendFile(SHARED_MEMORY, `- ${ts()}: [poller] ${line}\n`);
  } catch {}
}

async function handleTask(issueNumber, agentKey, issue) {
  const comments = getComments(issueNumber);
  const task = extractTask(comments, agentKey);
  const taskDesc = task?.task || issue.title;
  const commenter = task?.commenter || 'unknown';
  const agentName = AGENT_NAMES[agentKey] || agentKey;

  await logToMemory(`${agentName} claimed task from #${issueNumber} by @${commenter}: ${taskDesc}`);

  const lower = taskDesc.toLowerCase();
  if (lower.includes('say hi') || lower.includes('hello') || lower.includes('hi here') || lower.includes('ping')) {
    await addComment(
      issueNumber,
      `👋 Hi @${commenter}! ${agentName} here, responding live.

**Task**: ${taskDesc}
**Status**: Complete :white_check_mark:

Full pipeline verified:
1. \`/openab\` comment -> GitHub Action label
2. Poller detected -> claimed task
3. Agent responded automatically`,
      agentKey,
    );
    await removeLabel(issueNumber, `openab/${agentKey}/wip`);
    await addLabel(issueNumber, 'openab/done');
    await logToMemory(`${agentName} completed simple task on #${issueNumber}`);
    console.log(`[${ts()}] [poller] Completed simple task on #${issueNumber}`);
    return;
  }

  console.log(`[${ts()}] [poller] Claimed #${issueNumber} for ${agentKey} (task: ${taskDesc})`);
}

console.log(`[${ts()}] [poller] OpenAB poller started - checking every ${POLL_INTERVAL_MS / 1000}s for tasks on ${REPO}`);
console.log(`[${ts()}] [poller] Agents: ${POLL_AGENTS.join(', ')}`);

startIssuePoller({
  agentKeys: POLL_AGENTS,
  intervalMs: POLL_INTERVAL_MS,
  logger: console,
  pollAgent: (agentKey) => pollAgentIssues({
    agentKey,
    listOpenIssuesForAgent,
    ensureLabel,
    removeLabel,
    addLabel,
    addComment,
    handleTask,
    logger: console,
  }),
}).catch((error) => {
  console.error(`[${ts()}] [poller] Fatal:`, error);
  process.exit(1);
});
