import {
  FEATURE_DEVELOPMENT_WORKFLOW,
  listWorkflowRuns,
  readWorkflowRun,
  serializeWorkflowRun,
} from '../services/workflow-run-store.js';

const WORKFLOW_STATES = new Set([
  'planned',
  'active',
  'blocked',
  'completed',
  'needs_human',
  'cancelled',
]);
const SAFE_PUBLIC_ID = /^[A-Za-z0-9._:-]{1,180}$/;

function boundedLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
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

function serializeForRead(record) {
  try {
    return serializeWorkflowRun(record);
  } catch {
    return boundedUnavailableSummary(record);
  }
}

function normalizeRepositoryFilter(value) {
  const repository = String(value || '').trim();
  if (!repository) return null;
  if (repository.length > 220 || repository.includes('..')) {
    throw new Error('invalid_workflow_repository_filter');
  }
  return repository;
}

function normalizeStateFilter(value) {
  const state = String(value || '').trim();
  if (!state) return null;
  if (!WORKFLOW_STATES.has(state)) throw new Error('invalid_workflow_state_filter');
  return state;
}

export async function handleWorkflowRunsList(searchParams, {
  workflowRunsDir,
  listRuns = listWorkflowRuns,
} = {}) {
  const limit = boundedLimit(searchParams?.get?.('limit'));
  let repository;
  let state;
  try {
    repository = normalizeRepositoryFilter(searchParams?.get?.('repository'));
    state = normalizeStateFilter(searchParams?.get?.('state'));
  } catch (error) {
    return { status: 400, body: { error: error?.message || 'invalid_workflow_filter' } };
  }

  const records = await listRuns({ dir: workflowRunsDir, limit: 500 });
  const serialized = records.map(serializeForRead);
  const filtered = serialized.filter((run) => {
    if (repository && run.repository_id !== repository) return false;
    if (state && run.state !== state) return false;
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

export async function handleWorkflowRunDetail(workflowId, {
  workflowRunsDir,
  readRun = readWorkflowRun,
} = {}) {
  const normalizedId = String(workflowId || '');
  if (!SAFE_PUBLIC_ID.test(normalizedId)) {
    return { status: 400, body: { error: 'invalid_workflow_id' } };
  }

  try {
    const record = await readRun({ dir: workflowRunsDir, workflowId: normalizedId });
    return { status: 200, body: { workflow: serializeForRead(record) } };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 404, body: { error: 'Workflow not found' } };
    }
    return {
      status: 200,
      body: { workflow: boundedUnavailableSummary(null, normalizedId) },
    };
  }
}
