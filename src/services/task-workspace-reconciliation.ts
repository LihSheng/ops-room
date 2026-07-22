import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { readWorkspaceRecord } from './workspace-store.js';

const ACTIVE_TASK_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING', 'CANCEL_REQUESTED']);

function workspaceIdFromTask(task: any) {
  return task?.workspace?.workspace_id || task?.workspace_id || null;
}

function assertWithinRoot(root: string, candidate: string) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error('task_workspace_path_escape');
  }
  return resolvedCandidate;
}

export async function reconcileTaskWorkspace({
  task,
  workspaceRoot,
  recordRoot,
  readRecord = readWorkspaceRecord,
  statPath = stat,
}: any) {
  const workspaceId = workspaceIdFromTask(task);
  if (!workspaceId) {
    return {
      status: ACTIVE_TASK_STATES.has(task?.state) ? 'legacy_unbound' : 'not_bound',
      reason_code: ACTIVE_TASK_STATES.has(task?.state) ? 'legacy_task_without_workspace' : null,
      workspace: null,
    };
  }

  let record;
  try {
    record = await readRecord({ dir: recordRoot, workspaceId });
  } catch {
    return { status: 'blocked', reason_code: 'workspace_record_unavailable', workspace: null };
  }

  if (record.task_id !== task.id) return { status: 'blocked', reason_code: 'workspace_task_mismatch', workspace: null };
  if (record.owner_agent !== task.agent) return { status: 'blocked', reason_code: 'workspace_owner_mismatch', workspace: null };
  if (record.repository_id !== task.repository) return { status: 'blocked', reason_code: 'workspace_repository_mismatch', workspace: null };

  let workspacePath;
  try {
    workspacePath = assertWithinRoot(workspaceRoot, join(workspaceRoot, record.relative_path));
    const info = await statPath(workspacePath);
    if (!info.isDirectory()) throw new Error('missing');
  } catch {
    return { status: 'blocked', reason_code: 'workspace_directory_missing', workspace: record };
  }

  if (ACTIVE_TASK_STATES.has(task.state) && record.state !== 'active' && record.state !== 'held_for_investigation') {
    return { status: 'blocked', reason_code: 'workspace_state_not_executable', workspace: record };
  }

  return {
    status: 'ready',
    reason_code: null,
    workspace: record,
    workspace_path: workspacePath,
  };
}

export async function reconcileTaskWorkspaces({
  tasks,
  workspaceRoot,
  recordRoot,
  reconcile = reconcileTaskWorkspace,
}: any) {
  const results = [];
  for (const task of tasks || []) {
    results.push({
      task_id: task.id,
      ...(await reconcile({ task, workspaceRoot, recordRoot })),
    });
  }
  return results;
}
