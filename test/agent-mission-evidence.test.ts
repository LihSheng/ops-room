import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enrichAgentFleetWithMissionEvidence,
  getAgentFleetWithMissionEvidence,
} from '../src/services/agent-fleet-missions.js';
import { buildAgentMissionIndex } from '../src/services/agent-mission-evidence.js';

const SHA_A = 'a'.repeat(40);

function mission(overrides: Record<string, unknown> = {}) {
  return {
    mission_id: 'mission:ops-012c:aaaaaaaaaaaaaaaaaaaaaaaa',
    title: 'Expose current mission evidence',
    state: 'active',
    priority: 'high',
    repository_id: 'LihSheng/ops-room',
    starting_branch: 'main',
    starting_sha: SHA_A,
    workflow_type: 'feature-development',
    workflow_id: 'workflow:LihSheng-ops-room:aaaaaaaaaaaaaaaaaaaaaaaa',
    policy: { max_iterations: 3, approval_policy: 'berlin-review-required' },
    participants: [
      { agent_id: 'professor', roles: ['implementation', 'integration'] },
      { agent_id: 'tokyo', roles: ['test'] },
      { agent_id: 'berlin', roles: ['review'] },
    ],
    created_at: '2026-07-23T01:00:00.000Z',
    updated_at: '2026-07-23T02:00:00.000Z',
    ...overrides,
  };
}

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    workflow_id: 'workflow:LihSheng-ops-room:aaaaaaaaaaaaaaaaaaaaaaaa',
    workflow_type: 'feature-development',
    repository_id: 'LihSheng/ops-room',
    source_sha: SHA_A,
    state: 'active',
    policy: { max_iterations: 3, max_concurrency: 1 },
    current_iteration: 1,
    children: [{
      child_id: 'workflow:LihSheng-ops-room:aaaaaaaaaaaaaaaaaaaaaaaa:1:implementation',
      stage: 'implementation',
      owner_agent: 'professor',
      iteration: 1,
      state: 'pending',
      updated_at: '2026-07-23T02:05:00.000Z',
    }],
    created_at: '2026-07-23T02:00:00.000Z',
    updated_at: '2026-07-23T02:05:00.000Z',
    ...overrides,
  };
}

function baseFleet() {
  return {
    fleet: ['berlin', 'professor', 'tokyo'].map((id) => ({
      id,
      current_mission: null,
      last_activity_at: '2026-07-23T01:30:00.000Z',
    })),
    count: 3,
    generated_at: '2026-07-23T02:10:00.000Z',
    sources: {
      profiles: 'available',
      runtime: 'available',
      tasks: 'available',
      missions: 'deferred_to_ops_012c',
    },
  };
}

test('all declared participants receive the same bounded mission with distinct stage ownership', () => {
  const index = buildAgentMissionIndex({ missions: [mission()], workflows: [workflow()] });
  const professor = index.get('professor');
  const tokyo = index.get('tokyo');
  const berlin = index.get('berlin');

  assert.equal(professor.mission_id, tokyo.mission_id);
  assert.equal(tokyo.mission_id, berlin.mission_id);
  assert.deepEqual(professor.participant_roles, ['implementation', 'integration']);
  assert.deepEqual(tokyo.participant_roles, ['test']);
  assert.deepEqual(berlin.participant_roles, ['review']);
  assert.equal(professor.stage, 'implementation');
  assert.equal(professor.stage_state, 'pending');
  assert.equal(professor.stage_owner, 'professor');
  assert.equal(professor.current_agent_is_stage_owner, true);
  assert.equal(tokyo.current_agent_is_stage_owner, false);
  assert.equal(berlin.current_agent_is_stage_owner, false);
  assert.equal(professor.evidence_status, 'available');
  assert.equal(professor.starting_sha, SHA_A);
  assert.equal('objective' in professor, false);
  assert.equal('history' in professor, false);
});

test('selection is deterministic and prioritizes the mission whose current stage belongs to the agent', () => {
  const olderOwned = mission({
    mission_id: 'mission:owned:bbbbbbbbbbbbbbbbbbbbbbbb',
    title: 'Owned stage mission',
    workflow_id: 'workflow:LihSheng-ops-room:bbbbbbbbbbbbbbbbbbbbbbbb',
    updated_at: '2026-07-23T01:00:00.000Z',
  });
  const newerParticipant = mission({
    mission_id: 'mission:participant:cccccccccccccccccccccccc',
    title: 'Newer participant mission',
    workflow_id: 'workflow:LihSheng-ops-room:cccccccccccccccccccccccc',
    priority: 'urgent',
    updated_at: '2026-07-23T03:00:00.000Z',
  });
  const ownedWorkflow = workflow({
    workflow_id: olderOwned.workflow_id,
    children: [{
      child_id: `${olderOwned.workflow_id}:1:test`,
      stage: 'test',
      owner_agent: 'tokyo',
      iteration: 1,
      state: 'active',
      updated_at: '2026-07-23T01:05:00.000Z',
    }],
  });
  const participantWorkflow = workflow({
    workflow_id: newerParticipant.workflow_id,
    children: [{
      child_id: `${newerParticipant.workflow_id}:1:implementation`,
      stage: 'implementation',
      owner_agent: 'professor',
      iteration: 1,
      state: 'active',
      updated_at: '2026-07-23T03:05:00.000Z',
    }],
  });

  const index = buildAgentMissionIndex({
    missions: [newerParticipant, olderOwned],
    workflows: [participantWorkflow, ownedWorkflow],
  });
  const tokyo = index.get('tokyo');

  assert.equal(tokyo.mission_id, olderOwned.mission_id);
  assert.equal(tokyo.current_agent_is_stage_owner, true);
  assert.equal(tokyo.additional_mission_count, 1);
});

test('valid mission evidence remains visible when its workflow is unavailable', () => {
  const index = buildAgentMissionIndex({ missions: [mission()], workflows: [] });
  const professor = index.get('professor');

  assert.equal(professor.title, 'Expose current mission evidence');
  assert.equal(professor.workflow_id, mission().workflow_id);
  assert.equal(professor.workflow_state, null);
  assert.equal(professor.stage, null);
  assert.equal(professor.evidence_status, 'workflow_unavailable');
  assert.equal(professor.attention_required, true);
  assert.equal(professor.attention_reason_code, 'workflow_unavailable');
});

test('fleet enrichment preserves task/runtime authority and reports degraded source state', () => {
  const result = enrichAgentFleetWithMissionEvidence({
    fleetSnapshot: baseFleet(),
    missions: [mission(), { unavailable: true }],
    workflows: [workflow(), { unavailable: true }],
  });
  const professor = result.fleet.find((agent: any) => agent.id === 'professor');

  assert.equal(result.sources.tasks, 'available');
  assert.equal(result.sources.missions, 'degraded');
  assert.equal(result.sources.workflows, 'degraded');
  assert.equal(professor.current_mission.title, 'Expose current mission evidence');
  assert.equal(professor.last_activity_at, '2026-07-23T02:05:00.000Z');
});

test('mission and workflow store failures degrade independently without exposing errors', async () => {
  const result = await getAgentFleetWithMissionEvidence({
    getBaseFleet: async () => baseFleet(),
    getMissions: async () => { throw new Error('/private/mission/path'); },
    getWorkflows: async () => [workflow()],
  });

  assert.equal(result.sources.missions, 'unavailable');
  assert.equal(result.sources.workflows, 'available');
  assert.ok(result.fleet.every((agent: any) => agent.current_mission === null));
  assert.equal(JSON.stringify(result).includes('/private/mission/path'), false);
});
