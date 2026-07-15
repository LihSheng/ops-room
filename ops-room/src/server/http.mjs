import { createServer } from 'node:http';
import { execSync } from 'node:child_process';

import { POLL_AGENTS } from '../lib/config.mjs';
import { pollAgentIssues, startIssuePoller } from '../lib/issue-poller.mjs';
import {
  REPO, PORT, WEBHOOK_SECRET, WORKSPACE_BASE,
  OPENAB_SERVER_VERSION
} from '../services/runtime-paths.mjs';
import { initDirs } from '../services/task-store.mjs';
import '../services/logs.mjs';
import {
  addComment, ensureLabel, removeLabel, addLabel
} from '../services/github.mjs';
import { handleTask, cancelTask } from '../workflows/github-code.mjs';
import { runPrReviewWorkflow } from '../workflows/pr-review.mjs';
import { ensureReviewLoopDir } from '../services/review-loop-store.mjs';
import { handleHealth } from '../routes/health.mjs';
import { handleTaskDetail, handleTasksList } from '../routes/tasks.mjs';
import { handleLogsList } from '../routes/logs.mjs';
import { handleWebhook, isPrReviewWebhook } from '../routes/webhook-routes.mjs';
import { handleAgentsList } from '../routes/agents.mjs';
import { handleOpenABInstances } from '../routes/openab-instances.mjs';
import { handleStaticApp } from '../routes/static-app.mjs';
import { sendJSON, verifyAuth, parseBody } from '../routes/helpers.mjs';

