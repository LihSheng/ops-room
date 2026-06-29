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
import { handleHealth } from '../routes/health.mjs';
import { handleTaskDetail, handleTasksList } from '../routes/tasks.mjs';
import { handleLogsList } from '../routes/logs.mjs';
import { handleWebhook, isPrReviewWebhook } from '../routes/webhook-routes.mjs';
import { handleAgentsList } from '../routes/agents.mjs';
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

// ── Start ───────────────────────────────────────────────────────────────────

console.log(`[server] version: ${OPENAB_SERVER_VERSION}`);

if (!WEBHOOK_SECRET) {
  throw new Error('Missing OPENAB_WEBHOOK_SECRET. Refusing to start webhook server without an explicit bearer secret.');
}

await initDirs();
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
server.listen(PORT, () => {
  console.log(`OpenAB webhook listening on http://0.0.0.0:${PORT}`);
  console.log(`  POST /webhook   - Receive issue commands`);
  console.log(`  GET  /tasks      - List pending tasks`);
  console.log(`  GET  /health     - Health check`);
  console.log(`  GET  /api/health  - Detailed health`);
  console.log(`  GET  /api/tasks   - List tasks`);
  console.log(`  GET  /api/logs    - List bounded redacted logs`);
  console.log(`  GET  /api/agents  - List agents`);
  console.log(`  WORKSPACE_BASE   - ${WORKSPACE_BASE}`);
});
