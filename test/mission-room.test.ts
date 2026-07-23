import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMissionRoom } from '../src/services/mission-room.js';

function mission(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'ops-room.mission.v1',
    version: 1,
    mission_id: 'mission:mission-room:1234567890abcdef12345678',
    title: 'Build the Mission Room',
    objective: 'Show bounded deterministic workflow evidence.',
    repository_id: 'LihSheng/ops-room',
    starting_branch: 'main',
    starting_sha: 'a'.repeat(40),
    workflow_type: 'feature-development',
    policy: {
      max_iterations: 3,
      approval_policy: 'berlin-review-required',
    },
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
    created_by: {
      actor_id: 'operator-lihsheng',
      actor_display_name: 'Lih Sheng',
    },
    created_at: '2026-07-23T03:00:00.000Z',
    updated_at: '2026-07-23T03:05:00.000Z',
    completed_at: null,
    last_error: null,
    history: [{ event: 'mission_created', at: '2026-07-23T03:00:00.000Z' }],
    creation_request_hash: 'f'.repeat(64),
    ...overrides,
  };
}

function workflow(children: any[], overrides: Record<string, unknown> = {}) {
  return {
    workflow_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678',
    workflow_type: 'feature-development',
    repository_id: 'LihSheng/ops-room',
    source_sha: 'a'.repeat(40),
    state: 'active',
    current_iteration: 1,
    policy: { max_iterations: 3, max_concurrency: 1 },
    children,
    created_at: '2026-07-23T03:01:00.000Z',
    updated_at: '2026-07-23T03:05:00.000Z',
    history: [],
    ...overrides,
  };
}

function implementation(overrides: Record<string, unknown> = {}) {
  return {
    child_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678:1:implementation',
    stage: 'implementation',
    owner_agent: 'professor',
    iteration: 1,
    attempt: 1,
    state: 'pending',
    depends_on: null,
    input_sha: 'a'.repeat(40),
    output_sha: null,
    created_at: '2026-07-23T03:02:00.000Z',
    updated_at: '2026-07-23T03:02:00.000Z',
    started_at: null,
    completed_at: null,
    last_error: null,
    history: [],
    ...overrides,
  };
}

test('Mission Room renders one deterministic four-stage iteration with future placeholders', () => {
  const room = buildMissionRoom({
    mission: mission(),
    workflow: workflow([implementation()]),
    sources: {
      mission: 'available',
      workflow: 'available',
      workspaces: 'available',
      effects: 'available',
    },
    generatedAt: '2026-07-23T03:10:00.000Z',
  });

  assert.deepEqual(room.timeline.map((stage) => stage.stage), [
    'implementation',
    'test',
    'integration',
    'review',
  ]);
  assert.deepEqual(room.timeline.map((stage) => stage.owner_agent), [
    'professor',
    'tokyo',
    'professor',
    'berlin',
  ]);
  assert.equal(room.timeline[0].state, 'pending');
  assert.equal(room.timeline[1].state, 'not_created');
  assert.equal(room.summary.current_stage_key, '1:implementation');
  assert.equal(room.generated_at, '2026-07-23T03:10:00.000Z');
});

test('Mission Room exposes bounded workspace and provider-effect evidence without sensitive fields', () => {
  const child = implementation({
    state: 'completed',
    output_sha: 'b'.repeat(40),
    started_at: '2026-07-23T03:02:00.000Z',
    completed_at: '2026-07-23T03:12:30.000Z',
    history: [{ event: 'workflow_child_completed', at: '2026-07-23T03:12:30.000Z' }],
    workspace: {
      workspace_id: 'workspace-professor-1',
      task_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678:1:implementation',
      owner_agent: 'professor',
      repository_id: 'LihSheng/ops-room',
      mode: 'branch',
      state: 'released',
      branch: 'agent/professor/mission-room',
      resolved_sha: 'b'.repeat(40),
      absolute_path: '/home/private/workspace',
      relative_path: 'private-relative-path',
      created_at: '2026-07-23T03:01:30.000Z',
      updated_at: '2026-07-23T03:13:00.000Z',
    },
  });
  const room = buildMissionRoom({
    mission: mission(),
    workflow: workflow([child]),
    effects: [{
      effect_id: 'effect:1234567890abcdef1234567890abcdef12345678',
      workflow_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678',
      child_id: child.child_id,
      effect_type: 'provider.professor.implementation',
      state: 'completed',
      attempt: 1,
      claimed_at: '2026-07-23T03:02:00.000Z',
      completed_at: '2026-07-23T03:12:30.000Z',
      output_sha: 'b'.repeat(40),
      result_code: 'ok',
      payload_hash: 'must-not-escape',
      secret: 'must-not-escape',
    }],
    sources: {
      mission: 'available',
      workflow: 'available',
      workspaces: 'available',
      effects: 'available',
    },
  });

  const stage = room.timeline[0];
  assert.equal(stage.duration_seconds, 630);
  assert.equal(stage.verification.status, 'verified');
  assert.equal(stage.workspace.workspace_id, 'workspace-professor-1');
  assert.equal(stage.provider_effect.result_code, 'ok');
  const serialized = JSON.stringify(stage);
  assert.equal(serialized.includes('/home/private/workspace'), false);
  assert.equal(serialized.includes('private-relative-path'), false);
  assert.equal(serialized.includes('must-not-escape'), false);
});

test('Mission Room renders every observed iteration and review decision deterministically', () => {
  const reviewOne = {
    child_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678:1:review',
    stage: 'review',
    owner_agent: 'berlin',
    iteration: 1,
    attempt: 1,
    state: 'completed',
    depends_on: 'workflow:LihSheng-ops-room:1234567890abcdef12345678:1:integration',
    input_sha: 'c'.repeat(40),
    output_sha: 'c'.repeat(40),
    created_at: '2026-07-23T03:20:00.000Z',
    updated_at: '2026-07-23T03:25:00.000Z',
    started_at: '2026-07-23T03:21:00.000Z',
    completed_at: '2026-07-23T03:25:00.000Z',
    review_decision: 'changes_requested',
    review_reason: 'tests_require_adjustment',
    history: [],
  };
  const implementationTwo = implementation({
    child_id: 'workflow:LihSheng-ops-room:1234567890abcdef12345678:2:implementation',
    iteration: 2,
    depends_on: reviewOne.child_id,
    input_sha: 'c'.repeat(40),
  });
  const room = buildMissionRoom({
    mission: mission(),
    workflow: workflow([reviewOne, implementationTwo], { current_iteration: 2 }),
    sources: {
      mission: 'available',
      workflow: 'available',
      workspaces: 'available',
      effects: 'available',
    },
  });

  assert.equal(room.timeline.length, 8);
  assert.equal(room.timeline.find((stage) => stage.key === '1:review')?.review_decision, 'changes_requested');
  assert.equal(room.timeline.find((stage) => stage.key === '2:implementation')?.state, 'pending');
  assert.equal(room.summary.current_stage_key, '2:implementation');
});
