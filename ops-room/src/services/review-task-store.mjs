import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TASK_SCHEMA = 'ops-room.review-task.v2';
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

const TRANSITIONS = new Map([
  ['QUEUED', new Set(['CLAIMED', 'SUPERSEDED', 'CANCELLED', 'NEEDS_HUMAN', 'ERROR'])],
  ['CLAIMED', new Set(['RUNNING', 'FIXING', 'SUPERSEDED', 'CANCEL_REQUESTED', 'ERROR'])],
  ['RUNNING', new Set(['PASSED', 'CHANGES_REQUESTED', 'SUPERSEDED', 'CANCEL_REQUESTED', 'NEEDS_HUMAN', 'ERROR'])],
  ['CHANGES_REQUESTED', new Set(['FIX_QUEUED', 'NEEDS_HUMAN', 'CANCELLED'])],
  ['FIX_QUEUED', new Set(['CLAIMED', 'SUPERSEDED', 'CANCELLED', 'NEEDS_HUMAN', 'ERROR'])],
  ['FIXING', new Set(['FIX_PUSHED', 'SUPERSEDED', 'CANCEL_REQUESTED', 'NEEDS_HUMAN', 'ERROR'])],
  ['CANCEL_REQUESTED', new Set(['CANCELLED', 'SUPERSEDED', 'ERROR'])],
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

export function buildReviewTaskId({ repository, pr, headSha, agent, mode = 'review' }) {
  return [
    'review',
    safePart(repository),
    Number(pr),
    safePart(headSha, 'missing-sha'),
    safePart(agent),
    safePart(mode, 'review'),
  ].join(':');
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

export async function createOrClaimTask({ dir, input, trigger = 'unknown', policy = {}, parentTaskId = null, kind = 'review' }) {
  await mkdir(dir, { recursive: true });
  const id = kind === 'fix'
    ? buildFixTaskId({ ...input, parentTaskId, agent: input.agent })
    : buildReviewTaskId(input);
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

export async function transitionTask({ dir, id, to, reason, patch = {} }) {
  const current = await readTask({ dir, id });
  if (!current) throw new Error(`Task not found: ${id}`);
  if (!TRANSITIONS.get(current.state)?.has(to)) {
    throw new Error(`Invalid task transition: ${current.state} -> ${to}`);
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

export async function releaseClaim({ dir, id }) {
  await rm(claimPath(dir, id), { force: true });
}

export function isTerminalState(state) {
  return !TRANSITIONS.has(state);
}
