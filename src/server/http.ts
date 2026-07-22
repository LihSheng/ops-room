import { createServer } from 'node:http';
import { execSync } from 'node:child_process';

import { POLL_AGENTS } from '../lib/config.js';
import { pollAgentIssues, startIssuePoller } from '../lib/issue-poller.js';
import {
  REPO, PORT, HOST, WEBHOOK_SECRET, WORKSPACE_BASE, REVIEW_TASKS_DIR, MISSIONS_DIR, WORKFLOW_RUNS_DIR, AUDIT_DIR, IDEMPOTENCY_DIR,
  LIFECYCLE_DIR, OPENAB_SERVER_VERSION, SHUTDOWN_TIMEOUT_MS, ISSUE_POLLING_ENABLED,
  HUMAN_AUTH_ENABLED,
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
import { handleMissionDetail, handleMissionsList } from '../routes/missions.js';
import { handleCreateMission } from '../routes/operator-missions.js';
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
import {
  handleCreateOperatorSession,
  handleReadOperatorSession,
  handleRevokeOperatorSession,
} from '../routes/operator-sessions.js';
import {
  handleOperatorSessionAdministrativeRevoke,
  handleOperatorSessionsList,
} from '../routes/operator-session-administration.js';
import { recoverInterruptedAgentLifecycleStates } from '../services/agent-lifecycle-store.js';
import { sendJSON, verifyAuth, parseBody } from '../routes/helpers.js';
import { processLifecycle, trackAcceptedOperation } from '../services/process-lifecycle.js';
import { createFreshRuntimeInspector } from '../services/runtime-adapter/registry.js';
import {
  authorizeOperatorRequest,
  OPERATOR_CSRF_HEADER_NAME,
} from '../services/operator-request-auth.js';
import { authorizeDashboardReadRequest } from '../services/dashboard-request-auth.js';
import { createRouter, type RouteEntry } from '../lib/router.js';

// ── guards ────────────────────────────────────────────────

const freshRuntimeSnapshot = createFreshRuntimeInspector();

async function requireOperatorMutation(
  req: Parameters<typeof authorizeOperatorRequest>[0]['req'],
  res: { writeHead: (...args: unknown[]) => void; end: (body: string) => void },
  permission: string,
) {
  const authorization = await authorizeOperatorRequest({ req, permission });
  if (!authorization.ok) {
    sendJSON(res as Parameters<typeof sendJSON>[1], authorization.status, {
      error: authorization.error,
      error_code: authorization.error_code,
    });
    return null;
  }
  return authorization.actor;
}

async function requireAgentLifecycleMutation(
  req: Parameters<typeof authorizeOperatorRequest>[0]['req'],
  res: Parameters<typeof sendJSON>[1],
) {
  if (!AGENT_LIFECYCLE_ENABLED) {
    sendJSON(res, 404, { error: 'Not found' });
    return null;
  }
  return requireOperatorMutation(req, res, 'agent.lifecycle');
}

const dashboardReadGuard = async (req: Parameters<typeof authorizeDashboardReadRequest>[0]['req'], res: Parameters<typeof sendJSON>[1]) => {
  const authorization = await authorizeDashboardReadRequest({ req });
  if (!authorization.ok) {
    sendJSON(res, authorization.status, {
      error: authorization.error,
      error_code: authorization.error_code,
    });
    return null;
  }
  return authorization;
};

const drainGuard = async (req: import('node:http').IncomingMessage, res: Parameters<typeof sendJSON>[1]) => {
  if (processLifecycle.isDraining() && req.method !== 'GET') {
    sendJSON(res, 503, { error: 'Ops Room is draining' });
    return null;
  }
  return {};
};

// ── controller execution ──────────────────────────────────

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

function scheduleTracked(label: string, operation: () => Promise<unknown>, errorPrefix: string) {
  setImmediate(() => {
    processLifecycle.run(label, operation)
      .catch((error) => console.error(errorPrefix, error?.message || error));
  });
}

async function executeControllerFix({ dir, taskId, preClaimedLease }: {
  dir: string; taskId: string; preClaimedLease?: unknown;
}) {
  const deps = createFixRuntimeDeps({ taskDir: dir, renewClaim, readTask });
  return executeFixChildTask({
    dir,
    id: taskId,
    instanceId: `ops-room-${process.pid}`,
    preClaimedLease,
    runWorker: ({ task, lease }) => runFixChildWorker({ task, deps, dir, lease }),
  });
}

async function executeControllerReview(task: Record<string, unknown> & {
  task_id: string; task_text?: string; task?: string; taskType?: string;
  repository?: string; pr?: string; headSha?: string; commenter?: string;
  commentId?: string; agent?: string; dir: string; mode?: string;
  policy?: Record<string, unknown>; lease?: Record<string, unknown>;
}) {
  const isChat = task.taskType === 'chat';
  const lease = task.lease;

  try {
    if (!isChat && lease) {
      await reviewStatus.set({
        repository: task.repository!,
        sha: task.headSha!,
        state: 'pending',
        description: 'Review in progress',
        agent: task.agent!,
        dir: task.dir,
        taskId: task.task_id,
        leaseId: (lease as Record<string, unknown>).lease_id as string,
        leaseEpoch: (lease as Record<string, unknown>).lease_epoch as number,
      });
    }

    const result = await runPrReviewWorkflow({
      agent: task.agent,
      task: task.task_text || task.task || '',
      task_type: task.taskType,
      repository: task.repository,
      pr: task.pr,
      commenter: task.commenter || 'controller',
      comment_id: task.commentId,
      mode: 'review' as const,
      head_sha: task.headSha,
      task_id: task.task_id,
      dir: task.dir,
      lease: lease as Parameters<typeof runPrReviewWorkflow>[0]['lease'],
    });

    if (isChat) {
      await transitionTask({
        dir: task.dir,
        id: task.task_id,
        to: 'PASSED',
        reason: 'chat_response_completed',
        patch: { completed_at: new Date().toISOString(), result },
        leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
      });
      return;
    }

    const status = commitStatusForReviewEvent(result.review_event);
    const statusResult = await reviewStatus.set({
      repository: task.repository!,
      sha: task.headSha!,
      state: status.state,
      description: status.description,
      agent: task.agent!,
      dir: task.dir,
      taskId: task.task_id,
      leaseId: (lease as Record<string, unknown>)?.lease_id as string,
      leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
    });

    if (statusResult.ambiguous_effect) {
      await transitionTask({
        dir: task.dir,
        id: task.task_id,
        to: 'NEEDS_HUMAN',
        reason: 'ambiguous_commit_status_effect',
        patch: { completed_at: new Date().toISOString(), result },
        leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
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
      leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
    });

    if (state === 'CHANGES_REQUESTED' && task.mode === 'auto-fix') {
      const autoFixPolicy = evaluateAutoFixPolicy({
        requestedMode: task.mode,
        policy: task.policy || {},
        findings: (result as Record<string, unknown>).structured_review?.findings || [],
      });

      if (autoFixPolicy.allowed) {
        const child = await createFixChildTask({
          dir: task.dir,
          repository: task.repository!,
          pr: task.pr!,
          reviewedSha: task.headSha!,
          parentTaskId: task.task_id,
          agent: task.agent!,
          policy: task.policy,
          reviewResult: (result as Record<string, unknown>).structured_review,
          headRef: (result as Record<string, unknown>).head_ref || null,
        });

        await transitionTask({
          dir: task.dir,
          id: terminalTask.id,
          to: 'CHANGES_REQUESTED',
          reason: (child as { created: boolean }).created ? 'fix_child_created' : 'fix_child_deduplicated',
          patch: { fix_child_task_id: (child as { task: { id: string } }).task.id },
          leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
        });

        scheduleTracked(
          `fix:${(child as { task: { id: string } }).task.id}`,
          () => executeControllerFix({ dir: task.dir, taskId: (child as { task: { id: string } }).task.id }),
          '[fix-child-controller] unhandled execution error:',
        );
      } else {
        await transitionTask({
          dir: task.dir,
          id: terminalTask.id,
          to: 'NEEDS_HUMAN',
          reason: `auto_fix_policy_rejected:${autoFixPolicy.reason}`,
          leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
        });
      }
    }
  } catch (error: unknown) {
    const message = (error as Error)?.message || String(error);
    if ((error as { code?: string })?.code === 'REVIEW_CANCELLED') {
      await transitionTask({
        dir: task.dir,
        id: task.task_id,
        to: 'CANCELLED',
        reason: 'worker_acknowledged_cancellation',
        patch: { completed_at: new Date().toISOString() },
        leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
      });
      return;
    }
    await transitionTask({
      dir: task.dir,
      id: task.task_id,
      to: 'ERROR',
      reason: 'review_execution_error',
      patch: { completed_at: new Date().toISOString(), error: message.slice(0, 2000) },
      leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
    });
    await reviewStatus.set({
      repository: task.repository!,
      sha: task.headSha!,
      state: 'error',
      description: 'Review could not complete',
      agent: task.agent!,
      dir: task.dir,
      taskId: task.task_id,
      leaseId: (lease as Record<string, unknown>)?.lease_id as string,
      leaseEpoch: (lease as Record<string, unknown>)?.lease_epoch as number,
    });
    console.error(`[pr-review-controller] ${task.repository}#${task.pr} failed:`, message.slice(0, 300));
  }
}

configurePrReviewController(createPrReviewController({
  fetchPullRequest: async ({ repository, pr, agent }) => ghApi('GET', `repos/${repository}/pulls/${pr}`, agent as string),
  setCommitStatus: (status) => reviewStatus.set(status as Parameters<typeof reviewStatus.set>[0]),
  dispatchReview: (task) => scheduleTracked(
    `review:${task.task_id || task.id || task.headSha}`,
    () => executeControllerReview(task as Parameters<typeof executeControllerReview>[0]),
    '[pr-review-controller] unhandled execution error:',
  ),
}));

function lifecycleDispatchAllowed(agentId: string) {
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
                task: (task as Record<string, unknown>).task_text as string,
                task_text: (task as Record<string, unknown>).task_text as string,
                taskType: (task as Record<string, unknown>).task_type as string || 'review',
                commenter: (task as Record<string, unknown>).commenter as string,
                commentId: (task as Record<string, unknown>).comment_id as string,
                headSha: (task as Record<string, unknown>).reviewed_sha as string,
                repository: task.repository,
                pr: (task as Record<string, unknown>).pr as string,
                agent: task.agent,
                mode: (task as Record<string, unknown>).mode as string,
                policy: (task as Record<string, unknown>).policy as Record<string, unknown> || {},
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

// ── route table ────────────────────────────────────────────

import type { IncomingMessage, ServerResponse } from 'node:http';
import { requiresDashboardReadAuth } from '../routes/helpers.js';

const routes: RouteEntry[] = [
  // Health (no auth, no drain guard)
  {
    method: 'GET',
    match: (p) => p === '/health' ? {} : null,
    handler: async (_req, res) => {
      sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
    },
  },

  // API health (no auth)
  {
    method: 'GET',
    match: (p) => p === '/api/health' ? {} : null,
    handler: async (_req, res) => {
      try {
        const data = await handleHealth();
        sendJSON(res, 200, data);
      } catch { sendJSON(res, 500, { status: 'error' }); }
    },
  },

  // Operator session bootstrap (no auth, single endpoint)
  {
    method: ['POST', 'GET', 'DELETE'],
    match: (p) => p === '/api/auth/session' ? {} : null,
    handler: async (req, res) => {
      let result = null;
      if (req.method === 'POST') {
        result = await handleCreateOperatorSession({
          authorization: req.headers.authorization,
        });
      } else if (req.method === 'GET') {
        result = await handleReadOperatorSession({
          cookieHeader: req.headers.cookie,
        });
      } else if (req.method === 'DELETE') {
        result = await handleRevokeOperatorSession({
          cookieHeader: req.headers.cookie,
          csrfHeader: req.headers[OPERATOR_CSRF_HEADER_NAME],
        });
      }
      if (result) {
        sendJSON(res, result.status, result.body, result.headers);
      }
    },
  },

  // Operator session list (operator: session.manage)
  {
    method: 'GET',
    match: (p) => p === '/api/operator/sessions' ? {} : null,
    handler: async (req, res, _params, url) => {
      const actor = await requireOperatorMutation(req, res, 'session.manage');
      if (!actor) return;
      try {
        const result = await handleOperatorSessionsList({ searchParams: url.searchParams });
        sendJSON(res, result.status, result.body, result.headers);
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Failed to list operator sessions' });
      }
    },
  },

  // Operator session admin revoke (operator: session.manage)
  {
    method: 'POST',
    match: (p) => {
      const m = p.match(/^\/api\/operator\/sessions\/([^/]+)\/revoke$/);
      return m ? { sessionId: m[1] } : null;
    },
    handler: async (req, res, params) => {
      const actor = await requireOperatorMutation(req, res, 'session.manage');
      if (!actor) return;
      try {
        const body = await parseBody(req);
        const result = await handleOperatorSessionAdministrativeRevoke({
          sessionId: decodeURIComponent(params.sessionId),
          body,
          actor,
        });
        sendJSON(res, result.status, result.body, result.headers);
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Session revocation failed' });
      }
    },
  },

  // Task list + detail (webhook auth for legacy /tasks, dashboard auth for /api/tasks)
  {
    method: 'GET',
    match: (p) => p.startsWith('/tasks') ? {} : null,
    handler: async (req, res) => {
      const auth = req.headers['authorization'];
      if (!verifyAuth(auth)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
      try {
        const data = await handleTasksList();
        sendJSON(res, 200, data);
      } catch { sendJSON(res, 200, { tasks: [] }); }
    },
  },

  {
    method: 'GET',
    match: (p) => {
      const m = p.match(/^\/tasks\/([^/]+)$/);
      return m ? { taskId: m[1] } : null;
    },
    handler: async (req, res, params) => {
      const auth = req.headers['authorization'];
      if (!verifyAuth(auth)) { sendJSON(res, 401, { error: 'Unauthorized' }); return; }
      try {
        const data = await handleTaskDetail(decodeURIComponent(params.taskId));
        if (!data) { sendJSON(res, 404, { error: 'Task not found' }); return; }
        sendJSON(res, 200, data);
      } catch (err: unknown) { sendJSON(res, 500, { error: (err as Error).message }); }
    },
  },

  // API tasks (dashboard read auth)
  {
    method: 'GET',
    match: (p) => p === '/api/tasks' ? {} : null,
    handler: async (_req, res) => {
      try {
        const data = await handleTasksList();
        sendJSON(res, 200, data);
      } catch { sendJSON(res, 200, { tasks: [] }); }
    },
  },

  {
    method: 'GET',
    match: (p) => {
      const m = p.match(/^\/api\/tasks\/([^/]+)$/);
      return m ? { taskId: m[1] } : null;
    },
    handler: async (_req, res, params) => {
      try {
        const data = await handleTaskDetail(decodeURIComponent(params.taskId));
        if (!data) { sendJSON(res, 404, { error: 'Task not found' }); }
        else { sendJSON(res, 200, data); }
      } catch (err: unknown) { sendJSON(res, 500, { error: (err as Error).message }); }
    },
  },

  // Missions (dashboard read auth)
  {
    method: 'GET',
    match: (p) => p === '/api/missions' ? {} : null,
    handler: async (_req, res, _params, url) => {
      try {
        const result = await handleMissionsList(url.searchParams, { missionsDir: MISSIONS_DIR });
        sendJSON(res, result.status, result.body);
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Failed to list missions' });
      }
    },
  },

  {
    method: 'GET',
    match: (p) => {
      const m = p.match(/^\/api\/missions\/([A-Za-z0-9._:-]+)$/);
      return m ? { missionId: m[1] } : null;
    },
    handler: async (_req, res, params) => {
      try {
        const result = await handleMissionDetail(decodeURIComponent(params.missionId), {
          missionsDir: MISSIONS_DIR,
        });
        sendJSON(res, result.status, result.body);
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Failed to read mission' });
      }
    },
  },

  // Create mission (operator: mission.create)
  {
    method: 'POST',
    match: (p) => p === '/api/operator/missions' ? {} : null,
    handler: async (req, res) => {
      const actor = await requireOperatorMutation(req, res, 'mission.create');
      if (!actor) return;
      try {
        const body = await parseBody(req);
        const result = await handleCreateMission({
          body,
          actor,
          missionsDir: MISSIONS_DIR,
          auditDir: AUDIT_DIR,
          idempotencyDir: IDEMPOTENCY_DIR,
        });
        sendJSON(res, result.status, result.body);
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Mission creation failed' });
      }
    },
  },

  // Workflows (dashboard read auth)
  {
    method: 'GET',
    match: (p) => p === '/api/workflows' ? {} : null,
    handler: async (_req, res, _params, url) => {
      try {
        const result = await handleWorkflowRunsList(url.searchParams, { workflowRunsDir: WORKFLOW_RUNS_DIR });
        sendJSON(res, result.status, result.body);
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Failed to list workflows' });
      }
    },
  },

  {
    method: 'GET',
    match: (p) => {
      const m = p.match(/^\/api\/workflows\/([A-Za-z0-9._:-]+)$/);
      return m ? { workflowId: m[1] } : null;
    },
    handler: async (_req, res, params) => {
      try {
        const result = await handleWorkflowRunDetail(decodeURIComponent(params.workflowId), {
          workflowRunsDir: WORKFLOW_RUNS_DIR,
        });
        sendJSON(res, result.status, result.body);
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Failed to read workflow' });
      }
    },
  },

  // Review tasks (dashboard read auth)
  {
    method: 'GET',
    match: (p) => p === '/api/review-tasks' ? {} : null,
    handler: async (_req, res, _params, url) => {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
      sendJSON(res, 200, { tasks: await listReviewTasks({ dir: REVIEW_TASKS_DIR, limit }) });
    },
  },

  {
    method: 'GET',
    match: (p) => {
      const m = p.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)$/);
      return m ? { taskId: m[1] } : null;
    },
    handler: async (_req, res, params) => {
      const task = await readTask({ dir: REVIEW_TASKS_DIR, id: params.taskId });
      if (!task) { sendJSON(res, 404, { error: 'Review task not found' }); return; }
      sendJSON(res, 200, { task });
    },
  },

  // Operator task actions (cancel/retry/pause/resume)
  {
    method: 'POST',
    match: (p) => {
      const m = p.match(/^\/api\/(?:operator\/tasks|review-tasks)\/([A-Za-z0-9._:-]+)\/(cancel|retry|pause|resume)$/);
      return m ? { taskId: m[1], action: m[2] } : null;
    },
    handler: async (req, res, params) => {
      const actor = await requireOperatorMutation(req, res, 'task.manage');
      if (!actor) return;
      try {
        const body = await parseBody(req);
        const result = await handleOperatorTaskAction({
          action: params.action as OperatorTaskAction,
          taskId: params.taskId,
          body,
          actor,
          reviewTasksDir: REVIEW_TASKS_DIR,
          auditDir: AUDIT_DIR,
          idempotencyDir: IDEMPOTENCY_DIR,
        });
        if (result.dispatch) scheduleOperatorDispatch();
        sendJSON(res, result.status, result.body);
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Task action failed' });
      }
    },
  },

  // Agent lifecycle: stop
  {
    method: 'POST',
    match: (p) => {
      const m = p.match(/^\/api\/operator\/agents\/([A-Za-z0-9._-]+)\/stop$/);
      return m ? { agentId: m[1] } : null;
    },
    handler: async (req, res, params) => {
      const actor = await requireAgentLifecycleMutation(req, res);
      if (!actor) return;
      try {
        const body = await parseBody(req);
        const result = await handleOperatorAgentStop({
          agentId: params.agentId,
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
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Agent stop failed' });
      }
    },
  },

  // Agent lifecycle: start
  {
    method: 'POST',
    match: (p) => {
      const m = p.match(/^\/api\/operator\/agents\/([A-Za-z0-9._-]+)\/start$/);
      return m ? { agentId: m[1] } : null;
    },
    handler: async (req, res, params) => {
      const actor = await requireAgentLifecycleMutation(req, res);
      if (!actor) return;
      try {
        const body = await parseBody(req);
        const result = await handleOperatorAgentStart({
          agentId: params.agentId,
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
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Agent start failed' });
      }
    },
  },

  // Audit events (operator: policy.manage)
  {
    method: 'GET',
    match: (p) => p === '/api/audit-events' ? {} : null,
    handler: async (req, res, _params, url) => {
      const actor = await requireOperatorMutation(req, res, 'policy.manage');
      if (!actor) return;
      const data = await handleAuditEventsList(url.searchParams, { auditDir: AUDIT_DIR });
      sendJSON(res, 200, data);
    },
  },

  {
    method: 'GET',
    match: (p) => {
      const m = p.match(/^\/api\/audit-events\/([A-Fa-f0-9-]+)$/);
      return m ? { eventId: m[1] } : null;
    },
    handler: async (req, res, params) => {
      const actor = await requireOperatorMutation(req, res, 'policy.manage');
      if (!actor) return;
      const event = await handleAuditEventDetail(params.eventId, { auditDir: AUDIT_DIR });
      if (!event) sendJSON(res, 404, { error: 'Audit event not found' });
      else sendJSON(res, 200, { event });
    },
  },

  // Review effects
  {
    method: 'GET',
    match: (p) => {
      const m = p.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/effects$/);
      return m ? { taskId: m[1] } : null;
    },
    handler: async (_req, res, params, url) => {
      try {
        const kind = url.searchParams.get('kind');
        const state = url.searchParams.get('state') || 'CLAIMED';
        const effects = await listEffects({ dir: REVIEW_TASKS_DIR, taskId: params.taskId, kind, state });
        sendJSON(res, 200, { effects });
      } catch (error: unknown) {
        sendJSON(res, 500, { error: (error as Error)?.message || 'Failed to list effects' });
      }
    },
  },

  // Effect resolve (operator: workflow.recover)
  {
    method: 'POST',
    match: (p) => {
      const m = p.match(/^\/api\/review-tasks\/([A-Za-z0-9._:-]+)\/effects\/([a-f0-9]+)\/resolve$/);
      return m ? { taskId: m[1], effectId: m[2] } : null;
    },
    handler: async (req, res, params) => {
      const actor = await requireOperatorMutation(req, res, 'workflow.recover');
      if (!actor) return;
      try {
        const body = await parseBody(req);
        const effect = await resolveAmbiguousEffect({
          dir: REVIEW_TASKS_DIR,
          effectId: params.effectId,
          resolution: String(body?.resolution || 'abandon'),
          notes: String(body?.notes || ''),
        });
        sendJSON(res, 200, { effect });
      } catch (error: unknown) {
        sendJSON(res, 409, { error: (error as Error)?.message || 'Resolution failed' });
      }
    },
  },

  // Logs
  {
    method: 'GET',
    match: (p) => p === '/api/logs' ? {} : null,
    handler: async (_req, res, _params, url) => {
      try {
        const data = await handleLogsList(url.searchParams);
        sendJSON(res, 200, data);
      } catch (err: unknown) { sendJSON(res, 500, { error: (err as Error).message }); }
    },
  },

  // Agents
  {
    method: 'GET',
    match: (p) => p === '/api/agents' ? {} : null,
    handler: async (_req, res) => {
      try {
        const data = await handleAgentsList();
        sendJSON(res, 200, data);
      } catch (err: unknown) { sendJSON(res, 500, { error: (err as Error).message }); }
    },
  },

  // OpenAB instances
  {
    method: 'GET',
    match: (p) => p === '/api/openab/instances' ? {} : null,
    handler: async (_req, res) => {
      try {
        const data = await handleOpenABInstances();
        sendJSON(res, 200, data);
      } catch (err: unknown) { sendJSON(res, 500, { error: (err as Error).message }); }
    },
  },

  // Webhook (webhook secret auth)
  {
    method: 'POST',
    match: (p) => p === '/webhook' ? {} : null,
    handler: async (req, res) => {
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
      } catch (err: unknown) { sendJSON(res, 400, { error: (err as Error).message }); }
    },
  },

  // Agent profiles API (catch-all GET, no auth needed)
  {
    method: 'GET',
    match: (p) => (handleReadOnlyAgentProfileApi(p) ? {} : null),
    handler: async (_req, res, _params, url) => {
      const apiResult = handleReadOnlyAgentProfileApi(url.pathname);
      if (apiResult) {
        sendJSON(res, apiResult.status, apiResult.body);
      }
    },
  },

  // Static app (catch-all GET)
  {
    method: 'GET',
    match: () => ({}),
    handler: async (req, res, _params, url) => {
      handleStaticApp(req, res, url.pathname);
    },
  },
];

// ── guards applied per-route or globally ───────────────────

const dispatchRequest = createRouter(routes);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Drain guard: reject mutations when draining
  const drainResult = await drainGuard(req, res);
  if (!drainResult) return;

  // Dashboard read auth: check before dispatch for applicable routes
  if (requiresDashboardReadAuth(req)) {
    const authResult = await dashboardReadGuard(req, res);
    if (!authResult) return;
  }

  await dispatchRequest(req, res);
});

// ── issue poller ───────────────────────────────────────────

async function listOpenIssuesForAgent(agentKey: string) {
  const seen = new Set<number>();
  const results: unknown[] = [];
  const labelQueries = [`openab/${agentKey}`, 'openab/cancel'];
  for (const labelQuery of labelQueries) {
    try {
      const out = execSync(
        `gh api repos/${REPO}/issues?labels=${encodeURIComponent(labelQuery)}&state=open&per_page=100&sort=created&direction=desc`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
      );
      const issues = JSON.parse(out).filter((i: Record<string, unknown>) => !i.pull_request || !i.draft);
      for (const issue of issues) {
        if (!seen.has(issue.number)) {
          seen.add(issue.number);
          results.push(issue);
        }
      }
    } catch (e: unknown) {
      console.error(`[http] Failed to fetch issues for label "${labelQuery}":`, (e as Error)?.message?.slice(0, 200));
    }
  }
  return results;
}

// ── reconciliation ─────────────────────────────────────────

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
          task: (task as Record<string, unknown>).task_text as string,
          task_text: (task as Record<string, unknown>).task_text as string,
          taskType: (task as Record<string, unknown>).task_type as string || 'review',
          commenter: (task as Record<string, unknown>).commenter as string,
          commentId: (task as Record<string, unknown>).comment_id as string,
          headSha: (task as Record<string, unknown>).reviewed_sha as string,
          repository: task.repository,
          pr: (task as Record<string, unknown>).pr as string,
          agent: task.agent,
          mode: (task as Record<string, unknown>).mode as string,
          policy: (task as Record<string, unknown>).policy as Record<string, unknown> || {},
          lease: task.lease,
        } as Parameters<typeof executeControllerReview>[0]), '[review-reconciler] dispatch execution error:');
    }
  }
}

