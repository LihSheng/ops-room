import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReadOnlyAgentProfileApi } from '../src/routes/agent-profiles.js';
import { initializeAgentProfileRegistry, resetAgentProfileRegistryForTests } from '../src/services/agent-profile/registry.js';
import { initializeSkillRegistry, resetSkillRegistryForTests } from '../src/services/skill-registry/registry.js';

const env = {
  ...process.env,
  OPS_ROOM_CREDENTIAL_REFERENCE_MAP: JSON.stringify({ github: 'TEST_GITHUB_TOKEN' }),
  TEST_GITHUB_TOKEN: 'test-value-never-returned',
};

test.before(async () => {
  resetAgentProfileRegistryForTests();
  resetSkillRegistryForTests();
  await initializeAgentProfileRegistry();
  await initializeSkillRegistry({ commandExistsFn: async () => true, env });
});

test.after(() => {
  resetSkillRegistryForTests();
  resetAgentProfileRegistryForTests();
});

test('lists canonical profiles with backward-compatible skill keys and versioned assignments', () => {
  const result = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  assert.equal(result?.status, 200);
  const body = result?.body as { profiles: Record<string, unknown>[]; count: number };
  assert.equal(body.count, 4);
  assert.deepEqual(body.profiles.map((item) => item.id), ['berlin', 'gemini', 'professor', 'tokyo']);
  assert.deepEqual(Object.keys(body.profiles[0]).sort(), [
    'display_name', 'enabled', 'id', 'memory', 'mission', 'personality', 'profile_version',
    'repositories', 'runtime', 'schema_version', 'skill_assignments', 'skills',
  ]);
  assert.deepEqual(body.profiles[0].skills, ['pull-request-review', 'risk-analysis', 'security-review']);
  const assignments = body.profiles[0].skill_assignments as Record<string, unknown>[];
  assert.equal(assignments[0].version, '1.0.0');
  assert.equal(assignments[0].resolution_status, 'resolved');
  assert.equal((assignments[0].compatibility as Record<string, unknown>).status, 'compatible');
  assert.equal(JSON.stringify(body).includes('test-value-never-returned'), false);
});

test('profile detail and malformed agent identifiers retain their contracts', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(detail?.status, 200);
  assert.equal((detail?.body as { profile: { id: string } }).profile.id, 'berlin');
  assert.deepEqual(handleReadOnlyAgentProfileApi('/api/agents/profiles/unknown'), {
    status: 404,
    body: { error: 'agent_profile_not_found', agent_id: 'unknown' },
  });
  assert.deepEqual(handleReadOnlyAgentProfileApi('/api/agents/profiles/..%2Fsecret'), {
    status: 400,
    body: { error: 'invalid_agent_profile_id', agent_id: '../secret' },
  });
});

test('skill catalog preserves key and agents while adding deterministic version metadata', () => {
  const result = handleReadOnlyAgentProfileApi('/api/skills');
  assert.equal(result?.status, 200);
  const body = result?.body as { skills: Record<string, unknown>[]; count: number };
  assert.equal(body.count, 12);
  assert.deepEqual(body.skills.map((item) => item.key), [...body.skills.map((item) => item.key)].sort());
  const review = body.skills.find((item) => item.key === 'pull-request-review')!;
  assert.equal(review.version, '1.0.0');
  assert.deepEqual(review.agents, ['berlin']);
  assert.deepEqual(review.required_commands, ['git', 'gh']);
  assert.deepEqual(review.required_credentials, ['github']);
  assert.deepEqual(review.compatibility_summary, { compatible: 1, incompatible: 0, unknown: 0 });
});

test('skill detail returns safe assignments and rejects unknown, malformed, and traversal identifiers', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/skills/pull-request-review/1.0.0');
  assert.equal(detail?.status, 200);
  const serialized = JSON.stringify(detail?.body);
  assert.equal(serialized.includes('test-value-never-returned'), false);
  assert.equal(serialized.includes('sourcePath'), false);
  assert.equal(serialized.includes('config/skills'), false);

  assert.deepEqual(handleReadOnlyAgentProfileApi('/api/skills/unknown/1.0.0'), {
    status: 404,
    body: { error: 'skill_not_found', key: 'unknown', version: '1.0.0' },
  });
  assert.deepEqual(handleReadOnlyAgentProfileApi('/api/skills/..%2Fsecret/1.0.0'), {
    status: 400,
    body: { error: 'invalid_skill_identifier' },
  });
  assert.deepEqual(handleReadOnlyAgentProfileApi('/api/skills/review/latest'), {
    status: 400,
    body: { error: 'invalid_skill_identifier' },
  });
});
