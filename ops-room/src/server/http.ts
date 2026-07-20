import { createServer } from 'node:http';
import { execSync } from 'node:child_process';

import { POLL_AGENTS } from '../lib/config.js';
import { pollAgentIssues, startIssuePoller } from '../lib/issue-poller.js';
import {
  REPO, PORT, HOST, WEBHOOK_SECRET, WORKSPACE_BASE, REVIEW_TASKS_DIR, WORKFLOW_RUNS_DIR, AUDIT_DIR, IDEMPOTENCY_DIR,
  LIFECYCLE_DIR, OPENAB_SERVER_VERSION, OPERATOR_API_ENABLED, SHUTDOWN_TIMEOUT_MS, ISSUE_POLLING_ENABLED,
  AGENT_LIFECYCLE_ENABLED, AGENT_LIFECYCLE_ALLOWED_AGENTS, AGENT_LIFECYCLE_DRAIN_TIMEOUT_MS,
  AGENT_LIFECYCLE_DRAIN_POLL_MS, AGENT_LIFECYCLE_STOP_TIMEOUT_SECONDS,
  AGENT_LIFECYCLE_START_TIMEOUT_SECONDS,
} from '../services/runtime-paths.js';
import { initDirs } from '../services/task-store.js';
import '../services/logs.js';
import {
  addComment, ensureLabel, removeLabel, addLabel, getCommitStatuses, createCommitStatus, ghApi
} from '../services/github.js';
import { handleTask, cancelTask } from '../workflows/github-code.js';
import { runPrReviewWorkflow } from '../workflows/pr-review.js';
import { createGitHubReviewStatusService } from '../services/github-review-status.js';
import { listReviewTasks, readTask, renewClaim, transitionTask } from '../services/review-task-store.js';
import { listEffects, resolveAmbiguousEffect } from '../services/review-effect-ledger.js';
import { createPrReviewController } from '../workflows/pr-review-controller.js';
import { createFixChildTask } from '../workflows/fix-task-controller.js';
import { reconcileReviewTasks, dispatchEligibleTasks } from '../services/review-reconciler.js';
import { commitStatusForReviewEvent, taskStateForReviewEvent } from '../workflows/review-outcome.js';
import { evaluateAutoFixPolicy } from '../services/review-policy.js';
import { executeFixChildTask } from '../workflows/fix-child-executor.js';
import { runFixChildWorker } from '../workflows/fix-worker.js';
import { createFixRuntimeDeps } from '../workflows/fix-runtime.js';
import { handleHealth } from '../routes/health.js';
import { handleTaskDetail, handleTasksList } from '../routes/tasks.js';
import { handleLogsList } from '../routes/logs.js';
import { configurePrReviewController, handleWebhook, isPrReviewWebhook } from '../routes/webhook-routes.js';
import { handleAgentsList } from '../routes/agents.js';
import { handleOpenABInstances } from '../routes/openab-instances.js';
import { handleStaticApp } from '../routes/static-app.js';
import { handleOperatorTaskAction, type OperatorTaskAction } from '../routes/operator-tasks.js';
import {
  canDispatchAgentFromLifecycle,
  handleOperatorAgentStart,
  handleOperatorAgentStop,
} from '../routes/operator-agents.js';
import { handleAuditEventDetail, handleAuditEventsList } from '../routes/audit-events.js';
import { handleReadOnlyAgentProfileApi } from '../routes/agent-profiles.js';
import { handleWorkflowRunDetail, handleWorkflowRunsList } from '../routes/workflow-runs.js';
import { recoverInterruptedAgentLifecycleStates } from '../services/agent-lifecycle-store.js';
import { resolveOperatorIdentity } from '../services/operator-identity.js';
import { sendJSON, verifyAuth, verifyOperatorAuth, parseBody } from '../routes/helpers.js';
import { processLifecycle, trackAcceptedOperation } from '../services/process-lifecycle.js';
import { createFreshRuntimeInspector } from '../services/runtime-adapter/registry.js';

