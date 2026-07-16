import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TASK_SCHEMA = 'ops-room.review-task.v2';
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

const ACTIVE_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);
const CONCURRENCY_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);

const DEFAULT_CONCURRENCY = {
  global: parseInt(process.env.OPENAB_REVIEW_MAX_GLOBAL || '5', 10),
  per_repository: parseInt(process.env.OPENAB_REVIEW_MAX_PER_REPO || '3', 10),
  per_pr: parseInt(process.env.OPENAB_REVIEW_MAX_PER_PR || '1', 10),
};

const TRANSITIONS = new Map([
  ['QUEUED', new Set(['CLAIMED', 'SUPERSEDED', 'CANCELLED', 'NEEDS_HUMAN', 'ERROR', 'PAUSED'])],
  ['FIX_QUEUED', new Set(['CLAIMED', 'SUPERSEDED', 'CANCELLED', 'NEEDS_HUMAN', 'ERROR', 'PAUSED'])],
  ['PAUSED', new Set(['QUEUED', 'FIX_QUEUED'])],
  ['CLAIMED', new Set(['RUNNING', 'FIXING', 'SUPERSEDED', 'CANCEL_REQUESTED', 'ERROR', 'QUEUED'])],
  ['RUNNING', new Set(['PASSED', 'CHANGES_REQUESTED', 'SUPERSEDED', 'CANCEL_REQUESTED', 'NEEDS_HUMAN', 'ERROR', 'QUEUED'])],
  ['CHANGES_REQUESTED', new Set(['CHANGES_REQUESTED', 'FIX_QUEUED', 'NEEDS_HUMAN', 'CANCELLED'])],
  ['PASSED', new Set(['PASSED'])],
  ['FIX_PUSHED', new Set(['FIX_PUSHED'])],
  ['FIXING', new Set(['FIX_PUSHED', 'SUPERSEDED', 'CANCEL_REQUESTED', 'CANCELLED', 'NEEDS_HUMAN', 'ERROR'])],
  ['CANCEL_REQUESTED', new Set(['CANCELLED', 'SUPERSEDED', 'ERROR'])],
  ['ERROR', new Set(['QUEUED', 'NEEDS_HUMAN'])],
  ['NEEDS_HUMAN', new Set(['QUEUED'])],
  ['SUPERSEDED', new Set(['QUEUED'])],
  ['CANCELLED', new Set(['QUEUED'])],
]);

