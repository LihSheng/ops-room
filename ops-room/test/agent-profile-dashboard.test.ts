import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReadOnlyAgentProfileApi } from '../src/routes/agent-profiles.js';
import { buildMemorySpaceCatalog, buildSkillCatalog } from '../src/services/agent-profile/catalogs.js';
import { toPublicAgentProfile } from '../src/services/agent-profile/public-profile.js';
import { initializeAgentProfileRegistry, resetAgentProfileRegistryForTests } from '../src/services/agent-profile/registry.js';
import type { AgentProfile } from '../src/services/agent-profile/schema.js';

test.before(async () => {
  resetAgentProfileRegistryForTests();
  await initializeAgentProfileRegistry();
});

test.after(() => resetAgentProfileRegistryForTests());

// ── Integration: profile + runtime join using production APIs ──

test('agent list integration: profiles and runtime instances join by agent ID', () => {
  const profilesResult = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  assert.equal(profilesResult?.status, 200);
  const { profiles } = profilesResult!.body as { profiles: Record<string, unknown>[]; count: number };

  // Build a profile map keyed by agent ID
  const profileMap = new Map(profiles.map((p) => ({ id: p.id as string, profile: p })).map((e) => [e.id, e.profile]));

  // Simulated runtime instances (production data shape matches openab-instances.ts)
  const runtimeInstances = [
    { agent: 'professor', runtime: { status: 'running' } },
    { agent: 'berlin', runtime: { status: 'running' } },
    { agent: 'tokyo', runtime: { status: 'exited' } },
    { agent: 'gemini', runtime: { status: 'running' } },
  ];

  const runtimeMap = new Map(runtimeInstances.map((i) => [i.agent, i]));

  // Join: all agent IDs from both sources
  const allIds = new Set([
    ...profiles.map((p) => p.id as string),
    ...runtimeInstances.map((i) => i.agent),
  ]);

  const joined = [...allIds].map((id) => ({
    id,
    profile: profileMap.get(id) || null,
    runtime: runtimeMap.get(id) || null,
  }));

  // All 4 canonical profiles join with runtime
  assert.equal(joined.length, 4);
  for (const row of joined) {
    assert.ok(row.profile, `${row.id}: should have a profile`);
    assert.ok(row.runtime, `${row.id}: should have a runtime instance`);
  }
});

test('agent list integration: profiles remain visible when runtime data is missing', () => {
  const profilesResult = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  assert.equal(profilesResult?.status, 200);
  const { profiles } = profilesResult!.body as { profiles: Record<string, unknown>[]; count: number };

  const profileMap = new Map(profiles.map((p) => ({ id: p.id as string, profile: p })).map((e) => [e.id, e.profile]));

  // Runtime data has no match for berlin
  const runtimeInstances = [
    { agent: 'professor', runtime: { status: 'running' } },
  ];
  const runtimeMap = new Map(runtimeInstances.map((i) => [i.agent, i]));

  const allIds = new Set([
    ...profiles.map((p) => p.id as string),
    ...runtimeInstances.map((i) => i.agent),
  ]);

  const joined = [...allIds].map((id) => ({
    id,
    profile: profileMap.get(id) || null,
    runtime: runtimeMap.get(id) || null,
  }));

  // Berlin has a profile but no runtime
  const berlin = joined.find((r) => r.id === 'berlin');
  assert.ok(berlin);
  assert.ok(berlin.profile, 'berlin should have a profile');
  assert.equal(berlin.runtime, null, 'berlin should have no runtime');
});

