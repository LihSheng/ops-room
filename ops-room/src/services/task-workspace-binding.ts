import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

import { allocateWorkspace } from './workspace-manager.js';
import { readWorkspaceRecord } from './workspace-store.js';

const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_ID_PART = /[^A-Za-z0-9._-]+/g;
const USABLE_STATES = new Set(['active', 'held_for_investigation']);

function safePart(value: unknown, fallback = 'unknown') {
  const normalized = String(value ?? '')
    .trim()
    .replace(SAFE_ID_PART, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function assertWithinRoot(root: string, candidate: string) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error('task_workspace_path_escape');
  }
  return resolvedCandidate;
}

function taskWorkspaceId(task: any) {
  const digest = createHash('sha256').update(String(task.id || '')).digest('hex').slice(0, 16);
  return `task-${safePart(task.agent)}-${digest}`;
}

function implementationBranch(task: any) {
  const explicit = String(task.head_ref || task.branch || '').trim();
  if (explicit) return explicit;
  return `agent/${safePart(task.agent)}/${safePart(task.kind || 'task')}-${safePart(task.pr || task.id)}`;
}

export function selectTaskWorkspacePlan(task: any) {
  if (!task || !task.id || !task.repository || !task.agent) throw new Error('task_workspace_input_invalid');
  const reviewedSha = String(task.reviewed_sha || '').trim().toLowerCase();
  const reviewLike = task.kind === 'review' || task.task_type === 'review' || task.mode === 'review';

  if (reviewLike) {
    if (!SAFE_SHA.test(reviewedSha)) throw new Error('task_workspace_exact_sha_required');
    return {
      workspace_id: taskWorkspaceId(task),
      mode: 'detached' as const,
      branch: null,
      revision: reviewedSha,
    };
  }

  const baseRevision = String(task.reviewed_sha || task.base_sha || 'HEAD').trim();
  return {
    workspace_id: taskWorkspaceId(task),
    mode: 'branch' as const,
    branch: implementationBranch(task),
    revision: baseRevision,
  };
}

export function serializeTaskWorkspace(record: any) {
  if (!record) return null;
  return {
    workspace_id: record.workspace_id,
    mode: record.mode,
    repository_id: record.repository_id,
    branch: record.mode === 'branch' ? record.branch : null,
    resolved_sha: record.resolved_sha || null,
    state: record.state,
    held_for_investigation: record.state === 'held_for_investigation',
    cleanup_requested: record.state === 'cleanup_requested',
  };
}

async function validateExistingBinding({
  task,
  workspaceRoot,
  recordRoot,
  workspaceId,
  readRecord,
  statPath,
}: any) {
  let record;
  try {
    record = await readRecord({ dir: recordRoot, workspaceId });
  } catch {
    throw new Error('task_workspace_record_unavailable');
  }

  if (record.task_id !== task.id) throw new Error('task_workspace_task_mismatch');
  if (record.owner_agent !== task.agent) throw new Error('task_workspace_owner_mismatch');
  if (record.repository_id !== task.repository) throw new Error('task_workspace_repository_mismatch');
  if (!USABLE_STATES.has(record.state)) throw new Error('task_workspace_not_usable');

  const workspacePath = assertWithinRoot(workspaceRoot, join(workspaceRoot, record.relative_path));
  try {
    const info = await statPath(workspacePath);
    if (!info.isDirectory()) throw new Error('task_workspace_missing');
  } catch (error: any) {
    if (error?.message === 'task_workspace_missing') throw error;
    throw new Error('task_workspace_missing');
  }

  return { record, workspace_path: workspacePath, reused: true };
}

export async function ensureTaskWorkspace({
  task,
  cacheRoot,
  workspaceRoot,
  recordRoot,
  lockRoot,
  remote,
  maxActiveWorkspaces,
  minimumFreeBytes,
  getFreeBytes,
  allocate = allocateWorkspace,
  readRecord = readWorkspaceRecord,
  statPath = stat,
}: any) {
  const existingWorkspaceId = task?.workspace?.workspace_id || task?.workspace_id || null;
  if (existingWorkspaceId) {
    return validateExistingBinding({
      task,
      workspaceRoot,
      recordRoot,
      workspaceId: existingWorkspaceId,
      readRecord,
      statPath,
    });
  }

  const plan = selectTaskWorkspacePlan(task);
  const record = await allocate({
    cacheRoot,
    workspaceRoot,
    recordRoot,
    lockRoot,
    repositoryId: task.repository,
    remote,
    workspaceId: plan.workspace_id,
    ownerAgent: task.agent,
    taskId: task.id,
    mode: plan.mode,
    branch: plan.branch,
    revision: plan.revision,
    maxActiveWorkspaces,
    minimumFreeBytes,
    getFreeBytes,
  });

  if (record.task_id !== task.id || record.owner_agent !== task.agent || record.repository_id !== task.repository) {
    throw new Error('task_workspace_allocation_mismatch');
  }
  if (record.state !== 'active') throw new Error('task_workspace_allocation_incomplete');

  const workspacePath = assertWithinRoot(workspaceRoot, join(workspaceRoot, record.relative_path));
  return { record, workspace_path: workspacePath, reused: false };
}

export function taskWorkspacePatch(binding: any) {
  return {
    workspace_id: binding.record.workspace_id,
    workspace: serializeTaskWorkspace(binding.record),
  };
}
