import { requestWorkspaceCleanup } from './workspace-manager.js';
import { readWorkspaceRecord, updateWorkspaceRecord } from './workspace-store.js';
const SUCCESS_STATES = new Set(['PASSED', 'FIX_PUSHED']);
const INVESTIGATION_STATES = new Set(['ERROR', 'NEEDS_HUMAN', 'CANCELLED', 'CANCEL_REQUESTED', 'SUPERSEDED']);
function workspaceIdFromTask(task) {
    return task?.workspace?.workspace_id || task?.workspace_id || null;
}
export function classifyTaskWorkspaceOutcome(task) {
    if (!task || !task.state)
        return 'none';
    if (SUCCESS_STATES.has(task.state))
        return 'cleanup';
    if (INVESTIGATION_STATES.has(task.state))
        return 'hold';
    return 'preserve';
}
export async function applyTaskWorkspaceOutcome({ task, recordRoot, requestCleanup = requestWorkspaceCleanup, readRecord = readWorkspaceRecord, updateRecord = updateWorkspaceRecord, now = () => new Date().toISOString(), }) {
    const workspaceId = workspaceIdFromTask(task);
    if (!workspaceId)
        return { action: 'none', workspace: null };
    let record;
    try {
        record = await readRecord({ dir: recordRoot, workspaceId });
    }
    catch {
        throw new Error('task_workspace_record_unavailable');
    }
    if (record.task_id !== task.id)
        throw new Error('task_workspace_task_mismatch');
    if (record.owner_agent !== task.agent)
        throw new Error('task_workspace_owner_mismatch');
    if (record.repository_id !== task.repository)
        throw new Error('task_workspace_repository_mismatch');
    const action = classifyTaskWorkspaceOutcome(task);
    if (action === 'cleanup') {
        if (record.state === 'cleanup_requested' || record.state === 'released') {
            return { action: 'cleanup', workspace: record, idempotent: true };
        }
        if (record.state !== 'active')
            throw new Error('task_workspace_cleanup_not_safe');
        const workspace = await requestCleanup({ recordRoot, workspaceId, now });
        return { action: 'cleanup', workspace, idempotent: false };
    }
    if (action === 'hold') {
        if (record.state === 'held_for_investigation') {
            return { action: 'hold', workspace: record, idempotent: true };
        }
        if (!['active', 'failed', 'cleanup_requested'].includes(record.state)) {
            throw new Error('task_workspace_hold_not_safe');
        }
        const workspace = await updateRecord({
            dir: recordRoot,
            workspaceId,
            patch: {
                state: 'held_for_investigation',
                hold_reason: `task_${String(task.state).toLowerCase()}`.slice(0, 300),
            },
            now,
        });
        return { action: 'hold', workspace, idempotent: false };
    }
    return { action: 'preserve', workspace: record, idempotent: true };
}
//# sourceMappingURL=task-workspace-lifecycle.js.map