import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMissionRoom } from '../src/services/mission-room.js';

const missionId = 'mission:activity:1234567890abcdef12345678';
const workflowId = 'workflow:LihSheng-ops-room:activity1234567890abcd';
const childId = `${workflowId}:1:review`;

function mission() {
  return {
    schema: 'ops-room.mission.v1',
    version: 1,
    mission_id: missionId,
    title: 'Correlate Mission activity',
    objective: 'Present bounded cross-source evidence.',
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
    workflow_id: workflowId,
    github_issue: 81,
    reference_documents: [],
    required_capabilities: [],
    priority: 'high',
    deadline: null,
    supporting_context: null,
    created_by: { actor_id: 'operator', actor_display_name: 'Operator' },
    created_at: '2026-07-23T06:00:00.000Z',
    updated_at: '2026-07-23T06:20:00.000Z',
    completed_at: null,
    last_error: null,
    history: [
      { event: 'mission_created', actor_id: 'operator', at: '2026-07-23T06:00:00.000Z' },
      { event: 'mission_started', actor_id: 'operator', at: '2026-07-23T06:01:00.000Z' },
    ],
    creation_request_hash: 'f'.repeat(64),
  };
}

function reviewChild() {
  return {
    child_id: childId,
    stage: 'review',
    owner_agent: 'berlin',
    iteration: 1,
    attempt: 2,
    state: 'completed',
    depends_on: `${workflowId}:1:integration`,
    input_sha: 'b'.repeat(40),
    output_sha: 'c'.repeat(40),
    created_at: '2026-07-23T06:10:00.000Z',
    updated_at: '2026-07-23T06:20:00.000Z',
    started_at: '2026-07-23T06:15:00.000Z',
    completed_at: '2026-07-23T06:20:00.000Z',
    last_error: null,
    review_decision: 'changes_requested',
    review_reason: 'tests_require_adjustment',
    history: [
      { from: null, to: 'pending', at: '2026-07-23T06:10:00.000Z', reason: 'child_created' },
      { from: 'pending', to: 'active', at: '2026-07-23T06:15:00.000Z', reason: 'child_activated' },
      { from: 'active', to: 'failed', at: '2026-07-23T06:17:00.000Z', reason: 'review_provider_failed' },
      { from: 'failed', to: 'pending', at: '2026-07-23T06:18:00.000Z', reason: 'child_retry_requested' },
      { from: 'pending', to: 'active', at: '2026-07-23T06:19:00.000Z', reason: 'child_activated' },
      { from: 'active', to: 'completed', at: '2026-07-23T06:20:00.000Z', reason: 'child_completed' },
    ],
  };
}

function workflow(child: any) {
  return {
    workflow_id: workflowId,
    workflow_type: 'feature-development',
    repository_id: 'LihSheng/ops-room',
    source_sha: 'a'.repeat(40),
    state: 'active',
    current_iteration: 1,
    policy: { max_iterations: 3, max_concurrency: 1 },
    children: [child],
    created_at: '2026-07-23T06:01:00.000Z',
    updated_at: '2026-07-23T06:20:00.000Z',
    history: [
      { event: 'workflow_created', at: '2026-07-23T06:01:00.000Z' },
      { event: 'workflow_child_created', child_id: childId, at: '2026-07-23T06:10:00.000Z' },
      { event: 'workflow_child_activated', child_id: childId, at: '2026-07-23T06:15:00.000Z' },
      { event: 'workflow_child_failed', child_id: childId, at: '2026-07-23T06:17:00.000Z' },
      { event: 'workflow_child_retried', child_id: childId, attempt: 2, at: '2026-07-23T06:18:00.000Z' },
      { event: 'workflow_child_completed', child_id: childId, at: '2026-07-23T06:20:00.000Z' },
    ],
  };
}

test('Mission activity correlates, deduplicates, orders, and cross-links durable evidence', () => {
  const child = reviewChild();
  const room = buildMissionRoom({
    mission: mission(),
    workflow: workflow(child),
    workspaces: [{
      version: 1,
      workspace_id: 'workspace-berlin-activity',
      task_id: childId,
      owner_agent: 'berlin',
      repository_id: 'LihSheng/ops-room',
      mode: 'detached',
      state: 'held_for_investigation',
      relative_path: 'workspaces/berlin/activity',
      requested_sha: 'b'.repeat(40),
      resolved_sha: 'c'.repeat(40),
      branch: null,
      created_at: '2026-07-23T06:14:00.000Z',
      updated_at: '2026-07-23T06:21:00.000Z',
      absolute_path: '/private/workspace',
      token: 'must-not-escape',
    }],
    effects: [{
      schema: 'ops-room.workflow-effect.v1',
      effect_id: 'effect:1234567890abcdef1234567890abcdef12345678',
      workflow_id: workflowId,
      child_id: childId,
      effect_type: 'provider.berlin.review',
      idempotency_key: 'review-effect-activity',
      payload_hash: 'd'.repeat(64),
      state: 'needs_human',
      claimed_at: '2026-07-23T06:16:00.000Z',
      updated_at: '2026-07-23T06:22:00.000Z',
      completed_at: '2026-07-23T06:22:00.000Z',
      output_sha: null,
      result_code: 'review_provider_interrupted',
      attempt: 1,
      provider_output: 'must-not-escape',
    }],
    sources: { mission: 'available', workflow: 'available', workspaces: 'available', effects: 'available' },
  });

  assert.equal(room.activity[0].event_type, 'effect.needs.human');
  assert.equal(room.activity[0].severity, 'attention');
  assert.equal(room.activity[0].links.stage, `/missions/${encodeURIComponent(missionId)}#stage-1-review`);
  assert.equal(room.activity[0].links.agent, '/agents/berlin');
  assert.equal(room.activity.filter((event) => event.event_type === 'stage.completed').length, 1);
  assert.equal(room.activity.filter((event) => event.event_type === 'stage.retried').length, 1);
  assert.equal(room.activity.some((event) => event.event_type === 'review.changes.requested'), true);
  assert.equal(room.activity.some((event) => event.event_type === 'workspace.investigation_hold'), true);
  assert.equal(room.activity_summary.attention >= 3, true);
  assert.equal(room.activity_summary.retries, 1);
  assert.equal(room.activity_summary.effects, 2);

  const serialized = JSON.stringify(room.activity);
  assert.equal(serialized.includes('/private/workspace'), false);
  assert.equal(serialized.includes('must-not-escape'), false);
  assert.equal(serialized.includes('payload_hash'), false);
});

test('Mission activity preserves Mission evidence without inventing unavailable Workflow events', () => {
  const room = buildMissionRoom({
    mission: { ...mission(), workflow_id: null, state: 'planned' },
    workflow: null,
    effects: [],
    workspaces: [],
    sources: { mission: 'available', workflow: 'not_applicable', workspaces: 'not_applicable', effects: 'not_applicable' },
  });

  assert.deepEqual(room.activity.map((event) => event.event_type), ['mission.started', 'mission.created']);
  assert.equal(room.activity.some((event) => event.source === 'workflow'), false);
  assert.equal(room.activity.some((event) => event.source === 'workspace'), false);
  assert.equal(room.activity.some((event) => event.source === 'provider_effect'), false);
});
