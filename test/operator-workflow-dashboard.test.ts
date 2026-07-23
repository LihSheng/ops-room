import assert from 'node:assert/strict';
import test from 'node:test';

import type { MissionRoom, MissionRoomStage } from '../dashboard/src/api/missions.js';
import {
  createWorkflowActionIdempotencyKey,
  deriveWorkflowStageActions,
  operatorWorkflowsApi,
  rolesAllowWorkflowAction,
} from '../dashboard/src/api/operator-workflows.js';

function stage(overrides: Partial<MissionRoomStage> = {}): MissionRoomStage {
  return {
    key: '1:implementation',
    child_id: 'workflow:repo:child:1:implementation',
    iteration: 1,
    stage: 'implementation',
    owner_agent: 'professor',
    state: 'needs_human',
    attempt: 0,
    retry_count: 0,
    depends_on: null,
    input_sha: 'a'.repeat(40),
    output_sha: null,
    created_at: null,
    started_at: null,
    completed_at: null,
    duration_seconds: null,
    last_error: 'provider_failed',
    review_decision: null,
    review_reason: null,
    workspace: {
      workspace_id: 'workspace:1',
      mode: 'branch',
      state: 'active',
      repository_id: 'LihSheng/ops-room',
      branch: 'agent/professor/test',
      resolved_sha: 'a'.repeat(40),
      held_for_investigation: false,
      cleanup_requested: false,
      created_at: null,
      updated_at: null,
      unavailable: false,
      last_error: null,
    },
    provider_effect: {
      effect_id: 'effect:1',
      effect_type: 'provider.professor.implementation',
      state: 'failed',
      attempt: 0,
      claimed_at: null,
      completed_at: null,
      output_sha: null,
      result_code: 'provider_failed',
      unavailable: false,
      last_error: null,
    },
    provider_effect_count: 1,
    verification: { status: 'attention', reason: 'provider_failed' },
    retry_history: [],
    evidence: { workspace: 'available', provider_effect: 'available' },
    ...overrides,
  };
}

function room(stageRecord: MissionRoomStage, workflowOverrides: Record<string, unknown> = {}): MissionRoom {
  return {
    mission: {
      mission_id: 'mission:1',
      title: 'Test mission',
      objective: 'Test browser workflow controls',
      repository_id: 'LihSheng/ops-room',
      starting_branch: 'main',
      starting_sha: 'a'.repeat(40),
      workflow_type: 'feature-development',
      policy: { max_iterations: 3, approval_policy: 'berlin-review-required' },
      state: 'needs_human',
      participants: [],
      stage_owners: null,
      workflow_id: 'workflow:repo:1',
      github_issue: 87,
      reference_documents: [],
      required_capabilities: [],
      priority: 'normal',
      deadline: null,
      supporting_context: null,
      created_by: null,
      created_at: null,
      updated_at: null,
      completed_at: null,
    },
    workflow: {
      workflow_id: 'workflow:repo:1',
      workflow_type: 'feature-development',
      repository_id: 'LihSheng/ops-room',
      source_sha: 'a'.repeat(40),
      state: 'needs_human',
      current_iteration: 1,
      policy: { max_iterations: 3, max_concurrency: 1 },
      created_at: null,
      updated_at: null,
      completed_at: null,
      last_error: 'provider_failed',
      ...workflowOverrides,
    },
    timeline: [stageRecord],
    activity: [],
    activity_summary: { total: 0, attention: 0, reviews: 0, retries: 0, effects: 0, latest_at: null },
    summary: {
      iterations: 1,
      created_stages: 1,
      completed_stages: 0,
      attention_stages: 1,
      degraded_stages: 0,
      current_stage_key: stageRecord.key,
      attention_required: true,
    },
    sources: { mission: 'available', workflow: 'available', workspaces: 'available', effects: 'available' },
    generated_at: new Date().toISOString(),
  };
}

