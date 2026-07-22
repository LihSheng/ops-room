import { FEATURE_DEVELOPMENT_WORKFLOW, listWorkflowRuns, readWorkflowRun, serializeWorkflowRun, } from '../services/workflow-run-store.js';
const WORKFLOW_STATES = new Set([
    'planned',
    'active',
    'blocked',
    'completed',
    'needs_human',
    'cancelled',
]);
const WORKSPACE_STATES = new Set([
    'allocating',
    'active',
    'cleanup_requested',
    'cleaning',
    'released',
    'failed',
    'held_for_investigation',
]);
const SAFE_PUBLIC_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const SAFE_REPOSITORY_ID = /^(?:[A-Za-z0-9._-]{1,120}|[A-Za-z0-9._-]{1,100}\/([A-Za-z0-9._-]{1,100}))$/;
const SAFE_BRANCH = /^(?!\/|.*(?:\.\.|\/\.|\.\/|\/\/|@\{|\\))[A-Za-z0-9._\/-]{1,240}(?<![./])$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
function boundedLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 50;
    return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}
function boundedUnavailableSummary(record, workflowId = null) {
    const candidate = String(workflowId || record?.workflow_id || 'workflow-unavailable');
    return {
        workflow_id: SAFE_PUBLIC_ID.test(candidate) ? candidate : 'workflow-unavailable',
        workflow_type: FEATURE_DEVELOPMENT_WORKFLOW,
        repository_id: null,
        request_key: null,
        source_sha: null,
        state: 'needs_human',
        policy: null,
        current_iteration: null,
        child_count: null,
        children: [],
        created_at: null,
        updated_at: null,
        unavailable: true,
        last_error: 'workflow_record_unavailable',
    };
}
function boundedWorkspaceShape(workspace) {
    if (!workspace)
        return null;
    try {
        const workspaceId = String(workspace.workspace_id || '');
        const repositoryId = String(workspace.repository_id || '');
        const mode = String(workspace.mode || '');
        const branch = workspace.branch === null ? null : String(workspace.branch || '');
        const resolvedSha = String(workspace.resolved_sha || '').toLowerCase();
        const state = String(workspace.state || '');
        if (!SAFE_PUBLIC_ID.test(workspaceId))
            throw new Error('invalid_workspace_id');
        if (!SAFE_REPOSITORY_ID.test(repositoryId) || repositoryId.includes('..')) {
            throw new Error('invalid_repository_id');
        }
        if (!['branch', 'detached'].includes(mode))
            throw new Error('invalid_workspace_mode');
        if (mode === 'branch' && !SAFE_BRANCH.test(branch || ''))
            throw new Error('invalid_workspace_branch');
        if (mode === 'detached' && branch !== null)
            throw new Error('invalid_workspace_branch');
        if (!SAFE_SHA.test(resolvedSha))
            throw new Error('invalid_workspace_sha');
        if (!WORKSPACE_STATES.has(state))
            throw new Error('invalid_workspace_state');
        return {
            workspace_id: workspaceId,
            mode,
            repository_id: repositoryId,
            branch,
            resolved_sha: resolvedSha,
            state,
            held_for_investigation: state === 'held_for_investigation',
            cleanup_requested: state === 'cleanup_requested',
        };
    }
    catch {
        return {
            unavailable: true,
            last_error: 'workflow_workspace_unavailable',
        };
    }
}
function serializeForRead(record) {
    try {
        const serialized = serializeWorkflowRun(record);
        const rawChildren = new Map((record.children || []).map((child) => [child.child_id, child]));
        return {
            ...serialized,
            children: serialized.children.map((child) => ({
                ...child,
                workspace: boundedWorkspaceShape(rawChildren.get(child.child_id)?.workspace),
            })),
        };
    }
    catch {
        return boundedUnavailableSummary(record);
    }
}
function normalizeRepositoryFilter(value) {
    const repository = String(value || '').trim();
    if (!repository)
        return null;
    if (repository.length > 220 || repository.includes('..')) {
        throw new Error('invalid_workflow_repository_filter');
    }
    return repository;
}
function normalizeStateFilter(value) {
    const state = String(value || '').trim();
    if (!state)
        return null;
    if (!WORKFLOW_STATES.has(state))
        throw new Error('invalid_workflow_state_filter');
    return state;
}
export async function handleWorkflowRunsList(searchParams, { workflowRunsDir, listRuns = listWorkflowRuns, } = {}) {
    const limit = boundedLimit(searchParams?.get?.('limit'));
    let repository;
    let state;
    try {
        repository = normalizeRepositoryFilter(searchParams?.get?.('repository'));
        state = normalizeStateFilter(searchParams?.get?.('state'));
    }
    catch (error) {
        return { status: 400, body: { error: error?.message || 'invalid_workflow_filter' } };
    }
    const records = await listRuns({ dir: workflowRunsDir, limit: 500 });
    const serialized = records.map(serializeForRead);
    const filtered = serialized.filter((run) => {
        if (repository && run.repository_id !== repository)
            return false;
        if (state && run.state !== state)
            return false;
        return true;
    });
    const workflows = filtered.slice(0, limit);
    return {
        status: 200,
        body: {
            workflows,
            count: workflows.length,
            total_matching: filtered.length,
            unavailable_count: workflows.filter((run) => run.unavailable).length,
        },
    };
}
export async function handleWorkflowRunDetail(workflowId, { workflowRunsDir, readRun = readWorkflowRun, } = {}) {
    const normalizedId = String(workflowId || '');
    if (!SAFE_PUBLIC_ID.test(normalizedId)) {
        return { status: 400, body: { error: 'invalid_workflow_id' } };
    }
    try {
        const record = await readRun({ dir: workflowRunsDir, workflowId: normalizedId });
        return { status: 200, body: { workflow: serializeForRead(record) } };
    }
    catch (error) {
        if (error?.code === 'ENOENT') {
            return { status: 404, body: { error: 'Workflow not found' } };
        }
        return {
            status: 200,
            body: { workflow: boundedUnavailableSummary(null, normalizedId) },
        };
    }
}
//# sourceMappingURL=workflow-runs.js.map