import { createServer } from 'node:http';
import { execSync } from 'node:child_process';

import { POLL_AGENTS } from '../lib/config.mjs';
import { pollAgentIssues, startIssuePoller } from '../lib/issue-poller.mjs';
import {
  REPO, PORT, WEBHOOK_SECRET, WORKSPACE_BASE, REVIEW_TASKS_DIR,
  OPENAB_SERVER_VERSION
} from '../services/runtime-paths.mjs';
import { initDirs } from '../services/task-store.mjs';
import '../services/logs.mjs';
import {
  addComment, ensureLabel, removeLabel, addLabel, getCommitStatuses, createCommitStatus, ghApi
} from '../services/github.mjs';
import { handleTask, cancelTask } from '../workflows/github-code.mjs';
import { runPrReviewWorkflow } from '../workflows/pr-review.mjs';
import { ensureReviewLoopDir } from '../services/review-loop-store.mjs';
import { createGitHubReviewStatusService } from '../services/github-review-status.mjs';
import { listReviewTasks, readTask, renewClaim, requestCancellation, transitionTask } from '../services/review-task-store.mjs';
import { createPrReviewController } from '../workflows/pr-review-controller.mjs';
import { createFixChildTask } from '../workflows/fix-task-controller.mjs';
import { reconcileReviewTasks } from '../services/review-reconciler.mjs';
import { commitStatusForReviewEvent, taskStateForReviewEvent } from '../workflows/review-outcome.mjs';
import { executeFixChildTask } from '../workflows/fix-child-executor.mjs';
import { runFixChildWorker } from '../workflows/fix-worker.mjs';
import { createFixRuntimeDeps } from '../workflows/fix-runtime.mjs';
import { handleHealth } from '../routes/health.mjs';
import { handleTaskDetail, handleTasksList } from '../routes/tasks.mjs';
import { handleLogsList } from '../routes/logs.mjs';
import { configurePrReviewController, handleWebhook, isPrReviewWebhook } from '../routes/webhook-routes.mjs';
import { handleAgentsList } from '../routes/agents.mjs';
import { handleOpenABInstances } from '../routes/openab-instances.mjs';
import { handleStaticApp } from '../routes/static-app.mjs';
import { sendJSON, verifyAuth, parseBody } from '../routes/helpers.mjs';

const reviewStatus = createGitHubReviewStatusService({
  getCommitStatuses: async ({ sha, agent }) => getCommitStatuses(sha, agent),
  createCommitStatus: async ({ sha, state, description, targetUrl, context, agent }) => createCommitStatus({
    sha,
    state,
    description,
    targetUrl,
    context,
    agentKey: agent,
  }),
});

async function executeControllerFix({ dir, taskId }) {
  const deps = createFixRuntimeDeps({ taskDir: dir, renewClaim, readTask });
  return executeFixChildTask({
    dir,
    id: taskId,
    instanceId: `ops-room-${process.pid}`,
    runWorker: ({ task }) => runFixChildWorker({ task, deps }),
  });
}