test('derives retry only from terminal retryable effect and inspectable workspace evidence', () => {
  const safe = deriveWorkflowStageActions(room(stage()), stage());
  assert.deepEqual(safe.map((entry) => entry.action), ['retry']);

  const claimed = stage({ provider_effect: { ...stage().provider_effect!, state: 'claimed' } });
  assert.deepEqual(deriveWorkflowStageActions(room(claimed), claimed), []);

  const released = stage({ workspace: { ...stage().workspace!, state: 'released' } });
  assert.deepEqual(deriveWorkflowStageActions(room(released), released), []);
});

test('derives resume only for pending stage without current-attempt provider effect', () => {
  const pending = stage({ state: 'pending', provider_effect: null, provider_effect_count: 0, last_error: null });
  assert.deepEqual(deriveWorkflowStageActions(room(pending), pending).map((entry) => entry.action), ['resume']);

  const withEffect = stage({ state: 'pending' });
  assert.deepEqual(deriveWorkflowStageActions(room(withEffect), withEffect), []);
});

test('derives Berlin decisions for completed unresolved review evidence', () => {
  const review = stage({
    key: '1:review',
    child_id: 'workflow:repo:child:1:review',
    stage: 'review',
    owner_agent: 'berlin',
    state: 'completed',
    output_sha: 'a'.repeat(40),
    completed_at: new Date().toISOString(),
    provider_effect: { ...stage().provider_effect!, state: 'completed', effect_type: 'provider.berlin.review' },
    last_error: null,
  });
  const result = deriveWorkflowStageActions(
    room(review, { last_error: 'workflow_review_decision_missing' }),
    review,
  );
  assert.deepEqual(result.map((entry) => entry.action), ['approve', 'changes_requested']);

  const decided = { ...review, review_decision: 'approved' };
  assert.deepEqual(deriveWorkflowStageActions(room(decided), decided), []);
});

test('maps operator and reviewer roles to separate workflow permissions', () => {
  assert.equal(rolesAllowWorkflowAction(['operator'], 'retry'), true);
  assert.equal(rolesAllowWorkflowAction(['operator'], 'approve'), false);
  assert.equal(rolesAllowWorkflowAction(['reviewer'], 'approve'), true);
  assert.equal(rolesAllowWorkflowAction(['reviewer'], 'resume'), false);
  assert.equal(rolesAllowWorkflowAction(['administrator'], 'changes_requested'), true);
});

test('creates browser-stable workflow request keys', () => {
  const first = createWorkflowActionIdempotencyKey();
  const second = createWorkflowActionIdempotencyKey();
  assert.match(first, /^browser-workflow:/);
  assert.notEqual(first, second);
});

test('binds approval confirmation to the exact encoded route', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      operation: 'workflow.approve',
      workflow: { workflow_id: 'workflow:repo:1', state: 'completed', current_iteration: 1, last_error: null },
      child: null,
      next_child: null,
      provider_invoked: false,
      domain_idempotent: false,
      audit_event_id: 'audit-1',
      idempotent_replay: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await operatorWorkflowsApi.act({
      workflowId: 'workflow:repo:1',
      childId: 'workflow:repo:child:1:review',
      expectedAttempt: 0,
      action: 'approve',
      reason: 'Approve verified Berlin result',
      idempotencyKey: 'browser-workflow:test-key',
      csrfToken: 'csrf-token',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const expectedPath = '/api/operator/workflows/workflow%3Arepo%3A1/children/workflow%3Arepo%3Achild%3A1%3Areview/decision';
  assert.equal(capturedUrl, expectedPath);
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('X-Ops-Room-CSRF'), 'csrf-token');
  assert.equal(
    headers.get('X-Ops-Room-Confirmation'),
    `confirm:workflow.approve:POST:${expectedPath}`,
  );
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    reason: 'Approve verified Berlin result',
    expected_attempt: 0,
    idempotency_key: 'browser-workflow:test-key',
    decision: 'approve',
  });
});
