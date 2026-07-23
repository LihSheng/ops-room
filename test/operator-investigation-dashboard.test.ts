import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { MissionRoom, MissionRoomStage } from '../dashboard/src/api/missions.js';
import {
  createInvestigationIdempotencyKey,
  deriveInvestigationActions,
  operatorInvestigationsApi,
  rolesAllowInvestigationAction,
} from '../dashboard/src/api/operator-investigations.js';

function stage(overrides: Partial<MissionRoomStage> = {}): MissionRoomStage {
  return {
    key: '1:implementation',
    child_id: 'workflow:repo:1:1:implementation',
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
    last_error: 'workflow_provider_timeout',
    review_decision: null,
    review_reason: null,
    workspace: {
      workspace_id: 'workspace-f3',
      mode: 'branch',
      state: 'held_for_investigation',
      repository_id: 'LihSheng/ops-room',
      branch: 'agent/professor/f3',
      resolved_sha: 'a'.repeat(40),
      held_for_investigation: true,
      cleanup_requested: false,
      created_at: null,
      updated_at: null,
      unavailable: false,
      last_error: null,
    },
    provider_effect: {
      effect_id: 'effect:f3',
      effect_type: 'provider.professor.implementation',
      state: 'needs_human',
      attempt: 0,
      claimed_at: null,
      completed_at: null,
      output_sha: null,
      result_code: 'workflow_provider_timeout',
      unavailable: false,
      last_error: null,
    },
    provider_effect_count: 1,
    verification: { status: 'attention', reason: 'workflow_provider_timeout' },
    retry_history: [],
    evidence: { workspace: 'available', provider_effect: 'available' },
    ...overrides,
  };
}

function room(stageRecord: MissionRoomStage): MissionRoom {
  return {
    mission: {
      mission_id: 'mission:f3',
      title: 'F3 mission',
      objective: 'Effect and workspace investigation',
      repository_id: 'LihSheng/ops-room',
      starting_branch: 'main',
      starting_sha: 'a'.repeat(40),
      workflow_type: 'feature-development',
      policy: { max_iterations: 3, approval_policy: 'berlin-review-required' },
      state: 'needs_human',
      participants: [],
      stage_owners: null,
      workflow_id: 'workflow:repo:1',
      github_issue: 91,
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
      last_error: 'workflow_child_interrupted',
    },
    timeline: [stageRecord],
    activity: [],
    activity_summary: { total: 0, attention: 1, reviews: 0, retries: 0, effects: 1, latest_at: null },
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

test('derives effect resolution before retry and verified workspace release', () => {
  const value = stage();
  const actions = deriveInvestigationActions(room(value), value).map((entry) => entry.action);
  assert.deepEqual(actions, ['effect_safe_to_retry', 'effect_completed', 'workspace_release']);

  const resolved = stage({ provider_effect: { ...value.provider_effect!, state: 'failed' } });
  assert.deepEqual(
    deriveInvestigationActions(room(resolved), resolved).map((entry) => entry.action),
    ['workspace_release'],
  );
});

test('derives cleanup request only for terminal targets without unresolved effect', () => {
  const completed = stage({
    state: 'completed',
    output_sha: 'a'.repeat(40),
    workspace: { ...stage().workspace!, state: 'active', held_for_investigation: false },
    provider_effect: { ...stage().provider_effect!, state: 'completed', output_sha: 'a'.repeat(40), result_code: 'ok' },
  });
  const actions = deriveInvestigationActions(room(completed), completed).map((entry) => entry.action);
  assert.deepEqual(actions, ['workspace_hold', 'workspace_cleanup']);
});

test('investigation actions require operator or administrator role', () => {
  assert.equal(rolesAllowInvestigationAction(['operator']), true);
  assert.equal(rolesAllowInvestigationAction(['administrator']), true);
  assert.equal(rolesAllowInvestigationAction(['reviewer']), false);
  assert.equal(rolesAllowInvestigationAction(['viewer']), false);
});

test('retains browser investigation request identity', () => {
  const first = createInvestigationIdempotencyKey();
  const second = createInvestigationIdempotencyKey();
  assert.match(first, /^browser-investigation:/);
  assert.notEqual(first, second);
});

test('typed client binds exact encoded effect route and safe-to-retry body', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      operation: 'workflow.effect.resolve',
      resolution: 'safe_to_retry',
      effect: { effect_id: 'effect:f3', workflow_id: 'workflow:repo:1', child_id: 'workflow:repo:1:1:implementation', state: 'failed', result_code: 'operator.safe_to_retry', output_sha: null, updated_at: new Date().toISOString() },
      workspace: { workspace_id: 'workspace-f3', state: 'held_for_investigation', resolved_sha: 'a'.repeat(40) },
      provider_invoked: false,
      uncertain_effect_replayed: false,
      audit_event_id: 'audit-f3',
      idempotent_replay: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await operatorInvestigationsApi.act({
      workflowId: 'workflow:repo:1',
      childId: 'workflow:repo:1:1:implementation',
      effectId: 'effect:f3',
      expectedAttempt: 0,
      action: 'effect_safe_to_retry',
      reason: 'Verified restored workspace',
      idempotencyKey: 'browser-investigation:test-f3',
      csrfToken: 'csrf-f3',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const expected = '/api/operator/workflows/workflow%3Arepo%3A1/children/workflow%3Arepo%3A1%3A1%3Aimplementation/effects/effect%3Af3/resolve';
  assert.equal(capturedUrl, expected);
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('X-Ops-Room-CSRF'), 'csrf-f3');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    reason: 'Verified restored workspace',
    expected_attempt: 0,
    idempotency_key: 'browser-investigation:test-f3',
    resolution: 'safe_to_retry',
  });
});

test('Mission Room and Needs Human host the final investigation controls', async () => {
  const missionSource = await readFile(new URL('../dashboard/src/components/MissionRoomContent.tsx', import.meta.url), 'utf8');
  const deskSource = await readFile(new URL('../dashboard/src/components/WorkflowControlDesk.tsx', import.meta.url), 'utf8');
  const panelSource = await readFile(new URL('../dashboard/src/components/InvestigationControlPanel.tsx', import.meta.url), 'utf8');
  assert.match(missionSource, /<InvestigationControlPanel room=\{room\} \/>/);
  assert.match(deskSource, /<InvestigationControlPanel room=\{roomQuery\.data\.room\} compact \/>/);
  assert.match(panelSource, /Uncertain effects are never replayed/);
  assert.match(panelSource, /physical deletion remains a separate server-owned operation/);
  assert.doesNotMatch(panelSource, /absolute_path|relative_path|payload_hash|provider_output|environment|credential|private reasoning/i);
});