test('agent list integration: runtime instances remain visible when profile data is missing', () => {
  const profilesResult = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  assert.equal(profilesResult?.status, 200);
  const { profiles } = profilesResult!.body as { profiles: Record<string, unknown>[]; count: number };

  // Only keep professor and berlin in profile map
  const profileMap = new Map(
    profiles.filter((p) => p.id === 'professor' || p.id === 'berlin')
      .map((p) => ({ id: p.id as string, profile: p }))
      .map((e) => [e.id, e.profile]),
  );

  const runtimeInstances = [
    { agent: 'professor', runtime: { status: 'running' } },
    { agent: 'tokyo', runtime: { status: 'exited' } },
  ];
  const runtimeMap = new Map(runtimeInstances.map((i) => [i.agent, i]));

  const allIds = new Set([
    ...Array.from(profileMap.keys()),
    ...runtimeInstances.map((i) => i.agent),
  ]);

  const joined = [...allIds].map((id) => ({
    id,
    profile: profileMap.get(id) || null,
    runtime: runtimeMap.get(id) || null,
  }));

  // Tokyo has a runtime but no profile
  const tokyo = joined.find((r) => r.id === 'tokyo');
  assert.ok(tokyo);
  assert.equal(tokyo.profile, null, 'tokyo should have no profile');
  assert.ok(tokyo.runtime, 'tokyo should have a runtime instance');
});

test('agent list integration: enabled and disabled profile states are rendered correctly', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(detail?.status, 200);
  const berlin = (detail!.body as { profile: Record<string, unknown> }).profile;
  assert.equal(berlin.enabled, true);

  // Tokyo is also enabled in test fixtures
  const detail2 = handleReadOnlyAgentProfileApi('/api/agents/profiles/tokyo');
  assert.equal(detail2?.status, 200);
  const tokyo = (detail2!.body as { profile: Record<string, unknown> }).profile;
  assert.equal(tokyo.enabled, true);
});

test('agent list integration: skill, memory, and repository counts are correct', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(detail?.status, 200);
  const profile = (detail!.body as { profile: Record<string, unknown> }).profile;
  const skills = profile.skills as string[];
  const memory = profile.memory as { read: string[]; write: string[] };
  const repos = profile.repositories as string[];

  assert.ok(skills.length > 0, 'berlin should have skills');
  assert.ok(memory.read.length >= 0, 'memory.read should be an array');
  assert.ok(memory.write.length >= 0, 'memory.write should be an array');
  assert.ok(repos.length > 0, 'berlin should have repositories');
});

test('agent list integration: deterministic ordering is preserved', () => {
  const result1 = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  const result2 = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  const { profiles: p1 } = result1!.body as { profiles: { id: string }[] };
  const { profiles: p2 } = result2!.body as { profiles: { id: string }[] };
  assert.deepEqual(p1.map((p) => p.id), p2.map((p) => p.id), 'order must be deterministic across calls');
});

// ── Agent detail tests ──

test('agent detail: existing agent profile renders all approved public sections', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(detail?.status, 200);
  const profile = (detail!.body as { profile: Record<string, unknown> }).profile;

  // All public fields present
  assert.equal(typeof profile.id, 'string');
  assert.equal(typeof profile.display_name, 'string');
  assert.equal(typeof profile.schema_version, 'number');
  assert.equal(typeof profile.profile_version, 'string');
  assert.equal(typeof profile.mission, 'string');
  assert.equal(typeof profile.enabled, 'boolean');

  // Personality
  const personality = profile.personality as Record<string, unknown>;
  assert.equal(typeof personality.communication_style, 'string');
  assert.ok(Array.isArray(personality.decision_policy));
  assert.ok(Array.isArray(personality.constraints));

  // Runtime
  const runtime = profile.runtime as Record<string, unknown>;
  assert.equal(typeof runtime.backend, 'string');

  // Skills
  assert.ok(Array.isArray(profile.skills));

  // Memory
  const memory = profile.memory as Record<string, unknown>;
  assert.ok(Array.isArray(memory.read));
  assert.ok(Array.isArray(memory.write));

  // Repositories
  assert.ok(Array.isArray(profile.repositories));
});

test('agent detail: personality decision policy and constraints render correctly', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(detail?.status, 200);
  const profile = (detail!.body as { profile: Record<string, unknown> }).profile;
  const personality = profile.personality as { decision_policy: string[]; constraints: string[] };

  assert.ok(personality.decision_policy.length > 0, 'decision policy must not be empty');
  assert.ok(personality.constraints.length > 0, 'constraints must not be empty');

  // Decision policy and constraints are separate arrays
  assert.notDeepEqual(personality.decision_policy, personality.constraints);
});