// ── Server ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  res.setHeader('X-Powered-By', 'OpenAB Webhook');
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health
  if (req.method === 'GET' && pathname === '/health') {
    sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  // API Health
  if (req.method === 'GET' && pathname === '/api/health') {
    try {
      const data = await handleHealth();
      sendJSON(res, 200, data);
    } catch { sendJSON(res, 500, { status: 'error' }); }
    return;
  }

  // Tasks (legacy) and task detail
  if (req.method === 'GET' && pathname.startsWith('/tasks')) {
    const auth = req.headers['authorization'];
    if (!verifyAuth(auth)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    const taskIdMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    if (taskIdMatch) {
      try {
        const data = await handleTaskDetail(decodeURIComponent(taskIdMatch[1]));
        if (!data) { sendJSON(res, 404, { error: 'Task not found' }); return; }
        sendJSON(res, 200, data);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return;
    }
    try {
      const data = await handleTasksList();
      sendJSON(res, 200, data);
    } catch { sendJSON(res, 200, { tasks: [] }); }
    return;
  }

  // API Tasks
  if (req.method === 'GET' && pathname === '/api/tasks') {
    try {
      const data = await handleTasksList();
      sendJSON(res, 200, data);
    } catch { sendJSON(res, 200, { tasks: [] }); }
    return;
  }

  const taskDetailMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && taskDetailMatch) {
    try {
      const data = await handleTaskDetail(decodeURIComponent(taskDetailMatch[1]));
      if (!data) {
        sendJSON(res, 404, { error: 'Task not found' });
      } else {
        sendJSON(res, 200, data);
      }
    } catch (err) { sendJSON(res, 500, { error: err.message }); }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    try {
      const data = await handleLogsList(searchParams);
      sendJSON(res, 200, data);
    } catch (err) { sendJSON(res, 500, { error: err.message }); }
    return;
  }

  // API Agents
  if (req.method === 'GET' && pathname === '/api/agents') {
    try {
      const data = await handleAgentsList();
      sendJSON(res, 200, data);
    } catch (err) { sendJSON(res, 500, { error: err.message }); }
    return;
  }

  // API OpenAB Instances
  if (req.method === 'GET' && pathname === '/api/openab/instances') {
    try {
      const data = await handleOpenABInstances();
      sendJSON(res, 200, data);
    } catch (err) { sendJSON(res, 500, { error: err.message }); }
    return;
  }

  // Webhook POST
  if (req.method === 'POST' && pathname === '/webhook') {
    const auth = req.headers['authorization'];
    if (!verifyAuth(auth)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const body = await parseBody(req);
      const hasIssuePayload = body.repository && body.issue_number;
      const hasPrPayload = isPrReviewWebhook(body);
      if (!hasIssuePayload && !hasPrPayload) {
        sendJSON(res, 400, { error: 'Missing required fields' });
        return;
      }
      const result = await handleWebhook(body);
      const targetNumber = body.issue_number || body.pr;
      console.log(`[openab] Received: ${body.repository}#${targetNumber} → ${result.agent}: ${body.task}`);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) { sendJSON(res, 400, { error: err.message }); }
    return;
  }

  // Static App (Dashboard)
  if (req.method === 'GET') {
    const served = handleStaticApp(req, res, pathname);
    if (served) return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

// ── Poller ──────────────────────────────────────────────────────────────────

async function listOpenIssuesForAgent(agentKey) {
  const seen = new Set();
  const results = [];
  const labelQueries = [`openab/${agentKey}`, 'openab/cancel'];
  for (const labelQuery of labelQueries) {
    try {
      const out = execSync(
        `gh api repos/${REPO}/issues?labels=${encodeURIComponent(labelQuery)}&state=open&per_page=100&sort=created&direction=desc`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
      );
      const issues = JSON.parse(out).filter(i => !i.pull_request || !i.draft);
      for (const issue of issues) {
        if (!seen.has(issue.number)) {
          seen.add(issue.number);
          results.push(issue);
        }
      }
    } catch {}
  }
  return results;
}

// ── PR Review Auto-Detection Poller ──────────────────────────────────────────
//
// Detects PRs with openab/pr-created label (created by coding agents) that
// do NOT yet have openab/review-approved, and auto-starts a review by Professor.
// This closes the loop: coding agent creates PR → auto-review triggers.

async function listUnreviewedPRs() {
  try {
    const out = execSync(
      `gh api repos/${REPO}/pulls?state=open&per_page=50&sort=updated&direction=desc`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    return JSON.parse(out).filter(pr => !pr.draft);
  } catch {
    return [];
  }
}

async function pollUnreviewedPRs() {
  const reviewAgent = 'professor';
  const prs = await listUnreviewedPRs();
  if (!prs?.length) return;

  for (const pr of prs) {
    try {
      // Get labels for this PR (issues API works for PRs too)
      const labelsOut = execSync(
        `gh api repos/${REPO}/issues/${pr.number} --jq '.labels[].name'`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
      );
      const labelNames = labelsOut.trim().split('\n').filter(Boolean);

      // Only auto-review PRs created by our coding agents (labeled openab/pr-created)
      if (!labelNames.includes('openab/pr-created')) continue;
      // Skip if already reviewed or in review
      if (labelNames.includes('openab/review-approved')) continue;
      if (labelNames.includes('openab/review-loop')) continue;
      if (labelNames.includes('openab/needs-human')) continue;
      if (labelNames.includes(`openab/${reviewAgent}/wip`)) continue;

      console.log(`[pr-poller] Unreviewed coding PR detected: #${pr.number} — ${pr.title}`);

      // Add review-pending label
      await ensureLabel('openab/review-pending', 'c5def5');
      await ensureLabel('openab/review-loop', 'bfdadc');
      await addLabel(pr.number, 'openab/review-pending');
      await addLabel(pr.number, 'openab/review-loop');

      await addComment(
        pr.number,
        `**OpenAB / Professor** — auto-review triggered 🤖\n\nThis PR was created by a coding agent. I'll review it automatically.\n\nMode: \`auto-fix\` — if issues are found, I'll attempt to fix them.`,
        reviewAgent,
      );

      // Run the review with auto-fix mode
      await runPrReviewWorkflow({
        agent: reviewAgent,
        repository: REPO,
        pr: pr.number,
        task_type: 'review',
        mode: 'auto-fix',
        task: 'Review this pull request for correctness, security, maintainability, and test/build risk. If issues are found, they will be auto-fixed. Use structured output with ## Issues Found section.',
        commenter: 'auto-poller',
      });

      console.log(`[pr-poller] Auto-review completed for #${pr.number}`);
    } catch (error) {
      const msg = error?.message || String(error);
      console.error(`[pr-poller] Error reviewing PR #${pr.number}:`, msg.slice(0, 300));
    }
  }
}

// Run the PR review poller every 60 seconds alongside the issue poller
async function startPrReviewPoller() {
  while (true) {
    try {
      await pollUnreviewedPRs();
    } catch (error) {
      console.error('[pr-poller] cycle error:', error?.message);
    }
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

console.log(`[server] version: ${OPENAB_SERVER_VERSION}`);

if (!WEBHOOK_SECRET) {
  throw new Error('Missing OPENAB_WEBHOOK_SECRET. Refusing to start webhook server without an explicit bearer secret.');
}

await initDirs();
await ensureReviewLoopDir();
startIssuePoller({
  agentKeys: POLL_AGENTS,
  intervalMs: 30_000,
  pollAgent: (agentKey) => pollAgentIssues({
    agentKey,
    listOpenIssuesForAgent,
    ensureLabel,
    removeLabel,
    addLabel,
    addComment,
    handleTask,
    cancelTask,
  }),
}).catch((e) => console.error('[server] poller fatal:', e.message));
startPrReviewPoller().catch((e) => console.error('[server] pr-poller fatal:', e.message));
server.listen(PORT, () => {
  console.log(`OpenAB webhook listening on http://0.0.0.0:${PORT}`);
  console.log(`  POST /webhook   - Receive issue commands`);
  console.log(`  GET  /tasks      - List pending tasks`);
  console.log(`  GET  /health     - Health check`);
  console.log(`  GET  /api/health  - Detailed health`);
  console.log(`  GET  /api/tasks   - List tasks`);
  console.log(`  GET  /api/logs    - List bounded redacted logs`);
  console.log(`  GET  /api/agents  - List agents`);
  console.log(`  GET  /api/openab/instances - OpenAB instance dashboard`);
  console.log(`  WORKSPACE_BASE   - ${WORKSPACE_BASE}`);
});
