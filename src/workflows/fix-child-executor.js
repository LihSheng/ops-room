import { randomUUID } from 'node:crypto';
import { claimTask, readTask, transitionTask } from '../services/review-task-store.js';
import { ensureTaskWorkspace, taskWorkspacePatch } from '../services/task-workspace-binding.js';
import { applyTaskWorkspaceOutcome } from '../services/task-workspace-lifecycle.js';
import { REPOSITORY_CACHE_ROOT, TASK_WORKSPACE_ROOT, WORKSPACE_RECORDS_DIR, WORKSPACE_LOCK_DIR, WORKSPACE_MAX_ACTIVE, WORKSPACE_MIN_FREE_BYTES, } from '../services/runtime-paths.js';
function stateForFixOutcome(outcome) {
    if (outcome === 'FIX_PUSHED')
        return 'FIX_PUSHED';
    if (outcome === 'SUPERSEDED')
        return 'SUPERSEDED';
    if (outcome === 'CANCELLED')
        return 'CANCELLED';
    if (outcome === 'NEEDS_HUMAN')
        return 'NEEDS_HUMAN';
    return 'ERROR';
}
export async function executeFixChildTask({ dir, id, instanceId, runWorker, preClaimedLease, ensureWorkspace = ensureTaskWorkspace, applyOutcome = applyTaskWorkspaceOutcome, workspaceConfig = {}, }) {
    let task = await readTask({ dir, id });
    if (!task)
        throw new Error(`Fix task not found: ${id}`);
    let lease;
    if (preClaimedLease) {
        if (!['CLAIMED', 'FIXING', 'QUEUED', 'FIX_QUEUED'].includes(task.state)) {
            return { state: task.state, deduplicated: true };
        }
        lease = preClaimedLease;
    }
    else {
        if (!['QUEUED', 'FIX_QUEUED'].includes(task.state)) {
            return { state: task.state, deduplicated: true };
        }
        const claimed = await claimTask({
            dir, id, instanceId, leaseId: randomUUID(), leaseEpoch: (task.lease?.lease_epoch || 0) + 1,
        });
        if (!claimed.claimed)
            return { state: (await readTask({ dir, id }))?.state || 'CLAIMED', deduplicated: true };
        lease = claimed.claim;
        task = await transitionTask({
            dir, id, to: 'CLAIMED', reason: 'fix_child_claimed',
            patch: { lease, started_at: new Date().toISOString() },
        });
    }
    const binding = await ensureWorkspace({
        task,
        cacheRoot: workspaceConfig.cacheRoot || REPOSITORY_CACHE_ROOT,
        workspaceRoot: workspaceConfig.workspaceRoot || TASK_WORKSPACE_ROOT,
        recordRoot: workspaceConfig.recordRoot || WORKSPACE_RECORDS_DIR,
        lockRoot: workspaceConfig.lockRoot || WORKSPACE_LOCK_DIR,
        remote: workspaceConfig.remote || `https://github.com/${task.repository}.git`,
        maxActiveWorkspaces: workspaceConfig.maxActiveWorkspaces || WORKSPACE_MAX_ACTIVE,
        minimumFreeBytes: workspaceConfig.minimumFreeBytes ?? WORKSPACE_MIN_FREE_BYTES,
    });
    if (task.state !== 'FIXING') {
        task = await transitionTask({
            dir, id, to: 'FIXING',
            reason: binding.reused ? 'fix_workspace_recovered' : 'fix_workspace_allocated',
            patch: { heartbeat_at: new Date().toISOString(), ...taskWorkspacePatch(binding) },
            leaseEpoch: lease.lease_epoch,
        });
    }
    else if (!task.workspace_id) {
        throw new Error('fix_workspace_binding_missing');
    }
    let terminal;
    try {
        const persistedTask = await readTask({ dir, id });
        const result = await runWorker({
            task: { ...persistedTask, __workspace_binding: binding },
            lease,
            workspace: binding,
        });
        const state = stateForFixOutcome(result?.outcome);
        terminal = await transitionTask({
            dir, id, to: state,
            reason: `fix_${String(result?.outcome || 'error').toLowerCase()}`,
            patch: { completed_at: new Date().toISOString(), result },
            leaseEpoch: lease.lease_epoch,
        });
    }
    catch (error) {
        const state = error?.name === 'FixSupersededError' ? 'SUPERSEDED' : 'ERROR';
        terminal = await transitionTask({
            dir, id, to: state,
            reason: state === 'SUPERSEDED' ? 'fix_stale_sha' : 'fix_worker_error',
            patch: { completed_at: new Date().toISOString(), error: error?.message || String(error) },
            leaseEpoch: lease.lease_epoch,
        });
    }
    await applyOutcome({
        task: terminal,
        recordRoot: workspaceConfig.recordRoot || WORKSPACE_RECORDS_DIR,
    });
    return terminal;
}
//# sourceMappingURL=fix-child-executor.js.map