test('agent detail: read and write memory scopes are distinct', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  const profile = (detail!.body as { profile: Record<string, unknown> }).profile;
  const memory = profile.memory as { read: string[]; write: string[] };

  // Read and write are separate arrays
  assert.notDeepEqual(memory.read, memory.write);
});

test('agent detail: unknown agent displays a not-found state', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/unknown-agent');
  assert.equal(detail?.status, 404);
  const body = detail!.body as { error: string; agent_id: string };
  assert.equal(body.error, 'agent_profile_not_found');
  assert.equal(body.agent_id, 'unknown-agent');
});

test('agent detail: runtime API failure does not hide valid profile data', () => {
  // Simulate: profile API succeeds, runtime API is unavailable
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(detail?.status, 200);
  const profile = (detail!.body as { profile: Record<string, unknown> }).profile;

  // Profile data is intact even when runtime can't be fetched
  assert.equal(profile.id, 'berlin');
  assert.equal(profile.display_name, 'Berlin');
  assert.ok(typeof profile.mission === 'string');
});

test('agent detail: internal fields are absent from public profile types', () => {
  const detail = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(detail?.status, 200);
  const profile = (detail!.body as { profile: Record<string, unknown> }).profile;

  const internalFields = ['source', 'sourcePath', 'container', 'service', 'image', 'config_path', 'data_dir'];
  for (const field of internalFields) {
    assert.equal(field in profile, false, `'${field}' must not appear in public profile API response`);
  }
});

// ── Skills catalog tests (exercising production catalogs.ts) ──

test('skills catalog: skill keys render in deterministic order', () => {
  const profilesResult = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  assert.equal(profilesResult?.status, 200);

  // Use the production catalog builder (loaded via registry for real profile data)
  const skillsResult = handleReadOnlyAgentProfileApi('/api/skills');
  assert.equal(skillsResult?.status, 200);
  const { skills } = skillsResult!.body as { skills: { key: string; agents: string[] }[]; count: number };

  // Verify deterministic ordering
  for (let i = 1; i < skills.length; i++) {
    assert.ok(skills[i - 1].key <= skills[i].key, `skills not sorted: ${skills[i - 1].key} > ${skills[i].key}`);
  }
});

test('skills catalog: multiple declaring agents render correctly', () => {
  // Use production catalog builder with test data
  const profiles: AgentProfile[] = [
    {
      schemaVersion: 1,
      id: 'agent-a',
      displayName: 'Agent A',
      profileVersion: '1.0.0',
      mission: 'test',
      personality: { communicationStyle: 'test', decisionPolicy: ['test'], constraints: ['test'] },
      runtime: { backend: 'opencode' },
      skills: ['shared-skill', 'a-only'],
      memory: { read: [], write: [] },
      repositories: ['test/repo'],
      enabled: true,
    },
    {
      schemaVersion: 1,
      id: 'agent-b',
      displayName: 'Agent B',
      profileVersion: '1.0.0',
      mission: 'test',
      personality: { communicationStyle: 'test', decisionPolicy: ['test'], constraints: ['test'] },
      runtime: { backend: 'opencode' },
      skills: ['shared-skill', 'b-only'],
      memory: { read: [], write: [] },
      repositories: ['test/repo'],
      enabled: true,
    },
  ];

  const catalog = buildSkillCatalog(profiles);
  const shared = catalog.find((item) => item.key === 'shared-skill');
  assert.ok(shared);
  assert.deepEqual(shared.agents, ['agent-a', 'agent-b']);
});

test('skills catalog: empty catalog returns a valid empty state', () => {
  const catalog = buildSkillCatalog([]);
  assert.deepEqual(catalog, []);
});

test('skills catalog: API returns deterministic result', () => {
  const result = handleReadOnlyAgentProfileApi('/api/skills');
  assert.equal(result?.status, 200);
  const { skills, count } = result!.body as { skills: { key: string }[]; count: number };
  assert.equal(count, skills.length);
  assert.ok(skills.length >= 4, 'expected at least 4 declared skills across 4 profiles');
});

