import { mkdir, open, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { withAgentLifecycleGate } from './agent-lifecycle-store.js';
import { reconcileTaskWorkspace } from './task-workspace-reconciliation.js';
import { applyTaskWorkspaceOutcome } from './task-workspace-lifecycle.js';
import { TASK_WORKSPACE_ROOT, WORKSPACE_RECORDS_DIR } from './runtime-paths.js';
import {
  countActiveTasks,
  checkConcurrency,
  claimTask,
  transitionTask,
  recoverStaleTask,
  scanReviewTasks,
} from './review-task-store.js';

const ACTIVE_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);
const DISPATCHABLE_STATES = new Set(['QUEUED', 'FIX_QUEUED']);
const TERMINAL_WORKSPACE_STATES = new Set([
  'PASSED', 'FIX_PUSHED', 'ERROR', 'NEEDS_HUMAN', 'CANCELLED', 'CANCEL_REQUESTED', 'SUPERSEDED',
]);

export async function reconcileReviewTasks({
  dir,
  now,
  staleMinutes = 30,
  retryLimit = 3,
  workspaceRoot = TASK_WORKSPACE_ROOT,
  workspaceRecordRoot = WORKSPACE_RECORDS_DIR,
  reconcileWorkspace = reconcileTaskWorkspace,
  applyWorkspaceOutcome = applyTaskWorkspaceOutcome,
}) {
  const { scanned, tasks, corrupt } = await scanReviewTasks({ dir });
  const recovered = [];
  const reDispatched = [];
  const workspaceBlocked = [];
  const legacyUnbound = [];
  const workspaceOutcomes = [];
  const workspaceOutcomeErrors = [];

  for (const task of tasks) {
    if (task.workspace_id && TERMINAL_WORKSPACE_STATES.has(task.state)) {
      try {
        const outcome = await applyWorkspaceOutcome({ task, recordRoot: workspaceRecordRoot });
        workspaceOutcomes.push({ task_id: task.id, action: outcome.action, idempotent: outcome.idempotent === true });
      } catch (error) {
        workspaceOutcomeErrors.push({ task_id: task.id, reason_code: String(error?.message || 'workspace_outcome_failed').slice(0, 120) });
      }
      continue;
    }

    if (!ACTIVE_STATES.has(task.state)) continue;
    const workspace = await reconcileWorkspace({ task, workspaceRoot, recordRoot: workspaceRecordRoot });
    if (workspace.status === 'blocked') {
      await transitionTask({
        dir,
        id: task.id,
        to: 'NEEDS_HUMAN',
        reason: `workspace_reconciliation_blocked:${workspace.reason_code}`,
        patch: { workspace_reconciliation: { status: workspace.status, reason_code: workspace.reason_code } },
        leaseEpoch: task.lease?.lease_epoch,
      });
      workspaceBlocked.push({ task_id: task.id, reason_code: workspace.reason_code });
      continue;
    }
    if (workspace.status === 'legacy_unbound') legacyUnbound.push(task.id);

    const result = await recoverStaleTask({ dir, id: task.id, now, staleMinutes, retryLimit });
    if (result.recovered) {
      recovered.push(task.id);
      if (result.re_dispatched) reDispatched.push(task.id);
    }
  }
  return {
    scanned,
    recovered,
    re_dispatched: reDispatched,
    corrupt,
    workspace_blocked: workspaceBlocked,
    legacy_unbound: legacyUnbound,
    workspace_outcomes: workspaceOutcomes,
    workspace_outcome_errors: workspaceOutcomeErrors,
  };
}

async function acquireSlotLock(dir, repository, pr) {
  const locksDir = join(dir, '.locks');
  await mkdir(locksDir, { recursive: true });
  const now = Date.now();
  const meta = JSON.stringify({ pid: process.pid, at: now });
  const levels = [
    { key: 'global', path: join(locksDir, 'global.lock') },
    { key: `repo:${repository.replace(/\//g, '_')}`, path: join(locksDir, `repo_${repository.replace(/\//g, '_')}.lock`) },
    { key: `pr:${repository.replace(/\//g, '_')}:${pr}`, path: join(locksDir, `pr_${repository.replace(/\//g, '_')}_${pr}.lock`) },
  ];
  const acquired = [];
  const staleTimeoutMs = 120_000;

  for (const level of levels) {
    try {
      const handle = await open(level.path, 'wx');
      await handle.writeFile(meta, 'utf-8');
      await handle.close();
      acquired.push(level.path);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        try {
          const content = JSON.parse(await readFile(level.path, 'utf-8'));
          const age = now - (content.at || 0);
          if (age > staleTimeoutMs) {
            try {
              await rm(level.path, { force: true });
              const handle = await open(level.path, 'wx');
              await handle.writeFile(meta, 'utf-8');
              await handle.close();
              acquired.push(level.path);
              continue;
            } catch {}
          }
        } catch {}
        await releaseSlotLocks(acquired);
        return { acquired: false };
      }
      throw error;
    }
  }
  return { acquired: true, paths: acquired };
}

async function releaseSlotLocks(paths) {
  for (const path of paths) {
    try { await rm(path, { force: true }); } catch {}
  }
}

async function releaseSlotLock(result) {
  if (result?.paths) await releaseSlotLocks(result.paths);
}

async function dispatchAllowed(canDispatchAgent, agent) {
  try {
    return await canDispatchAgent(agent) !== false;
  } catch {
    return false;
  }
}

export async function dispatchEligibleTasks({
  dir,
  instanceId,
  canDispatchAgent = async () => true,
  withAgentDispatchGate = withAgentLifecycleGate,
}) {
  const { tasks } = await scanReviewTasks({ dir });
  const dispatched = [];
  for (const task of tasks) {
    if (!DISPATCHABLE_STATES.has(task.state)) continue;

    const claimedTask = await withAgentDispatchGate(task.agent, async () => {
      if (!(await dispatchAllowed(canDispatchAgent, task.agent))) return null;
      const lock = await acquireSlotLock(dir, task.repository, task.pr);
      if (!lock.acquired) return null;
      try {
        if (!(await dispatchAllowed(canDispatchAgent, task.agent))) return null;
        const counts = await countActiveTasks({ dir, repository: task.repository, pr: task.pr });
        const concurrency = checkConcurrency({ counts, limits: task.policy?.concurrency || {} });
        if (!concurrency.allowed) return null;
        const leaseEpoch = (task.lease?.lease_epoch || 0) + 1;
        const claimed = await claimTask({ dir, id: task.id, instanceId, leaseId: randomUUID(), leaseEpoch });
        if (!claimed.claimed) return null;
        const transitioned = await transitionTask({
          dir,
          id: task.id,
          to: 'CLAIMED',
          reason: 'reconciler_claimed',
          patch: {
            lease: claimed.claim,
            attempt: (task.attempt || 0) + 1,
            started_at: new Date().toISOString(),
            heartbeat_at: new Date().toISOString(),
          },
        });
        return { ...transitioned, lease: claimed.claim };
      } finally {
        await releaseSlotLock(lock);
      }
    });
    if (claimedTask) dispatched.push(claimedTask);
  }
  return { dispatched: dispatched.length, tasks: dispatched };
}
