import { ensureTaskWorkspace, taskWorkspacePatch } from './task-workspace-binding.js';
import { applyTaskWorkspaceOutcome } from './task-workspace-lifecycle.js';
import { transitionTask } from './review-task-store.js';
const SUCCESS_STATES = new Set(['PASSED', 'FIX_PUSHED']);
const FAILURE_STATES = new Set(['ERROR', 'NEEDS_HUMAN', 'CANCELLED', 'CANCEL_REQUESTED', 'SUPERSEDED']);
function activeStateForTask(task) {
    return task?.kind === 'fix' ? 'FIXING' : 'RUNNING';
}
function validateTerminalState(state) {
    if (!SUCCESS_STATES.has(state) && !FAILURE_STATES.has(state)) {
        throw new Error('task_workspace_terminal_state_invalid');
    }
    return state;
}
export async function executeTaskInWorkspace({ task, taskDir, cacheRoot, workspaceRoot, recordRoot, lockRoot, remote, leaseEpoch, maxActiveWorkspaces, minimumFreeBytes, getFreeBytes, execute, ensureWorkspace = ensureTaskWorkspace, transition = transitionTask, applyOutcome = applyTaskWorkspaceOutcome, }) {
    if (!task?.id || typeof execute !== 'function')
        throw new Error('task_workspace_execution_input_invalid');
    const binding = await ensureWorkspace({
        task,
        cacheRoot,
        workspaceRoot,
        recordRoot,
        lockRoot,
        remote,
        maxActiveWorkspaces,
        minimumFreeBytes,
        getFreeBytes,
    });
    const activeTask = await transition({
        dir: taskDir,
        id: task.id,
        to: activeStateForTask(task),
        reason: binding.reused ? 'workspace_recovered' : 'workspace_allocated',
        patch: taskWorkspacePatch(binding),
        leaseEpoch,
    });
    let terminalState;
    let terminalPatch = {};
    try {
        const result = await execute({ task: activeTask, cwd: binding.workspace_path, workspace: binding.record });
        terminalState = validateTerminalState(String(result?.state || ''));
        terminalPatch = result?.patch && typeof result.patch === 'object' ? result.patch : {};
    }
    catch (error) {
        terminalState = 'ERROR';
        terminalPatch = { last_error: String(error?.message || 'task_execution_failed').slice(0, 300) };
    }
    const terminalTask = await transition({
        dir: taskDir,
        id: task.id,
        to: terminalState,
        reason: terminalState === 'ERROR' ? 'workspace_execution_failed' : 'workspace_execution_completed',
        patch: terminalPatch,
        leaseEpoch,
    });
    const workspaceOutcome = await applyOutcome({ task: terminalTask, recordRoot });
    return {
        task: terminalTask,
        workspace: workspaceOutcome.workspace,
        workspace_action: workspaceOutcome.action,
        workspace_reused: binding.reused,
    };
}
//# sourceMappingURL=task-workspace-execution.js.map