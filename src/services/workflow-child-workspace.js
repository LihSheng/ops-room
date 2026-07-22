import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeAtomic } from './review-task-store.js';
import { ensureTaskWorkspace, serializeTaskWorkspace } from './task-workspace-binding.js';
import { readWorkflowRun, validateWorkflowRun } from './workflow-run-store.js';
import { withWorkspaceLock } from './workspace-locks.js';
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const BINDABLE_CHILD_STATES = new Set(['pending', 'active']);
const USABLE_WORKSPACE_STATE = 'active';
function safePart(value, fallback = 'unknown') {
    const normalized = String(value ?? '')
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return normalized || fallback;
}
function workflowDigest(workflowId, length = 16) {
    return createHash('sha256').update(workflowId).digest('hex').slice(0, length);
}
function workflowFilename(workflowId) {
    return `workflow-${createHash('sha256').update(workflowId).digest('hex')}.json`;
}
function workflowPath(dir, workflowId) {
    return join(dir, workflowFilename(workflowId));
}
function workspaceIdForChild(child) {
    const digest = createHash('sha256').update(String(child.child_id || '')).digest('hex').slice(0, 16);
    return `task-${safePart(child.owner_agent)}-${digest}`;
}
function canonicalFeatureBranch(run, child) {
    return `agent/professor/feature-${workflowDigest(run.workflow_id)}-i${child.iteration}`;
}
function testBranch(run, child) {
    return `agent/tokyo/tests-${workflowDigest(run.workflow_id)}-i${child.iteration}`;
}
function findChild(run, childId) {
    const child = run.children.find((candidate) => candidate.child_id === childId);
    if (!child)
        throw new Error('workflow_child_not_found');
    return child;
}
export function selectWorkflowChildWorkspacePlan({ run, child }) {
    validateWorkflowRun(run);
    const canonicalChild = findChild(run, child?.child_id);
    const revision = String(canonicalChild.input_sha || '').toLowerCase();
    if (!SAFE_SHA.test(revision))
        throw new Error('workflow_child_workspace_exact_sha_required');
    let mode;
    let branch;
    if (canonicalChild.stage === 'review') {
        mode = 'detached';
        branch = null;
    }
    else if (canonicalChild.stage === 'test') {
        mode = 'branch';
        branch = testBranch(run, canonicalChild);
    }
    else {
        mode = 'branch';
        branch = canonicalFeatureBranch(run, canonicalChild);
    }
    return {
        workspace_id: workspaceIdForChild(canonicalChild),
        mode,
        branch,
        revision,
    };
}
function taskForChild(run, child, plan, existingWorkspace = null) {
    const review = child.stage === 'review';
    return {
        id: child.child_id,
        kind: review ? 'review' : 'workflow',
        task_type: review ? 'review' : 'workflow',
        mode: review ? 'review' : 'workflow',
        repository: run.repository_id,
        reviewed_sha: child.input_sha,
        agent: child.owner_agent,
        head_ref: plan.branch,
        workspace_id: existingWorkspace?.workspace_id || undefined,
        workspace: existingWorkspace || undefined,
    };
}
function validateWorkspaceRecord({ run, child, plan, record }) {
    if (!record || typeof record !== 'object')
        throw new Error('workflow_child_workspace_record_unavailable');
    if (record.workspace_id !== plan.workspace_id)
        throw new Error('workflow_child_workspace_id_mismatch');
    if (record.task_id !== child.child_id)
        throw new Error('workflow_child_workspace_task_mismatch');
    if (record.owner_agent !== child.owner_agent)
        throw new Error('workflow_child_workspace_owner_mismatch');
    if (record.repository_id !== run.repository_id)
        throw new Error('workflow_child_workspace_repository_mismatch');
    if (record.mode !== plan.mode)
        throw new Error('workflow_child_workspace_mode_mismatch');
    if ((record.branch || null) !== plan.branch)
        throw new Error('workflow_child_workspace_branch_mismatch');
    if (String(record.requested_sha || '').toLowerCase() !== child.input_sha) {
        throw new Error('workflow_child_workspace_requested_sha_mismatch');
    }
    if (String(record.resolved_sha || '').toLowerCase() !== child.input_sha) {
        throw new Error('workflow_child_workspace_resolved_sha_mismatch');
    }
    if (record.state !== USABLE_WORKSPACE_STATE)
        throw new Error('workflow_child_workspace_not_active');
    return serializeTaskWorkspace(record);
}
function sameWorkspace(left, right) {
    return JSON.stringify(left || null) === JSON.stringify(right || null);
}
async function persistWorkflowChildWorkspace({ workflowRunsDir, workflowId, childId, workspace, now, }) {
    return withWorkspaceLock({
        dir: join(workflowRunsDir, '.locks'),
        name: `workflow-child-bind-${workflowDigest(workflowId, 32)}`,
        execute: async () => {
            const run = await readWorkflowRun({ dir: workflowRunsDir, workflowId });
            const index = run.children.findIndex((child) => child.child_id === childId);
            if (index < 0)
                throw new Error('workflow_child_not_found');
            const current = run.children[index];
            if (current.workspace) {
                if (!sameWorkspace(current.workspace, workspace))
                    throw new Error('workflow_child_workspace_conflict');
                return { created: false, run, child: current };
            }
            if (!BINDABLE_CHILD_STATES.has(current.state)) {
                throw new Error(`workflow_child_workspace_not_bindable:${current.state}`);
            }
            const at = now();
            const child = {
                ...current,
                workspace,
                updated_at: at,
                history: [
                    ...(current.history || []),
                    { event: 'workspace_bound', workspace_id: workspace.workspace_id, at },
                ],
            };
            const children = [...run.children];
            children[index] = child;
            const updated = validateWorkflowRun({
                ...run,
                updated_at: at,
                children,
                history: [
                    ...(run.history || []),
                    { event: 'workflow_child_workspace_bound', child_id: childId, workspace_id: workspace.workspace_id, at },
                ],
            });
            await writeAtomic(workflowPath(workflowRunsDir, workflowId), updated);
            return { created: true, run: updated, child };
        },
    });
}
export async function ensureWorkflowChildWorkspace({ workflowRunsDir, workflowId, childId, cacheRoot, workspaceRoot, recordRoot, lockRoot, remote, maxActiveWorkspaces, minimumFreeBytes, getFreeBytes, ensureWorkspace = ensureTaskWorkspace, now = () => new Date().toISOString(), }) {
    const initialRun = await readWorkflowRun({ dir: workflowRunsDir, workflowId });
    const initialChild = findChild(initialRun, childId);
    const plan = selectWorkflowChildWorkspacePlan({ run: initialRun, child: initialChild });
    if (!initialChild.workspace && !BINDABLE_CHILD_STATES.has(initialChild.state)) {
        throw new Error(`workflow_child_workspace_not_bindable:${initialChild.state}`);
    }
    const request = {
        cacheRoot,
        workspaceRoot,
        recordRoot,
        lockRoot,
        remote,
        maxActiveWorkspaces,
        minimumFreeBytes,
        getFreeBytes,
    };
    let recoveredAfterConflict = false;
    let binding;
    try {
        binding = await ensureWorkspace({
            ...request,
            task: taskForChild(initialRun, initialChild, plan, initialChild.workspace),
        });
    }
    catch (error) {
        if (initialChild.workspace || error?.message !== 'workspace_id_conflict')
            throw error;
        recoveredAfterConflict = true;
        binding = await ensureWorkspace({
            ...request,
            task: taskForChild(initialRun, initialChild, plan, { workspace_id: plan.workspace_id }),
        });
    }
    const workspace = validateWorkspaceRecord({
        run: initialRun,
        child: initialChild,
        plan,
        record: binding.record,
    });
    const persisted = await persistWorkflowChildWorkspace({
        workflowRunsDir,
        workflowId,
        childId,
        workspace,
        now,
    });
    return {
        ...persisted,
        workspace,
        workspace_path: binding.workspace_path,
        workspace_reused: Boolean(binding.reused || recoveredAfterConflict || !persisted.created),
    };
}
//# sourceMappingURL=workflow-child-workspace.js.map