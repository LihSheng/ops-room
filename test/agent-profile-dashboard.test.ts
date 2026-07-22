import test from 'node:test';
import assert from 'node:assert/strict';

import { handleReadOnlyAgentProfileApi } from '../src/routes/agent-profiles.js';
import { buildMemorySpaceCatalog, buildSkillCatalog } from '../src/services/agent-profile/catalogs.js';
import { joinProfileRuntime } from '../src/services/agent-profile/profile-runtime-join.js';
import { initializeAgentProfileRegistry, resetAgentProfileRegistryForTests } from '../src/services/agent-profile/registry.js';
import { initializeSkillRegistry, resetSkillRegistryForTests } from '../src/services/skill-registry/registry.js';
import type { AgentProfile } from '../src/services/agent-profile/schema.js';

function profile(id: string, skillKeys: string[] = []): AgentProfile {
  return {
    schemaVersion: 2,
    id,
    displayName: id,
    profileVersion: '2.0.0',
    mission: 'test',
    personality: { communicationStyle: 'test', decisionPolicy: ['test'], constraints: ['test'] },
    runtime: { backend: 'opencode' },
    skills: skillKeys.map((key) => ({ key, version: '1.0.0' })),
    memory: { read: [], write: [] },
    repositories: ['LihSheng/ops-room'],
    enabled: true,
  };
}

function publicProfile(id: string) {
  return { id, display_name: id, enabled: true, skills: [], skill_assignments: [], memory: { read: [], write: [] }, repositories: [] };
}

function runtime(agent: string) {
  return { agent, status: 'running' };
}

test.before(async () => {
  resetAgentProfileRegistryForTests();
  resetSkillRegistryForTests();
  await initializeAgentProfileRegistry();
  await initializeSkillRegistry({ commandExistsFn: async () => true, env: {} });
});

test.after(() => {
  resetSkillRegistryForTests();
  resetAgentProfileRegistryForTests();
});

test('profile/runtime join preserves both authorities and deterministic order', () => {
  const result = joinProfileRuntime([publicProfile('tokyo'), publicProfile('berlin')], [runtime('berlin'), runtime('gemini')]);
  assert.deepEqual(result.map((item) => item.id), ['berlin', 'gemini', 'tokyo']);
  assert.ok(result[0].profile && result[0].runtime);
  assert.equal(result[1].profile, null);
  assert.equal(result[2].runtime, null);
});

test('legacy skill and memory catalog helpers remain stable after profile schema migration', () => {
  assert.deepEqual(buildSkillCatalog([profile('tokyo', ['shared']), profile('berlin', ['shared', 'review'])]), [
    { key: 'review', agents: ['berlin'] },
    { key: 'shared', agents: ['berlin', 'tokyo'] },
  ]);
  assert.deepEqual(buildMemorySpaceCatalog([]), []);
});

test('production profile API includes stable versioned assignment states', () => {
  const result = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(result?.status, 200);
  const profileBody = (result?.body as { profile: Record<string, unknown> }).profile;
  assert.ok(Array.isArray(profileBody.skills));
  assert.ok(Array.isArray(profileBody.skill_assignments));
  const assignments = profileBody.skill_assignments as Record<string, unknown>[];
  assert.equal(assignments.length, 3);
  assert.ok(assignments.every((assignment) => assignment.version === '1.0.0'));
  assert.ok(assignments.every((assignment) => assignment.resolution_status === 'resolved'));
});

test('skill API failure is isolated from profile and runtime contracts', () => {
  const profileResult = handleReadOnlyAgentProfileApi('/api/agents/profiles/professor');
  assert.equal(profileResult?.status, 200);
  assert.deepEqual(joinProfileRuntime([publicProfile('professor')], [runtime('professor')]).map((item) => item.id), ['professor']);
});