function safePart(value, fallback = 'unknown') {
  const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function now() {
  return new Date().toISOString();
}

function taskPath(dir, id) {
  if (!SAFE_ID.test(String(id))) throw new Error(`Invalid task ID: ${id}`);
  return join(dir, `${id}.json`);
}

function claimPath(dir, id) {
  if (!SAFE_ID.test(String(id))) throw new Error(`Invalid task ID: ${id}`);
  return join(dir, `${id}.claim`);
}

export function buildReviewTaskId({ repository, pr, headSha, agent, mode = 'review', taskType = 'review', commentId = null }) {
  const prefix = taskType === 'chat' ? 'pr-chat' : 'review';
  const parts = [
    prefix,
    safePart(repository),
    Number(pr),
    safePart(headSha, 'missing-sha'),
    safePart(agent),
    safePart(mode, 'review'),
  ];
  if (taskType === 'chat' && commentId) {
    parts.push(safePart(String(commentId), 'chat'));
  }
  return parts.join(':');
}

export function buildFixTaskId({ repository, pr, reviewedSha, parentTaskId, agent }) {
  return [
    'fix',
    safePart(repository),
    Number(pr),
    safePart(reviewedSha, 'missing-sha'),
    safePart(parentTaskId),
    safePart(agent),
  ].join(':');
}

export async function writeAtomic(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await rename(tempPath, path);
}

export async function readTask({ dir, id }) {
  try {
    return JSON.parse(await readFile(taskPath(dir, id), 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listReviewTasks({ dir, limit = 100 }) {
  let names;
  try { names = await readdir(dir); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const tasks = (await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readTask({ dir, id: name.slice(0, -5) })))).filter(Boolean);
  return tasks.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

export async function createOrClaimTask({ dir, input, trigger = 'unknown', policy = {}, parentTaskId = null, kind = 'review' }) {
  await mkdir(dir, { recursive: true });
  const id = kind === 'fix'
    ? buildFixTaskId({ ...input, parentTaskId, agent: input.agent })
    : buildReviewTaskId({ ...input, taskType: input.taskType || input.task_type || 'review', commentId: input.commentId || input.comment_id || null });
  const path = taskPath(dir, id);

  try {
    const handle = await open(path, 'wx');
    const createdAt = now();
    const task = {
      schema: TASK_SCHEMA,
      id,
      kind,
      repository: input.repository,
      pr: Number(input.pr),
      reviewed_sha: input.headSha || input.reviewedSha,
      agent: input.agent,
      mode: input.mode || 'review',
      trigger,
      parent_task_id: parentTaskId,
      policy,
      review_result: input.review_result || null,
      head_ref: input.headRef || null,
      task_type: input.taskType || input.task_type || 'review',
      comment_id: input.commentId || input.comment_id || null,
      commenter: input.commenter || null,
      task_text: input.task || null,
      state: 'QUEUED',
      attempt: 0,
      created_at: createdAt,
      updated_at: createdAt,
      history: [{ from: null, to: 'QUEUED', at: createdAt, reason: 'created' }],
    };
    try {
      await handle.writeFile(`${JSON.stringify(task, null, 2)}\n`, 'utf-8');
    } finally {
      await handle.close();
    }
    return { created: true, task };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const task = await readTask({ dir, id });
    if (!task) throw new Error(`Task appeared concurrently but cannot be read: ${id}`);
    return { created: false, task };
  }
}

export async function transitionTask({ dir, id, to, reason, patch = {}, leaseEpoch }) {
  const current = await readTask({ dir, id });
  if (!current) throw new Error(`Task not found: ${id}`);
  if (!TRANSITIONS.get(current.state)?.has(to)) {
    throw new Error(`Invalid task transition: ${current.state} -> ${to}`);
  }

  // Lease epoch fencing: if the task already has a lease, require exact epoch
  // equality for all state transitions. This prevents a stale worker from
  // mutating state after its lease has been superseded by a newer claim.
  if (leaseEpoch !== undefined && current.lease?.lease_epoch !== undefined) {
    if (leaseEpoch !== current.lease.lease_epoch) {
      throw new Error(`Lease epoch mismatch: presented ${leaseEpoch}, current ${current.lease.lease_epoch}`);
    }
  }

  const updatedAt = now();
  const updated = {
    ...current,
    ...patch,
    state: to,
    updated_at: updatedAt,
    history: [...(current.history || []), { from: current.state, to, at: updatedAt, reason }],
  };
  await writeAtomic(taskPath(dir, id), updated);
  return updated;
}

export async function requestCancellation({ dir, id, actor = 'unknown', reason = 'requested' }) {
  const current = await readTask({ dir, id });
  if (!current) throw new Error(`Task not found: ${id}`);
  const to = current.state === 'QUEUED' || current.state === 'FIX_QUEUED' ? 'CANCELLED' : 'CANCEL_REQUESTED';
  return transitionTask({
    dir,
    id,
    to,
    reason: to === 'CANCELLED' ? 'queued_cancellation_requested' : 'cancellation_requested',
    patch: {
      cancellation: { actor, reason, requested_at: now() },
    },
  });
}

export async function claimTask({ dir, id, instanceId, leaseId, leaseEpoch = 1 }) {
  const path = claimPath(dir, id);
  const claim = {
    task_id: id,
    instance_id: instanceId,
    lease_id: leaseId,
    lease_epoch: leaseEpoch,
    claimed_at: now(),
    heartbeat_at: now(),
  };
  try {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, 'utf-8');
    } finally {
      await handle.close();
    }
    return { claimed: true, claim };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return { claimed: false, claim: JSON.parse(await readFile(path, 'utf-8')) };
  }
}

export async function renewClaim({ dir, id, leaseId, leaseEpoch, now: heartbeatAt = now() }) {
  const path = claimPath(dir, id);
  let current;
  try {
    current = JSON.parse(await readFile(path, 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Claim not found: ${id}`);
    throw error;
  }
  // Validate lease ownership: only the current holder can renew.
  if (leaseId !== undefined && current.lease_id !== leaseId) {
    throw new Error(`Lease ID mismatch: presented ${leaseId}, current ${current.lease_id}`);
  }
  if (leaseEpoch !== undefined && current.lease_epoch !== leaseEpoch) {
    throw new Error(`Lease epoch mismatch: presented ${leaseEpoch}, current ${current.lease_epoch}`);
  }
  const renewed = { ...current, heartbeat_at: heartbeatAt };
  await writeAtomic(path, renewed);
  return renewed;
}

export function isClaimStale(claim, { now: currentTime = now(), staleMinutes = 30 } = {}) {
  if (!claim?.heartbeat_at) return true;

  // Fast path: if the claiming process is dead, the claim is stale immediately.
  // instance_id is "ops-room-{PID}" — extract PID and check if it still exists.
  if (claim?.instance_id) {
    const pid = parseInt(claim.instance_id.split('-').pop(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);  // signal 0 just checks existence, doesn't kill
      } catch (error) {
        if (error?.code === 'ESRCH') return true;  // process doesn't exist
        // EPERM or similar — process exists but we can't signal it. Not stale.
      }
    }
  }

  // Fallback: clock-based staleness check for cases where PID check is inconclusive.
  const heartbeatMs = Date.parse(claim.heartbeat_at);
  const currentMs = Date.parse(currentTime);
  if (!Number.isFinite(heartbeatMs) || !Number.isFinite(currentMs)) return true;
  return currentMs - heartbeatMs > staleMinutes * 60_000;
}

export async function releaseClaim({ dir, id }) {
  await rm(claimPath(dir, id), { force: true });
}

export async function countActiveTasks({ dir, repository, pr }) {
  let names;
  try { names = await readdir(dir); } catch (error) {
    if (error?.code === 'ENOENT') return { global: 0, repository: 0, pr: 0 };
    throw error;
  }
  let global = 0;
  let repoCount = 0;
  let prCount = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const task = JSON.parse(await readFile(join(dir, name), 'utf-8'));
      if (CONCURRENCY_STATES.has(task.state)) {
        global += 1;
        if (repository && task.repository === repository) {
          repoCount += 1;
          if (pr !== undefined && task.pr === Number(pr)) prCount += 1;
        }
      }
    } catch { /* skip corrupt files */ }
  }
  return { global, repository: repoCount, pr: prCount };
}

export function checkConcurrency({ counts, limits = {} }) {
  const global = limits.global ?? DEFAULT_CONCURRENCY.global;
  const perRepo = limits.per_repository ?? DEFAULT_CONCURRENCY.per_repository;
  const perPr = limits.per_pr ?? DEFAULT_CONCURRENCY.per_pr;
  if (counts.global >= global) return { allowed: false, reason: 'global_concurrency_limit' };
  if (counts.repository >= perRepo) return { allowed: false, reason: 'repository_concurrency_limit' };
  if (counts.pr >= perPr) return { allowed: false, reason: 'pr_concurrency_limit' };
  return { allowed: true };
}

export async function recoverStaleTask({ dir, id, now: currentTime = now(), staleMinutes = 30, retryLimit = 3 }) {
  const task = await readTask({ dir, id });
  if (!task) throw new Error(`Task not found: ${id}`);
  if (!['CLAIMED', 'RUNNING', 'FIXING'].includes(task.state)) return { recovered: false, reason: 'not_active' };
  let claim;
  try {
    claim = JSON.parse(await readFile(claimPath(dir, id), 'utf-8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    claim = null;
  }
  if (claim && !isClaimStale(claim, { now: currentTime, staleMinutes })) {
    return { recovered: false, reason: 'heartbeat_fresh' };
  }
  await releaseClaim({ dir, id });
  const attempt = (task.attempt || 0) + 1;
  const retryBudget = task.policy?.retry_budget ?? retryLimit;
  if (attempt > retryBudget) {
    await transitionTask({
      dir, id, to: 'NEEDS_HUMAN',
      reason: 'retry_budget_exhausted',
      patch: { attempt, completed_at: currentTime, error: 'Retry budget exhausted after stale lease recovery' },
    });
    return { recovered: true, retry_allowed: false };
  }
  const nextEpoch = (task.lease?.lease_epoch || 0) + 1;
  const retried = await transitionTask({
    dir, id, to: 'QUEUED',
    reason: 'stale_lease_requeued',
    patch: { attempt, lease: { lease_epoch: nextEpoch }, heartbeat_at: null },
  });
  return { recovered: true, retry_allowed: true, re_dispatched: true, attempt };
}

export async function retryTask({ dir, id, reason = 'operator_retry' }) {
  const task = await readTask({ dir, id });
  if (!task) throw new Error(`Task not found: ${id}`);
  const retryableStates = new Set(['ERROR', 'NEEDS_HUMAN', 'SUPERSEDED', 'CANCELLED']);
  if (!retryableStates.has(task.state)) {
    throw new Error(`Cannot retry task in state: ${task.state}`);
  }
  await releaseClaim({ dir, id });
  const attempt = (task.attempt || 0) + 1;
  return transitionTask({
    dir, id, to: 'QUEUED',
    reason,
    patch: { attempt, lease: null, heartbeat_at: null, error: null, cancellation: null },
  });
}

export async function pauseTask({ dir, id, reason = 'operator_paused' }) {
  const task = await readTask({ dir, id });
  if (!task) throw new Error(`Task not found: ${id}`);
  const pausableStates = new Set(['QUEUED', 'FIX_QUEUED']);
  if (!pausableStates.has(task.state)) {
    throw new Error(`Cannot pause task in state: ${task.state}`);
  }
  return transitionTask({
    dir, id, to: 'PAUSED',
    reason,
    patch: { paused_at: now(), pause_reason: reason },
  });
}

export async function resumeTask({ dir, id, reason = 'operator_resumed' }) {
  const task = await readTask({ dir, id });
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.state !== 'PAUSED') {
    throw new Error(`Cannot resume task in state: ${task.state}`);
  }
  return transitionTask({
    dir, id, to: task.kind === 'fix' ? 'FIX_QUEUED' : 'QUEUED',
    reason,
    patch: { paused_at: null, pause_reason: null },
  });
}

export function isTerminalState(state) {
  return !TRANSITIONS.has(state) && state !== 'PAUSED';
}