// ── startup ─────────────────────────────────────────────────

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
  console.log(`  GET  /api/missions - List durable missions`);
  console.log(`  GET  /api/missions/:missionId - Mission detail`);
  console.log(`  POST /api/operator/missions - Create planned mission`);
  console.log(`  GET  /api/workflows - List durable workflows`);
  console.log(`  GET  /api/workflows/:workflowId - Workflow detail`);
  console.log(`  GET  /api/logs    - List bounded redacted logs`);
  console.log(`  GET  /api/agents  - List agents`);
  console.log(`  GET  /api/openab/instances - OpenAB instance dashboard`);
  if (HUMAN_AUTH_ENABLED) {
    console.log(`  POST /api/auth/session - Bootstrap human operator session`);
    console.log(`  GET  /api/auth/session - Read current human operator session`);
    console.log(`  DELETE /api/auth/session - Revoke current human operator session`);
  }
  if (AGENT_LIFECYCLE_ENABLED) console.log(`  POST /api/operator/agents/:agent/stop - Guarded graceful stop`);
  if (AGENT_LIFECYCLE_ENABLED) console.log(`  POST /api/operator/agents/:agent/start - Guarded graceful start`);
  console.log(`  WORKSPACE_BASE   - ${WORKSPACE_BASE}`);
});

// ── shutdown ────────────────────────────────────────────────

let shutdownPromise: Promise<void> | null = null;

function closeServer() {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function shutdown(signal: string) {
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