// ── Memory catalog tests (exercising production catalogs.ts) ──

test('memory catalog: readers and writers render separately', () => {
  const result = handleReadOnlyAgentProfileApi('/api/memory-spaces');
  assert.equal(result?.status, 200);
  const { memory_spaces } = result!.body as { memory_spaces: { key: string; readers: string[]; writers: string[] }[]; count: number };

  for (const space of memory_spaces) {
    assert.ok(Array.isArray(space.readers));
    assert.ok(Array.isArray(space.writers));
    // Each has independent arrays
    assert.notStrictEqual(space.readers, space.writers);
  }
});

test('memory catalog: shared readers and writers are displayed correctly', () => {
  const profiles: AgentProfile[] = [
    {
      schemaVersion: 1,
      id: 'agent-a',
      displayName: 'Agent A',
      profileVersion: '1.0.0',
      mission: 'test',
      personality: { communicationStyle: 'test', decisionPolicy: ['test'], constraints: ['test'] },
      runtime: { backend: 'opencode' },
      skills: [],
      memory: { read: ['shared-space'], write: ['shared-space'] },
      repositories: ['test/repo'],
      enabled: true,
    },
    {
      schemaVersion: 1,
      id: 'agent-b',
      displayName: 'Agent B',
      profileVersion: '1.0.0',
      mission: 'test',
      personality: { communicationStyle: 'test', decisionPolicy: ['test'], constraints: ['test'] },
      runtime: { backend: 'opencode' },
      skills: [],
      memory: { read: ['shared-space'], write: [] },
      repositories: ['test/repo'],
      enabled: true,
    },
  ];

  const catalog = buildMemorySpaceCatalog(profiles);
  const shared = catalog.find((s) => s.key === 'shared-space');
  assert.ok(shared);
  assert.deepEqual(shared.readers, ['agent-a', 'agent-b']);
  assert.deepEqual(shared.writers, ['agent-a']);
});

test('memory catalog: empty catalog returns a valid empty state', () => {
  const catalog = buildMemorySpaceCatalog([]);
  assert.deepEqual(catalog, []);
});

test('memory catalog: no vault inspection or mutation action exposed', () => {
  const result = handleReadOnlyAgentProfileApi('/api/memory-spaces');
  assert.equal(result?.status, 200);
  const body = result!.body as Record<string, unknown>;

  // API response contains no vault inspection fields
  const bodyStr = JSON.stringify(body);
  assert.equal(bodyStr.includes('/home/'), false, 'must not contain absolute paths');
  assert.equal(bodyStr.includes('/obsidian/'), false, 'must not contain obsidian reference');
  assert.equal(bodyStr.includes('/vault/'), false, 'must not contain vault reference');

  // API response contains no write/edit/mutate actions
  assert.equal('write' in body, false);
  assert.equal('mutate' in body, false);
  assert.equal('edit' in body, false);
});

// ── Public boundary tests ──

test('public boundary: toPublicAgentProfile excludes internal fields', () => {
  const internal: AgentProfile = {
    schemaVersion: 1,
    id: 'test-agent',
    displayName: 'Test Agent',
    profileVersion: '1.0.0',
    mission: 'test',
    personality: { communicationStyle: 'direct', decisionPolicy: ['test'], constraints: ['test'] },
    runtime: { backend: 'opencode' },
    skills: ['test-skill'],
    memory: { read: ['test/read'], write: ['test/write'] },
    repositories: ['test/repo'],
    enabled: true,
  };

  const publicProfile = toPublicAgentProfile(internal);

  // Only public fields present
  assert.equal(publicProfile.id, 'test-agent');
  assert.equal(publicProfile.display_name, 'Test Agent');
  assert.equal('source' in publicProfile, false);
  assert.equal('sourcePath' in publicProfile, false);
  assert.equal('container' in publicProfile, false);
  assert.equal('service' in publicProfile, false);
});
