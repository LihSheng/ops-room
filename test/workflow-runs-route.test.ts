import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleWorkflowRunDetail,
  handleWorkflowRunsList,
} from '../src/routes/workflow-runs.js';

const SHA = 'a'.repeat(40);

function run(overrides = {}) {
  return {
    schema: 'ops-room.workflow-run.v1',
    version: 1,
    workflow_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678',
    workflow_type: 'feature-development',
    repository_id: 'LihSheng/ops-room',
    request_key: 'OPS-010B',
    source_sha: SHA,
    state: 'active',
    policy: { max_iterations: 3, max_concurrency: 1 },
    current_iteration: 1,
    children: [],
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
    history: [{ event: 'workflow_created', at: '2026-07-20T00:00:00.000Z' }],
    ...overrides,
  };
}

test('workflow list applies bounded repository and state filters', async () => {
  const records = [
    run(),
    run({
      workflow_id: 'workflow:LihSheng-LinkUp:abcdefabcdefabcdefabcdef',
      repository_id: 'LihSheng/LinkUp',
      request_key: 'other',
      state: 'completed',
    }),
  ];
  const params = new URLSearchParams({
    repository: 'LihSheng/ops-room',
    state: 'active',
    limit: '1000',
  });
  const result = await handleWorkflowRunsList(params, {
    workflowRunsDir: '/not-exposed',
    listRuns: async () => records,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.workflows.length, 1);
  assert.equal(result.body.workflows[0].repository_id, 'LihSheng/ops-room');
  assert.equal(result.body.total_matching, 1);
});

test('workflow list rejects unsupported state filters', async () => {
  const result = await handleWorkflowRunsList(new URLSearchParams({ state: 'running' }), {
    workflowRunsDir: '/unused',
    listRuns: async () => [],
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_workflow_state_filter');
});

test('workflow detail serialization excludes unknown sensitive fields', async () => {
  const record = run({
    absolute_path: '/secret/workflows/run',
    remote: 'https://token@example.invalid/repo.git',
    credentials: { token: 'secret' },
    environment: { PRIVATE_VALUE: 'secret' },
  });
  const result = await handleWorkflowRunDetail(record.workflow_id, {
    workflowRunsDir: '/not-exposed',
    readRun: async () => record,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.workflow.workflow_id, record.workflow_id);
  assert.equal(Object.hasOwn(result.body.workflow, 'absolute_path'), false);
  assert.equal(Object.hasOwn(result.body.workflow, 'remote'), false);
  assert.equal(Object.hasOwn(result.body.workflow, 'credentials'), false);
  assert.equal(Object.hasOwn(result.body.workflow, 'environment'), false);
});

test('corrupt records are represented by bounded unavailable summaries', async () => {
  const result = await handleWorkflowRunsList(new URLSearchParams(), {
    workflowRunsDir: '/unused',
    listRuns: async () => [{
      workflow_id: 'workflow-deadbeef',
      state: 'needs_human',
      last_error: 'workflow_record_unavailable',
    }],
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.unavailable_count, 1);
  assert.deepEqual(result.body.workflows[0], {
    workflow_id: 'workflow-deadbeef',
    workflow_type: 'feature-development',
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
  });
});

test('workflow detail distinguishes missing and unavailable records', async () => {
  const missing = await handleWorkflowRunDetail('workflow:missing:123', {
    workflowRunsDir: '/unused',
    readRun: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(missing.status, 404);

  const unavailable = await handleWorkflowRunDetail('workflow:broken:123', {
    workflowRunsDir: '/unused',
    readRun: async () => { throw new SyntaxError('private raw parse detail'); },
  });
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.body.workflow.unavailable, true);
  assert.equal(unavailable.body.workflow.last_error, 'workflow_record_unavailable');
});