async function executeControllerReview(task) {
  try {
    const result = await runPrReviewWorkflow({
      agent: task.agent,
      task: task.task,
      task_type: task.taskType,
      repository: task.repository,
      pr: task.pr,
      commenter: task.commenter || 'controller',
      comment_id: task.commentId,
      // Auto-fix remains disabled until the separate child-task workflow exists.
      mode: 'review',
      head_sha: task.headSha,
      task_id: task.task_id,
      dir: task.dir,
    });
    const status = commitStatusForReviewEvent(result.review_event);
    const state = taskStateForReviewEvent(result.review_event);
    const terminalTask = await transitionTask({
      dir: task.dir,
      id: task.task_id,
      to: state,
      reason: `review_${String(result.review_event || 'unknown').toLowerCase()}`,
      patch: { completed_at: new Date().toISOString(), result },
    });
    if (state === 'CHANGES_REQUESTED' && task.mode === 'auto-fix') {
      const child = await createFixChildTask({
        dir: task.dir,
        repository: task.repository,
        pr: task.pr,
        reviewedSha: task.headSha,
        parentTaskId: task.task_id,
        agent: task.agent,
        policy: task.policy,
        reviewResult: result.structured_review,
        headRef: result.head_ref || null,
      });
      await transitionTask({
        dir: task.dir,
        id: terminalTask.id,
        to: 'FIX_QUEUED',
        reason: child.created ? 'fix_child_created' : 'fix_child_deduplicated',
        patch: { fix_child_task_id: child.task.id },
      });
      setImmediate(() => {
        executeControllerFix({ dir: task.dir, taskId: child.task.id })
          .catch((error) => console.error('[fix-child-controller] unhandled execution error:', error));
      });
    }
    await reviewStatus.set({
      repository: task.repository,
      sha: task.headSha,
      state: status.state,
      description: status.description,
      agent: task.agent,
    });
  } catch (error) {
    const message = error?.message || String(error);
    if (error?.code === 'REVIEW_CANCELLED') {
      await transitionTask({
        dir: task.dir,
        id: task.task_id,
        to: 'CANCELLED',
        reason: 'worker_acknowledged_cancellation',
        patch: { completed_at: new Date().toISOString() },
      });
      return;
    }
    await transitionTask({
      dir: task.dir,
      id: task.task_id,
      to: 'ERROR',
      reason: 'review_execution_error',
      patch: { completed_at: new Date().toISOString(), error: message.slice(0, 2000) },
    });
    await reviewStatus.set({
      repository: task.repository,
      sha: task.headSha,
      state: 'error',
      description: 'Review could not complete',
      agent: task.agent,
    });
    console.error(`[pr-review-controller] ${task.repository}#${task.pr} failed:`, message.slice(0, 300));
  }
}

configurePrReviewController(createPrReviewController({
  fetchPullRequest: async ({ repository, pr, agent }) => ghApi('GET', `repos/${repository}/pulls/${pr}`, agent),
  setCommitStatus: (status) => reviewStatus.set(status),
  dispatchReview: (task) => {
    setImmediate(() => { executeControllerReview(task).catch((error) => console.error('[pr-review-controller] unhandled execution error:', error)); });
  },
}));

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

  if (req.method === 'GET' && pathname === '/api/review-tasks') {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
    sendJSON(res, 200, { tasks: await listReviewTasks({ dir: REVIEW_TASKS_DIR, limit }) });
    return;
  }

  const reviewDetailMatch = pathname.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)$/);
  if (req.method === 'GET' && reviewDetailMatch) {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    const task = await readTask({ dir: REVIEW_TASKS_DIR, id: reviewDetailMatch[1] });
    if (!task) { sendJSON(res, 404, { error: 'Review task not found' }); return; }
    sendJSON(res, 200, { task });
    return;
  }

  const reviewCancelMatch = pathname.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/cancel$/);
  if (req.method === 'POST' && reviewCancelMatch) {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const body = await parseBody(req);
      const task = await requestCancellation({
        dir: REVIEW_TASKS_DIR,
        id: reviewCancelMatch[1],
        actor: String(body?.actor || 'operator'),
        reason: String(body?.reason || 'operator_requested'),
      });
      sendJSON(res, 202, { task });
    } catch (error) {
      sendJSON(res, 409, { error: error?.message || 'Cancellation failed' });
    }
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
    } catch (e) {
      console.error(`[http] Failed to fetch issues for label "${labelQuery}":`, e?.message?.slice(0, 200));
    }
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
    return JSON.parse(out);
  } catch {
    return [];
  }
}

async function runReviewReconciliationCycle() {
  const result = await reconcileReviewTasks({ dir: REVIEW_TASKS_DIR });
  if (result.recovered.length > 0) {
    console.warn(`[review-reconciler] recovered ${result.recovered.length} stale task(s): ${result.recovered.join(', ')}`);
  }
}

async function pollUnreviewedPRs() {
  // Deliberately retained as a no-op compatibility seam. PR discovery belongs to
  // GitHub Actions; all work must enter through the controller webhook.
  console.log('[pr-poller] skipped legacy direct PR scan');
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
// PR review work is submitted only through the SHA-aware controller. The old
// in-process PR scanner remains intentionally disabled; GitHub Actions provides
// the event and recovery producer.
console.log('[pr-poller] direct PR auto-review poller disabled; controller ingress is authoritative');
runReviewReconciliationCycle().catch((error) => console.error('[review-reconciler] initial cycle failed:', error?.message));
setInterval(() => {
  runReviewReconciliationCycle().catch((error) => console.error('[review-reconciler] cycle failed:', error?.message));
}, 60_000).unref();
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
