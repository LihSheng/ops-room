import assert from 'node:assert/strict';
import test from 'node:test';

import { handleMissionRoomDetail } from '../src/routes/mission-room.js';

function mission(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'ops-room.mission.v1',
    version: 1,
    mission_id: 'mission:room-route:1234567890abcdef12345678',
    title: 'Mission Room route',
    objective: 'Read bounded room evidence.',
    repository_id: 'LihSheng/ops-room',
    starting_branch: 'main',
    starting_sha: 'a'.repeat(40),
    workflow_type: 'feature-development',
    policy: { max_iterations: 3, approval_policy: 'berlin-review-required' },
    state: 'active',
    participants: [
      { agent_id: 'professor', roles: ['implementation', 'integration'] },
      { agent_id: 'tokyo', roles: ['test'] },
      { agent_id: 'berlin', roles: ['review'] },
    ],
    stage_owners: {
      implementation: 'professor',
      test: 'tokyo',
      integration: 'professor',
      review: 'berlin',
    },
    workflow_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678',
    github_issue: 77,
    reference_documents: [],
    required_capabilities: [],
    priority: 'high',
    deadline: null,
    supporting_context: null,
    created_by: { actor_id: 'operator', actor_display_name: 'Operator' },
    created_at: '2026-07-23T03:00:00.000Z',
    updated_at: '2026-07-23T03:01:00.000Z',
    completed_at: null,
    last_error: null,
    history: [],
    creation_request_hash: 'f'.repeat(64),
    ...overrides,
  };
}

function workflow() {
  return {
    workflow_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678',
    workflow_type: 'feature-development',
    repository_id: 'LihSheng/ops-room',
    source_sha: 'a'.repeat(40),
    state: 'active',
    policy: { max_iterations: 3, max_concurrency: 1 },
    current_iteration: 1,
    children: [],
    created_at: '2026-07-23T03:00:30.000Z',
    updated_at: '2026-07-23T03:01:00.000Z',
    history: [],
  };
}

test('Mission Room route joins independently loaded durable authorities', async () => {
  const result = await handleMissionRoomDetail('mission:room-route:1234567890abcdef12345678', {
    missionsDir: '/unused/missions',
    workflowRunsDir: '/unused/workflows',
    workflowEffectsDir: '/unused/effects',
    workspaceRecordsDir: '/unused/workspaces',
    readMissionRecord: async () => mission(),
    readWorkflowRecord: async () => workflow(),
    listEffects: async () => [],
    listWorkspaces: async () => [],
    now: () => '2026-07-23T03:10:00.000Z',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.room.mission.title, 'Mission Room route');
  assert.equal(result.body.room.timeline.length, 4);
  assert.equal(result.body.room.sources.workflow, 'available');
  assert.equal(result.body.room.generated_at, '2026-07-23T03:10:00.000Z');
});

test('Mission Room route keeps Mission evidence when Workflow evidence is unavailable', async () => {
  const result = await handleMissionRoomDetail('mission:room-route:1234567890abcdef12345678', {
    missionsDir: '/unused/missions',
    workflowRunsDir: '/unused/workflows',
    workflowEffectsDir: '/unused/effects',
    workspaceRecordsDir: '/unused/workspaces',
    readMissionRecord: async () => mission(),
    readWorkflowRecord: async () => { throw Object.assign(new Error('private workflow path'), { code: 'ENOENT' }); },
    listEffects: async () => { throw new Error('private effect path'); },
    listWorkspaces: async () => { throw new Error('private workspace path'); },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.room.mission.title, 'Mission Room route');
  assert.equal(result.body.room.workflow, null);
  assert.equal(result.body.room.sources.workflow, 'unavailable');
  assert.equal(result.body.room.sources.effects, 'unavailable');
  assert.equal(result.body.room.sources.workspaces, 'unavailable');
  assert.equal(result.body.room.summary.attention_required, true);
  assert.equal(JSON.stringify(result).includes('private workflow path'), false);
  assert.equal(JSON.stringify(result).includes('private effect path'), false);
});

test('Mission Room route rejects invalid IDs and preserves not-found semantics', async () => {
  const invalid = await handleMissionRoomDetail('../mission', {
    readMissionRecord: async () => mission(),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'invalid_mission_id');

  const missing = await handleMissionRoomDetail('mission:missing:1234567890abcdef12345678', {
    readMissionRecord: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Mission not found');
});
