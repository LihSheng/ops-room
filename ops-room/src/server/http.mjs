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
import { createGitHubReviewStatusService } from '../services/github-review-status.mjs';
import { listReviewTasks, readTask, renewClaim, requestCancellation, retryTask, pauseTask, resumeTask, transitionTask } from '../services/review-task-store.mjs';
import { listEffects, resolveAmbiguousEffect } from '../services/review-effect-ledger.mjs';
import { createPrReviewController } from '../workflows/pr-review-controller.mjs';
import { createFixChildTask } from '../workflows/fix-task-controller.mjs';
import { reconcileReviewTasks, dispatchEligibleTasks } from '../services/review-reconciler.mjs';
import { commitStatusForReviewEvent, taskStateForReviewEvent } from '../workflows/review-outcome.mjs';
import { evaluateAutoFixPolicy } from '../services/review-policy.mjs';
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

async function executeControllerFix({ dir, taskId, preClaimedLease }) {
  const deps = createFixRuntimeDeps({ taskDir: dir, renewClaim, readTask });
  return executeFixChildTask({
    dir,
    id: taskId,
    instanceId: `ops-room-${process.pid}`,
    preClaimedLease,
    runWorker: ({ task, lease }) => runFixChildWorker({ task, deps, dir, lease }),
  });
}