const freshRuntimeSnapshot = createFreshRuntimeInspector();

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

function requireOperatorMutation(req, res) {
  if (!OPERATOR_API_ENABLED) {
    sendJSON(res, 404, { error: 'Not found' });
    return null;
  }
  if (!verifyOperatorAuth(req.headers.authorization)) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return null;
  }
  try {
    return resolveOperatorIdentity();
  } catch {
    sendJSON(res, 503, { error: 'Operator identity unavailable' });
    return null;
  }
}

function requireAgentLifecycleMutation(req, res) {
  if (!AGENT_LIFECYCLE_ENABLED) {
    sendJSON(res, 404, { error: 'Not found' });
    return null;
  }
  return requireOperatorMutation(req, res);
}

function scheduleTracked(label, operation, errorPrefix) {
  setImmediate(() => {
    processLifecycle.run(label, operation)
      .catch((error) => console.error(errorPrefix, error?.message || error));
  });
}

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
  const isChat = task.taskType === 'chat';
  const lease = task.lease;

  try {
    if (!isChat && lease) {
      await reviewStatus.set({
        repository: task.repository,
        sha: task.headSha,
        state: 'pending',
        description: 'Review in progress',
        agent: task.agent,
        dir: task.dir,
        taskId: task.task_id,
        leaseId: lease.lease_id,
        leaseEpoch: lease.lease_epoch,
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

    const status = commitStatusForReviewEvent(result.review_event);
    const statusResult = await reviewStatus.set({
      repository: task.repository,
      sha: task.headSha,
      state: status.state,
      description: status.description,
      agent: task.agent,
      dir: task.dir,
      taskId: task.task_id,
      leaseId: lease?.lease_id,
      leaseEpoch: lease?.lease_epoch,
    });

    if (statusResult.ambiguous_effect) {
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

        await transitionTask({
          dir: task.dir,
          id: terminalTask.id,
          to: 'CHANGES_REQUESTED',
          reason: child.created ? 'fix_child_created' : 'fix_child_deduplicated',
          patch: { fix_child_task_id: child.task.id },
          leaseEpoch: lease?.lease_epoch,
        });

        scheduleTracked(
          `fix:${child.task.id}`,
          () => executeControllerFix({ dir: task.dir, taskId: child.task.id }),
          '[fix-child-controller] unhandled execution error:',
        );
      } else {
        await transitionTask({
          dir: task.dir,
          id: terminalTask.id,
          to: 'NEEDS_HUMAN',
          reason: `auto_fix_policy_rejected:${autoFixPolicy.reason}`,
          leaseEpoch: lease?.lease_epoch,
        });
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
      leaseId: lease?.lease_id,
      leaseEpoch: lease?.lease_epoch,
    });
    console.error(`[pr-review-controller] ${task.repository}#${task.pr} failed:`, message.slice(0, 300));
  }
}

configurePrReviewController(createPrReviewController({
  fetchPullRequest: async ({ repository, pr, agent }) => ghApi('GET', `repos/${repository}/pulls/${pr}`, agent),
  setCommitStatus: (status) => reviewStatus.set(status),
  dispatchReview: (task) => scheduleTracked(
    `review:${task.task_id || task.id || task.headSha}`,
    () => executeControllerReview(task),
    '[pr-review-controller] unhandled execution error:',
  ),
}));

function lifecycleDispatchAllowed(agentId) {
  return canDispatchAgentFromLifecycle({ lifecycleDir: LIFECYCLE_DIR, agentId });
}

function scheduleOperatorDispatch() {
  setImmediate(() => {
    dispatchEligibleTasks({
      dir: REVIEW_TASKS_DIR,
      instanceId: `ops-room-${process.pid}`,
      canDispatchAgent: lifecycleDispatchAllowed,
    })
      .then((result) => {
        for (const task of result.tasks) {
          if (task.kind === 'fix') {
            scheduleTracked(
              `operator:${task.id}`,
              () => executeControllerFix({
                dir: REVIEW_TASKS_DIR,
                taskId: task.id,
                preClaimedLease: task.lease,
              }),
              '[operator-dispatch] fix execution error:',
            );
          } else {
            scheduleTracked(
              `operator:${task.id}`,
              () => executeControllerReview({
                dir: REVIEW_TASKS_DIR,
                task_id: task.id,
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
              }),
              '[operator-dispatch] review execution error:',
            );
          }
        }
      })
      .catch((error) => console.error('[operator-dispatch] failed:', error?.message));
  });
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Powered-By', 'OpenAB Webhook');
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (processLifecycle.isDraining() && req.method !== 'GET') {
    sendJSON(res, 503, { error: 'Ops Room is draining' });
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    try {
      const data = await handleHealth();
      sendJSON(res, 200, data);
    } catch { sendJSON(res, 500, { status: 'error' }); }
    return;
  }

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

  if (req.method === 'GET' && pathname === '/api/tasks') {
    try {
      const data = await handleTasksList();
      sendJSON(res, 200, data);
    } catch { sendJSON(res, 200, { tasks: [] }); }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/workflows') {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const result = await handleWorkflowRunsList(searchParams, { workflowRunsDir: WORKFLOW_RUNS_DIR });
      sendJSON(res, result.status, result.body);
    } catch (error) {
      sendJSON(res, 500, { error: error?.message || 'Failed to list workflows' });
    }
    return;
  }

  const workflowDetailMatch = pathname.match(/^\/api\/workflows\/([A-Za-z0-9._:-]+)$/);
  if (req.method === 'GET' && workflowDetailMatch) {
    if (!verifyAuth(req.headers.authorization)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const result = await handleWorkflowRunDetail(decodeURIComponent(workflowDetailMatch[1]), {
        workflowRunsDir: WORKFLOW_RUNS_DIR,
      });
      sendJSON(res, result.status, result.body);
    } catch (error) {
      sendJSON(res, 500, { error: error?.message || 'Failed to read workflow' });
    }
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

  const operatorTaskActionMatch = pathname.match(
    /^\/api\/operator\/tasks\/([A-Za-z0-9._:-]+)\/(cancel|retry|pause|resume)$/,
  );
  const legacyTaskActionMatch = pathname.match(
    /^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/(cancel|retry|pause|resume)$/,
  );
  const taskActionMatch = operatorTaskActionMatch || legacyTaskActionMatch;
  if (req.method === 'POST' && taskActionMatch) {
    const actor = requireOperatorMutation(req, res);
    if (!actor) return;
    try {
      const body = await parseBody(req);
      const result = await handleOperatorTaskAction({
        action: taskActionMatch[2] as OperatorTaskAction,
        taskId: taskActionMatch[1],
        body,
        actor,
        reviewTasksDir: REVIEW_TASKS_DIR,
        auditDir: AUDIT_DIR,
        idempotencyDir: IDEMPOTENCY_DIR,
      });
      if (result.dispatch) scheduleOperatorDispatch();
      sendJSON(res, result.status, result.body);
    } catch (error) {
      sendJSON(res, 500, { error: error?.message || 'Task action failed' });
    }
    return;
  }

  const operatorAgentStopMatch = pathname.match(
    /^\/api\/operator\/agents\/([A-Za-z0-9._-]+)\/stop$/,
  );
  if (req.method === 'POST' && operatorAgentStopMatch) {
    const actor = requireAgentLifecycleMutation(req, res);
    if (!actor) return;
    try {
      const body = await parseBody(req);
      const result = await handleOperatorAgentStop({
        agentId: operatorAgentStopMatch[1],
        body,
        actor,
        reviewTasksDir: REVIEW_TASKS_DIR,
        lifecycleDir: LIFECYCLE_DIR,
        auditDir: AUDIT_DIR,
        idempotencyDir: IDEMPOTENCY_DIR,
        allowedAgents: AGENT_LIFECYCLE_ALLOWED_AGENTS,
        drainTimeoutMs: AGENT_LIFECYCLE_DRAIN_TIMEOUT_MS,
        drainPollMs: AGENT_LIFECYCLE_DRAIN_POLL_MS,
        stopTimeoutSeconds: AGENT_LIFECYCLE_STOP_TIMEOUT_SECONDS,
      });
      sendJSON(res, result.status, result.body);
    } catch (error) {
      sendJSON(res, 500, { error: error?.message || 'Agent stop failed' });
    }
    return;
  }

  const operatorAgentStartMatch = pathname.match(
    /^\/api\/operator\/agents\/([A-Za-z0-9._-]+)\/start$/,
  );
  if (req.method === 'POST' && operatorAgentStartMatch) {
    const actor = requireAgentLifecycleMutation(req, res);
    if (!actor) return;
    try {
      const body = await parseBody(req);
      const result = await handleOperatorAgentStart({
        agentId: operatorAgentStartMatch[1],
        body,
        actor,
        reviewTasksDir: REVIEW_TASKS_DIR,
        lifecycleDir: LIFECYCLE_DIR,
        auditDir: AUDIT_DIR,
        idempotencyDir: IDEMPOTENCY_DIR,
        allowedAgents: AGENT_LIFECYCLE_ALLOWED_AGENTS,
        startTimeoutSeconds: AGENT_LIFECYCLE_START_TIMEOUT_SECONDS,
        freshRuntimeSnapshot,
      });
      sendJSON(res, result.status, result.body);
    } catch (error) {
      sendJSON(res, 500, { error: error?.message || 'Agent start failed' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/audit-events') {
    if (!requireOperatorMutation(req, res)) return;
    const data = await handleAuditEventsList(searchParams, { auditDir: AUDIT_DIR });
    sendJSON(res, 200, data);
    return;
  }

  const auditDetailMatch = pathname.match(/^\/api\/audit-events\/([A-Fa-f0-9-]+)$/);
  if (req.method === 'GET' && auditDetailMatch) {
    if (!requireOperatorMutation(req, res)) return;
    const event = await handleAuditEventDetail(auditDetailMatch[1], { auditDir: AUDIT_DIR });
    if (!event) sendJSON(res, 404, { error: 'Audit event not found' });
    else sendJSON(res, 200, { event });
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
    if (!requireOperatorMutation(req, res)) return;
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

  if (req.method === 'GET' && pathname === '/api/agents') {
    try {
      const data = await handleAgentsList();
      sendJSON(res, 200, data);
    } catch (err) { sendJSON(res, 500, { error: err.message }); }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/openab/instances') {
    try {
      const data = await handleOpenABInstances();
      sendJSON(res, 200, data);
    } catch (err) { sendJSON(res, 500, { error: err.message }); }
    return;
  }

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

  if (req.method === 'GET') {
    const apiResult = handleReadOnlyAgentProfileApi(pathname);
    if (apiResult) {
      sendJSON(res, apiResult.status, apiResult.body);
      return;
    }
  }

  if (req.method === 'GET') {
    const served = handleStaticApp(req, res, pathname);
    if (served) return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

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
  const dispatchResult = await dispatchEligibleTasks({
    dir: REVIEW_TASKS_DIR,
    instanceId: `ops-room-${process.pid}`,
    canDispatchAgent: lifecycleDispatchAllowed,
  });
  if (dispatchResult.dispatched > 0) {
    console.log(`[review-reconciler] dispatched ${dispatchResult.dispatched} eligible task(s)`);
    for (const task of dispatchResult.tasks) {
      const executor = task.kind === 'fix' ? executeControllerFix : executeControllerReview;
      scheduleTracked(`reconcile:${task.id}`, () => executor({
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
        }), '[review-reconciler] dispatch execution error:');
    }
  }
}

console.log(`[server] version: ${OPENAB_SERVER_VERSION}`);

if (!WEBHOOK_SECRET) {
  throw new Error('Missing OPENAB_WEBHOOK_SECRET. Refusing to start webhook server without an explicit bearer secret.');
}

await initDirs();
const recoveredLifecycleAgents = await recoverInterruptedAgentLifecycleStates({ dir: LIFECYCLE_DIR });
if (recoveredLifecycleAgents.length > 0) {
  console.warn(`[agent-lifecycle] marked interrupted operation failed for: ${recoveredLifecycleAgents.join(', ')}`);
}
const issuePollerAbort = new AbortController();
const issuePollerPromise = ISSUE_POLLING_ENABLED ? processLifecycle.track(startIssuePoller({
  agentKeys: POLL_AGENTS,
  intervalMs: 30_000,
  signal: issuePollerAbort.signal,
  pollAgent: (agentKey, signal) => pollAgentIssues({
    agentKey,
    listOpenIssuesForAgent,
    ensureLabel,
    removeLabel,
    addLabel,
    addComment,
    handleTask: (issueNumber, agentKey, issue) => trackAcceptedOperation(
      processLifecycle,
      `legacy-issue:${agentKey}#${issueNumber}`,
      () => handleTask(issueNumber, agentKey, issue),
    ),
    cancelTask,
    signal,
  }),
}), 'issue-poller') : Promise.resolve();
issuePollerPromise.catch((e) => console.error('[server] poller fatal:', e.message));
if (!ISSUE_POLLING_ENABLED) console.log('[poller] disabled by OPS_ROOM_ISSUE_POLLING_ENABLED=false');
console.log('[pr-poller] direct PR auto-review poller disabled; controller ingress is authoritative');
await runReviewReconciliationCycle().catch((error) => console.error('[review-reconciler] initial cycle failed:', error?.message));
const reconciliationInterval = setInterval(() => {
  runReviewReconciliationCycle().catch((error) => console.error('[review-reconciler] cycle failed:', error?.message));
}, 60_000).unref();
server.listen(PORT, HOST, () => {
  console.log(`OpenAB webhook listening on http://${HOST}:${PORT}`);
  console.log(`  POST /webhook   - Receive issue commands`);
  console.log(`  GET  /tasks      - List pending tasks`);
  console.log(`  GET  /health     - Health check`);
  console.log(`  GET  /api/health  - Detailed health`);
  console.log(`  GET  /api/tasks   - List tasks`);
  console.log(`  GET  /api/workflows - List durable workflows`);
  console.log(`  GET  /api/workflows/:workflowId - Workflow detail`);
  console.log(`  GET  /api/logs    - List bounded redacted logs`);
  console.log(`  GET  /api/agents  - List agents`);
  console.log(`  GET  /api/openab/instances - OpenAB instance dashboard`);
  if (AGENT_LIFECYCLE_ENABLED) console.log(`  POST /api/operator/agents/:agent/stop - Guarded graceful stop`);
  if (AGENT_LIFECYCLE_ENABLED) console.log(`  POST /api/operator/agents/:agent/start - Guarded graceful start`);
  console.log(`  WORKSPACE_BASE   - ${WORKSPACE_BASE}`);
});

let shutdownPromise = null;

function closeServer() {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[server] ${signal} received; draining new work`);
    processLifecycle.beginDrain();
    issuePollerAbort.abort();
    clearInterval(reconciliationInterval);

    const serverClosed = closeServer();
    const drainResult = await processLifecycle.waitForIdle(SHUTDOWN_TIMEOUT_MS);
    await serverClosed;

    if (!drainResult.idle) {
      console.error(`[server] drain timed out with ${drainResult.in_flight} operation(s): ${drainResult.operations.join(', ')}`);
      process.exit(1);
    }

    console.log('[server] drain complete');
    process.exitCode = 0;
  })();
  return shutdownPromise;
}

process.once('SIGTERM', () => { shutdown('SIGTERM').catch((error) => { console.error('[server] shutdown failed:', error); process.exit(1); }); });
process.once('SIGINT', () => { shutdown('SIGINT').catch((error) => { console.error('[server] shutdown failed:', error); process.exit(1); }); });
