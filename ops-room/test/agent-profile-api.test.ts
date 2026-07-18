import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReadOnlyAgentProfileApi } from '../src/routes/agent-profiles.js';
import { initializeAgentProfileRegistry, resetAgentProfileRegistryForTests } from '../src/services/agent-profile/registry.js';

test.before(async () => {
  resetAgentProfileRegistryForTests();
  await initializeAgentProfileRegistry();
});

test.after(() => resetAgentProfileRegistryForTests());

test('lists all canonical profiles in deterministic public shape', () => {
  const result = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  assert.equal(result?.status, 200);
  const body = result?.body as { profiles: Record<string, unknown>[]; count: number };
  assert.equal(body.count, 4);
  assert.deepEqual(body.profiles.map((item) => item.id), ['berlin', 'gemini', 'professor', 'tokyo']);
  assert.deepEqual(Object.keys(body.profiles[0]).sort(), [
    'display_name', 'enabled', 'id', 'memory', 'mission', 'personality', 'profile_version',
    'repositories', 'runtime', 'schema_version', 'skills',
  ]);
  assert.equal('source' in body.profiles[0], false);
  assert.equal('sourcePath' in body.profiles[0], false);
  assert.equal('container' in body.profiles[0], false);
  assert.equal('service' in body.profiles[0], false);
});

test('returns detail with the shared public serializer and 404 for unknown IDs', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(detail?.status, 200);
  const profile = (detail?.body as { profile: Record<string, unknown> }).profile;
  assert.equal(profile.id, 'berlin');
  assert.equal(profile.display_name, 'Berlin');

  assert.deepEqual(handleReadOnlyAgentProfileApi('/api/agents/profiles/unknown'), {
    status: 404,
    body: { error: 'agent_profile_not_found', agent_id: 'unknown' },
  });
});

test('rejects malformed and unsafe IDs before registry lookup', () => {
  assert.deepEqual(handleReadOnlyAgentProfileApi('/api/agents/profiles/..%2Fsecret'), {
    status: 400,
    body: { error: 'invalid_agent_profile_id', agent_id: '../secret' },
  });
  assert.equal(handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin/extra'), null);
});

test('returns normalized skill and memory-space contracts', () => {
  const skills = handleReadOnlyAgentProfileApi('/api/skills');
  assert.equal(skills?.status, 200);
  const skillBody = skills?.body as { skills: { key: string; agents: string[] }[]; count: number };
  assert.equal(skillBody.count, skillBody.skills.length);
  assert.deepEqual(skillBody.skills.map((item) => item.key), [...skillBody.skills.map((item) => item.key)].sort());

  const memory = handleReadOnlyAgentProfileApi('/api/memory-spaces');
  assert.equal(memory?.status, 200);
  const memoryBody = memory?.body as { memory_spaces: { key: string; readers: string[]; writers: string[] }[]; count: number };
  assert.equal(memoryBody.count, memoryBody.memory_spaces.length);
  for (const item of memoryBody.memory_spaces) {
    assert.deepEqual(item.readers, [...item.readers].sort());
    assert.deepEqual(item.writers, [...item.writers].sort());
  }
});
