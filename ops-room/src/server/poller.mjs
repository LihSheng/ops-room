#!/usr/bin/env node
/**
 * openab-poller - Background task poller for OpenAB
 *
 * Polls GitHub for issues with openab/<agent> labels every 30 seconds.
 * Claims new tasks and dispatches them.
 *
 * Start:  node openab-poller.mjs &
 * Stop:   pkill -f openab-poller.mjs
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.OPENAB_REPO || 'LihSheng/LinkUp';
const POLL_INTERVAL = parseInt(process.env.OPENAB_POLL_INTERVAL || '30', 10);
const SHARED_MEMORY = process.env.OPENAB_SHARED_DIR ? join(process.env.OPENAB_SHARED_DIR, 'memory.md') : '/home/node/shared/memory.md';

const AGENT_MAP = {
  alpha: { name: 'Berlin', id: '1518983231012208903' },
  beta: { name: 'Tokyo', id: '1518982568920355017' },
  professor: { name: 'Professor', id: '1518980056880517140' },
  berlin: { name: 'Berlin', id: '1518983231012208903' },
  tokyo: { name: 'Tokyo', id: '1518982568920355017' },
};

const GITHUB_APP_CONFIG = {
  professor: {
    appId: 'GITHUB_APP_ID',
    installationId: 'GITHUB_APP_INSTALLATION_ID',
    keyPath: 'GITHUB_APP_KEY_PATH',
    botUser: 'GITHUB_APP_BOT_USER',
  },
  berlin: {
    appId: 'GITHUB_APP_ID_BERLIN',
    installationId: 'GITHUB_APP_INSTALLATION_ID_BERLIN',
    keyPath: 'GITHUB_APP_KEY_PATH_BERLIN',
    botUser: 'GITHUB_APP_BOT_USER_BERLIN',
  },
  tokyo: {
    appId: 'GITHUB_APP_ID_TOKYO',
    installationId: 'GITHUB_APP_INSTALLATION_ID_TOKYO',
    keyPath: 'GITHUB_APP_KEY_PATH_TOKYO',
    botUser: 'GITHUB_APP_BOT_USER_TOKYO',
  },
};


function gh(args) {
  const isApi = args.startsWith('api ');
  const cmd = isApi ? `gh ${args}` : `gh ${args} --repo "${REPO}"`;
  try {
    const out = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
    try { return JSON.parse(out); } catch { return out; }
  } catch (e) {
    const msg = e.stderr?.trim() || e.message;
    if (!msg.includes('not found') && !msg.includes('already exists')) {
      console.error(`[poller] gh error: ${msg}`);
    }
    return null;
  }
}

function getIssuesByLabel(label) {
  const raw = gh(`issue list --label "${label}" --state open --json number,title,url,labels`);
  return Array.isArray(raw) ? raw : [];
}

function getComments(issueNumber) {
  const raw = gh(`api repos/${REPO}/issues/${issueNumber}/comments`);
  return Array.isArray(raw) ? raw.map(c => ({ body: c.body, id: c.id, user: c.user?.login })) : [];
}

function githubEnvForAgent(agentKey) {
  const cfg = GITHUB_APP_CONFIG[agentKey] || GITHUB_APP_CONFIG.professor;
  const appId = process.env[cfg.appId];
  const installationId = process.env[cfg.installationId];
  const keyPath = process.env[cfg.keyPath];
  const botUser = process.env[cfg.botUser];

  if (!appId || !installationId || !keyPath) {
    return null;
  }

  return {
    GITHUB_APP_ID: appId,
    GITHUB_APP_INSTALLATION_ID: installationId,
    GITHUB_APP_KEY_PATH: keyPath,
    GITHUB_APP_BOT_USER: botUser || 'bot',
  };
}

function addComment(issueNumber, body, agentKey = 'professor') {
  const tryPost = (key) => {
    const env = githubEnvForAgent(key);
    if (!env) throw new Error(`missing GitHub App config for ${key}`);
    const tokenResult = execFileSync(
      'node', [new URL('github-app-token.mjs', import.meta.url).pathname],
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...env } },
    ).trim();
    const token = JSON.parse(tokenResult).token;
    return execFileSync(
      'gh',
      ['api', `repos/${REPO}/issues/${issueNumber}/comments`, '-X', 'POST', '-f', `body=${body}`],
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GH_TOKEN: token } },
    ).trim();
  };
  try {
    return tryPost(agentKey);
  } catch (e) {
    const msg = e.stderr?.toString()?.trim() || e.message;
    if (agentKey !== 'professor' && (msg.includes('403') || msg.includes('Resource not accessible'))) {
      console.warn(`[poller] ${agentKey} token lacks comment permission, falling back to professor`);
      try { return tryPost('professor'); } catch (e2) {
        console.error(`[poller] addComment fallback also failed on #${issueNumber}:`, e2.stderr?.toString()?.trim() || e2.message);
      }
      return null;
    }
    console.error(`[poller] gh comment error: ${msg}`);
    return null;
  }
}

function removeLabel(issueNumber, label) {
  gh(`issue edit ${issueNumber} --remove-label "${label}"`);
}

function addLabel(issueNumber, label) {
  gh(`issue edit ${issueNumber} --add-label "${label}"`);
}

async function logToMemory(line) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
    await appendFile(SHARED_MEMORY, `- ${ts}: [poller] ${line}\n`);
  } catch {}
}

function findOpenabComment(comments) {
  return comments.find(c => c.body?.includes('<!-- openab-task'));
}

function parseTask(comments, agentKey) {
  const comment = findOpenabComment(comments);
  if (!comment) return null;
  const body = comment.body;
  const agentMatch = body.match(/agent:\s*(\S+)/);
  const taskMatch = body.match(/task:\s*(.+?)(?:\n|$)/);
  const commenterMatch = body.match(/commenter:\s*(\S+)/);
  return {
    agent: agentMatch?.[1] || agentKey,
    task: taskMatch?.[1]?.trim() || '',
    commenter: commenterMatch?.[1] || 'unknown',
  };
}

function ensureLabel(label) {
  gh(`api repos/${REPO}/labels -f name="${label}" -f color="fbca04" --silent 2>/dev/null`) || true;
}

async function poll() {
  for (const [agentKey, agentInfo] of Object.entries(AGENT_MAP)) {
    const issues = getIssuesByLabel(`openab/${agentKey}`);
    if (!issues.length) continue;

    for (const issue of issues) {
      const labels = issue.labels?.map(l => l.name) || [];
      const baseLabel = `openab/${agentKey}`;
      const wipLabel = `${baseLabel}/wip`;
      const hasPending = labels.includes(baseLabel) && !labels.includes(wipLabel);
      if (!hasPending) continue;

      console.log(`[poller] Found task for ${agentKey} on #${issue.number}: ${issue.title}`);

      const comments = getComments(issue.number);
      const task = parseTask(comments, agentKey);

      // Ensure /wip label exists before claiming
      ensureLabel(`${baseLabel}/wip`);

      // Mark as claimed
      removeLabel(issue.number, baseLabel);
      addLabel(issue.number, wipLabel);

      const taskDesc = task?.task || issue.title;
      const commenter = task?.commenter || 'unknown';

      // Log
      await logToMemory(`${agentInfo.name} claimed task from #${issue.number} by @${commenter}: ${taskDesc}`);

      // Post acknowledgment from the agent
      addComment(issue.number,
`**OpenAB / ${agentInfo.name}** — claimed and working :rocket:

> ${taskDesc}

Agent <@${agentInfo.id}> is on it.

---
*Task claimed automatically by OpenAB poller*`, agentKey);

      // Handle simple greeting tasks immediately for any agent
      const lower = taskDesc.toLowerCase();
      if (lower.includes('say hi') || lower.includes('hello') || lower.includes('hi here') || lower.includes('ping')) {
        addComment(issue.number,
`👋 Hi @${commenter}! ${agentInfo.name} here, responding live.

**Task**: ${taskDesc}
**Status**: Complete :white_check_mark:

Full pipeline verified:
1. \`/openab\` comment → GitHub Action label
2. Poller detected → claimed task
3. Agent responded automatically`, agentKey);
        removeLabel(issue.number, wipLabel);
        addLabel(issue.number, 'openab/done');
        await logToMemory(`${agentInfo.name} completed simple task on #${issue.number}`);
        console.log(`[poller] Completed simple task on #${issue.number}`);
      } else {
        console.log(`[poller] Claimed #${issue.number} for ${agentKey} (task: ${taskDesc})`);
      }
    }
  }
}

// Main loop
console.log(`[poller] OpenAB poller started — checking every ${POLL_INTERVAL}s for tasks on ${REPO}`);
console.log(`[poller] Agents: ${Object.keys(AGENT_MAP).join(', ')}`);

async function run() {
  while (true) {
    try {
      await poll();
    } catch (err) {
      console.error('[poller] Error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL * 1000));
  }
}

run().catch(err => {
  console.error('[poller] Fatal:', err);
  process.exit(1);
});