async function executeControllerReview(task) {
  try {
    const isChat = task.taskType === 'chat';
    const lease = task.lease; // pre-claimed lease from dispatcher (optional)

    // For reconciler-dispatched reviews that skipped the initial controller
    // path, write the pending status BEFORE invoking the model workflow.
    if (!isChat && lease) {
      await reviewStatus.set({
        repository: task.repository,
        sha: task.headSha,
        state: 'pending',
        description: 'Review in progress',
        agent: task.agent,
        dir: task.dir,
        taskId: task.task_id,
      });
    }

    const result = await runPrReviewWorkflow({
      agent: task.agent,
      task: task.task_text || task.task,
      task_type: task.taskType,
      repository: task.repository,
      pr: task.pr,
      commenter: task.commenter || 'controller',
      comment_id: task.commentId,
      mode: 'review',
      head_sha: task.headSha,
      task_id: task.task_id,
      dir: task.dir,
      lease,
    });

    // Chat tasks must not write the canonical commit status and should
    // complete in a dedicated success state without side effects.
    if (isChat) {
      await transitionTask({
        dir: task.dir,
        id: task.task_id,
        to: 'PASSED',
        reason: 'chat_response_completed',
        patch: { completed_at: new Date().toISOString(), result },
        leaseEpoch: lease?.lease_epoch,
      });
      return;
    }

    // Write the final commit status BEFORE committing the terminal task state.
    // This avoids marking the task PASSED / CHANGES_REQUESTED when the GitHub
    // status is ambiguous (e.g. a pre-existing CLAIMED effect).
    const status = commitStatusForReviewEvent(result.review_event);
    const statusResult = await reviewStatus.set({
      repository: task.repository,
      sha: task.headSha,
      state: status.state,
      description: status.description,
      agent: task.agent,
      dir: task.dir,
      taskId: task.task_id,
    });

    if (statusResult.ambiguous_effect) {
      // External status is ambiguous — do NOT mark the task as terminal.
      await transitionTask({
        dir: task.dir,
        id: task.task_id,
        to: 'NEEDS_HUMAN',
        reason: 'ambiguous_commit_status_effect',
        patch: { completed_at: new Date().toISOString(), result },
        leaseEpoch: lease?.lease_epoch,
      });
      return;
    }

    const state = taskStateForReviewEvent(result.review_event);
    const terminalTask = await transitionTask({
      dir: task.dir,
      id: task.task_id,
      to: state,
      reason: `review_${String(result.review_event || 'unknown').toLowerCase()}`,
      patch: { completed_at: new Date().toISOString(), result },
      leaseEpoch: lease?.lease_epoch,
    });

    if (state === 'CHANGES_REQUESTED' && task.mode === 'auto-fix') {
      // Evaluate auto-fix policy against the actual returned findings BEFORE
      // creating a fix child. Critical, ambiguous, or explicitly non-auto-fixable
      // findings block automated fixing.
      const autoFixPolicy = evaluateAutoFixPolicy({
        requestedMode: task.mode,
        policy: task.policy || {},
        findings: result.structured_review?.findings || [],
      });

      if (autoFixPolicy.allowed) {
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

        // Keep parent terminal as CHANGES_REQUESTED; only store fix_child_task_id
        // as metadata. The child owns FIX_QUEUED → FIXING → FIX_PUSHED/NEEDS_HUMAN/ERROR.
        await transitionTask({
          dir: task.dir,
          id: terminalTask.id,
          to: 'CHANGES_REQUESTED',
          reason: child.created ? 'fix_child_created' : 'fix_child_deduplicated',
          patch: { fix_child_task_id: child.task.id },
          leaseEpoch: lease?.lease_epoch,
        });

        setImmediate(() => {
          executeControllerFix({ dir: task.dir, taskId: child.task.id })
            .catch((error) => console.error('[fix-child-controller] unhandled execution error:', error));
        });
      } else {
        // Policy blocks auto-fix: move to NEEDS_HUMAN instead of creating fix child.
        await transitionTask({
          dir: task.dir,
          id: terminalTask.id,
          to: 'NEEDS_HUMAN',
          reason: `auto_fix_policy_rejected:${autoFixPolicy.reason}`,
          leaseEpoch: lease?.lease_epoch,
        });
      }
    }

    }

  } catch (error) {
    const message = error?.message || String(error);
    if (error?.code === 'REVIEW_CANCELLED') {
      await transitionTask({
        dir: task.dir,
        id: task.task_id,
        to: 'CANCELLED',
        reason: 'worker_acknowledged_cancellation',
        patch: { completed_at: new Date().toISOString() },
        leaseEpoch: lease?.lease_epoch,
      });
      return;
    }
    await transitionTask({
      dir: task.dir,
      id: task.task_id,
      to: 'ERROR',
      reason: 'review_execution_error',
      patch: { completed_at: new Date().toISOString(), error: message.slice(0, 2000) },
      leaseEpoch: lease?.lease_epoch,
    });
    await reviewStatus.set({
      repository: task.repository,
      sha: task.headSha,
      state: 'error',
      description: 'Review could not complete',
      agent: task.agent,
      dir: task.dir,
      taskId: task.task_id,
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

  const reviewRetryMatch = pathname.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/retry$/);
  if (req.method === 'POST' && reviewRetryMatch) {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const body = await parseBody(req);
      const task = await retryTask({
        dir: REVIEW_TASKS_DIR,
        id: reviewRetryMatch[1],
        reason: String(body?.reason || 'operator_retry'),
      });
      // Immediately attempt dispatch of this (and any other) eligible queued tasks.
      setImmediate(() => {
        dispatchEligibleTasks({ dir: REVIEW_TASKS_DIR, instanceId: `ops-room-${process.pid}` })
          .then((dr) => {
            for (const t of dr.tasks) {
              const executor = t.kind === 'fix' ? executeControllerFix : executeControllerReview;
              executor({
                dir: REVIEW_TASKS_DIR,
                task_id: t.id,
                taskId: t.id,
                task: t.task_text,
                task_text: t.task_text,
                taskType: t.task_type || 'review',
                commenter: t.commenter,
                commentId: t.comment_id,
                headSha: t.reviewed_sha,
                repository: t.repository,
                pr: t.pr,
                agent: t.agent,
                mode: t.mode,
                policy: t.policy || {},
                lease: t.lease,
              })
                .catch((error) => console.error('[operator-dispatch] execution error:', error));
            }
          })
          .catch((error) => console.error('[operator-dispatch] failed:', error?.message));
      });
      sendJSON(res, 202, { task });
    } catch (error) {
      sendJSON(res, 409, { error: error?.message || 'Retry failed' });
    }
    return;
  }

  const reviewPauseMatch = pathname.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/pause$/);
  if (req.method === 'POST' && reviewPauseMatch) {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const body = await parseBody(req);
      const task = await pauseTask({
        dir: REVIEW_TASKS_DIR,
        id: reviewPauseMatch[1],
        reason: String(body?.reason || 'operator_paused'),
      });
      sendJSON(res, 202, { task });
    } catch (error) {
      sendJSON(res, 409, { error: error?.message || 'Pause failed' });
    }
    return;
  }

  const reviewResumeMatch = pathname.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/resume$/);
  if (req.method === 'POST' && reviewResumeMatch) {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const body = await parseBody(req);
      const task = await resumeTask({
        dir: REVIEW_TASKS_DIR,
        id: reviewResumeMatch[1],
        reason: String(body?.reason || 'operator_resumed'),
      });
      // Immediately attempt dispatch of eligible queued tasks.
      setImmediate(() => {
        dispatchEligibleTasks({ dir: REVIEW_TASKS_DIR, instanceId: `ops-room-${process.pid}` })
          .then((dr) => {
            for (const t of dr.tasks) {
              const executor = t.kind === 'fix' ? executeControllerFix : executeControllerReview;
              executor({
                dir: REVIEW_TASKS_DIR,
                task_id: t.id,
                taskId: t.id,
                task: t.task_text,
                task_text: t.task_text,
                taskType: t.task_type || 'review',
                commenter: t.commenter,
                commentId: t.comment_id,
                headSha: t.reviewed_sha,
                repository: t.repository,
                pr: t.pr,
                agent: t.agent,
                mode: t.mode,
                policy: t.policy || {},
                lease: t.lease,
              })
                .catch((error) => console.error('[operator-dispatch] execution error:', error));
            }
          })
          .catch((error) => console.error('[operator-dispatch] failed:', error?.message));
      });
      sendJSON(res, 202, { task });
    } catch (error) {
      sendJSON(res, 409, { error: error?.message || 'Resume failed' });
    }
    return;
  }

  const reviewEffectsMatch = pathname.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/effects$/);
  if (req.method === 'GET' && reviewEffectsMatch) {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const kind = url.searchParams.get('kind');
      const state = url.searchParams.get('state') || 'CLAIMED';
      const effects = await listEffects({ dir: REVIEW_TASKS_DIR, taskId: reviewEffectsMatch[1], kind, state });
      sendJSON(res, 200, { effects });
    } catch (error) {
      sendJSON(res, 500, { error: error?.message || 'Failed to list effects' });
    }
    return;
  }

  const effectResolveMatch = pathname.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/effects\/([a-f0-9]+)\/resolve$/);
  if (req.method === 'POST' && effectResolveMatch) {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const body = await parseBody(req);
      const effect = await resolveAmbiguousEffect({
        dir: REVIEW_TASKS_DIR,
        effectId: effectResolveMatch[2],
        resolution: String(body?.resolution || 'abandon'),
        notes: String(body?.notes || ''),
      });
      sendJSON(res, 200, { effect });
    } catch (error) {
      sendJSON(res, 409, { error: error?.message || 'Resolution failed' });
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

async function runReviewReconciliationCycle() {
  const result = await reconcileReviewTasks({ dir: REVIEW_TASKS_DIR });
  if (result.recovered.length > 0) {
    console.warn(`[review-reconciler] recovered ${result.recovered.length} stale task(s): ${result.recovered.join(', ')}`);
  }
  // Dispatch any QUEUED / FIX_QUEUED tasks that are now eligible (concurrency
  // freed up, or tasks that were left queued after submission / operator action).
  const dispatchResult = await dispatchEligibleTasks({ dir: REVIEW_TASKS_DIR, instanceId: `ops-room-${process.pid}` });
  if (dispatchResult.dispatched > 0) {
    console.log(`[review-reconciler] dispatched ${dispatchResult.dispatched} eligible task(s)`);
    for (const task of dispatchResult.tasks) {
      const executor = task.kind === 'fix' ? executeControllerFix : executeControllerReview;
      setImmediate(() => {
        executor({
          dir: REVIEW_TASKS_DIR,
          task_id: task.id,
          taskId: task.id,
          task: task.task_text,
          task_text: task.task_text,
          taskType: task.task_type || 'review',
          commenter: task.commenter,
          commentId: task.comment_id,
          headSha: task.reviewed_sha,
          repository: task.repository,
          pr: task.pr,
          agent: task.agent,
          mode: task.mode,
          policy: task.policy || {},
          lease: task.lease,
        })
          .catch((error) => console.error('[review-reconciler] dispatch execution error:', error));
      });
    }
  }
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
