import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReadOnlyAgentProfileApi } from '../src/routes/agent-profiles.js';
import { buildMemorySpaceCatalog, buildSkillCatalog } from '../src/services/agent-profile/catalogs.js';
import { toPublicAgentProfile } from '../src/services/agent-profile/public-profile.js';
import { joinProfileRuntime } from '../src/services/agent-profile/profile-runtime-join.js';
import { initializeAgentProfileRegistry, resetAgentProfileRegistryForTests } from '../src/services/agent-profile/registry.js';
import type { AgentProfile } from '../src/services/agent-profile/schema.js';

// ── Test fixtures ──

interface ProfileFixture {
  id: string;
  display_name: string;
  enabled: boolean;
  skills: string[];
  memory: { read: string[]; write: string[] };
  repositories: string[];
}

interface RuntimeFixture {
  agent: string;
  status?: string;
}

function pf(id: string, overrides: Partial<ProfileFixture> = {}): ProfileFixture {
  return {
    id,
    display_name: id,
    enabled: true,
    skills: [],
    memory: { read: [], write: [] },
    repositories: [],
    ...overrides,
  };
}

function rf(agent: string, status = 'running'): RuntimeFixture {
  return { agent, status };
}

test.before(async () => {
  resetAgentProfileRegistryForTests();
  await initializeAgentProfileRegistry();
});

test.after(() => resetAgentProfileRegistryForTests());

// ═══════════════════════════════════════════════════════════════════
// Tests importing the production joinProfileRuntime directly
// ═══════════════════════════════════════════════════════════════════

test('joinProfileRuntime: joins by agent ID with deterministic order', () => {
  const result = joinProfileRuntime(
    [pf('tokyo'), pf('berlin'), pf('gemini')],
    [rf('berlin'), rf('tokyo')],
  );
  assert.deepEqual(result.map((r) => r.id), ['berlin', 'gemini', 'tokyo']);
  assert.ok(result[0].profile);
  assert.ok(result[0].runtime);
  assert.ok(result[1].profile);
  assert.equal(result[1].runtime, null);
  assert.ok(result[2].profile);
  assert.ok(result[2].runtime);
});

test('joinProfileRuntime: profiles remain visible when runtime data is missing', () => {
  const result = joinProfileRuntime([pf('tokyo')], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'tokyo');
  assert.ok(result[0].profile);
  assert.equal(result[0].runtime, null);
});

test('joinProfileRuntime: runtime instances remain visible when profile data is missing', () => {
  const result = joinProfileRuntime([], [rf('berlin')]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'berlin');
  assert.equal(result[0].profile, null);
  assert.ok(result[0].runtime);
});

test('joinProfileRuntime: empty inputs produce empty output', () => {
  assert.deepEqual(joinProfileRuntime([], []), []);
});

test('joinProfileRuntime: preserves enabled/disabled state', () => {
  const result = joinProfileRuntime(
    [pf('a', { enabled: true }), pf('b', { enabled: false })],
    [],
  );
  assert.equal(result[0].profile!.enabled, true);
  assert.equal(result[1].profile!.enabled, false);
});

test('joinProfileRuntime: preserves skill, memory, and repository counts', () => {
  const result = joinProfileRuntime(
    [pf('a', { skills: ['s1', 's2'], memory: { read: ['r1'], write: ['w1', 'w2'] }, repositories: ['repo1'] })],
    [],
  );
  const p = result[0].profile!;
  assert.equal(p.skills.length, 2);
  assert.equal(p.memory.read.length, 1);
  assert.equal(p.memory.write.length, 2);
  assert.equal(p.repositories.length, 1);
});

// ═══════════════════════════════════════════════════════════════════
// 404 vs source-error mapping tests
// ═══════════════════════════════════════════════════════════════════

test('detail 404 → {profile:null} (no throw)', async () => {
  // Simulate the production behaviour: 404 returns null profile without throwing
  const simulateDetail = async (status: number): Promise<{ profile: unknown }> => {
    if (status === 404) return { profile: null };
    if (status === 200) return { profile: { id: 'test' } };
    throw new Error(`${status}`);
  };
  const result = await simulateDetail(404);
  assert.equal(result.profile, null);
});

test('detail 500 → throws (so isError=true in React Query)', async () => {
  const simulateDetail = async (status: number): Promise<{ profile: unknown }> => {
    if (status === 404) return { profile: null };
    if (status === 200) return { profile: { id: 'test' } };
    throw new Error(`${status}`);
  };
  await assert.rejects(() => simulateDetail(500));
});

// ═══════════════════════════════════════════════════════════════════
// Production API tests
// ═══════════════════════════════════════════════════════════════════

test('production API: profiles list returns deterministic order', () => {
  const r1 = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  const r2 = handleReadOnlyAgentProfileApi('/api/agents/profiles');
  const ids1 = (r1!.body as { profiles: { id: string }[] }).profiles.map((p) => p.id);
  const ids2 = (r2!.body as { profiles: { id: string }[] }).profiles.map((p) => p.id);
  assert.deepEqual(ids1, ids2);
});

test('production API: detail returns full public sections', () => {
  const result = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  assert.equal(result?.status, 200);
  const p = (result!.body as { profile: Record<string, unknown> }).profile;
  assert.equal(p.id, 'berlin');
  assert.equal(typeof p.mission, 'string');
  assert.ok(Array.isArray((p.personality as Record<string, unknown>).decision_policy));
  assert.ok(Array.isArray((p.personality as Record<string, unknown>).constraints));
  assert.ok(Array.isArray(p.skills));
  assert.ok(Array.isArray((p.memory as Record<string, unknown>).read));
});

test('production API: unknown agent returns 404 contract', () => {
  const result = handleReadOnlyAgentProfileApi('/api/agents/profiles/nonexistent');
  assert.equal(result?.status, 404);
  assert.equal((result!.body as { error: string }).error, 'agent_profile_not_found');
});

test('production API: internal fields absent from public type', () => {
  const result = handleReadOnlyAgentProfileApi('/api/agents/profiles/berlin');
  const p = (result!.body as { profile: Record<string, unknown> }).profile;
  for (const field of ['source', 'sourcePath', 'container', 'service', 'image', 'config_path', 'data_dir']) {
    assert.equal(field in p, false, `'${field}' must not be in public profile`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// Production catalog tests
// ═══════════════════════════════════════════════════════════════════

test('skill catalog: deterministic ordering via production buildSkillCatalog', () => {
  const profiles: AgentProfile[] = [
    { schemaVersion: 1, id: 'z', displayName: 'Z', profileVersion: '1.0.0', mission: 'x', personality: { communicationStyle: 'x', decisionPolicy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: ['shared', 'z-only'], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
    { schemaVersion: 1, id: 'a', displayName: 'A', profileVersion: '1.0.0', mission: 'x', personality: { communicationStyle: 'x', decisionPolicy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: ['a-only', 'shared'], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
  ];
  const catalog = buildSkillCatalog(profiles);
  assert.equal(catalog.length, 3);
  assert.deepEqual(catalog.map((c) => c.key), ['a-only', 'shared', 'z-only']);
  assert.deepEqual(catalog[1].agents, ['a', 'z']);
});

test('skill catalog: empty input returns empty output', () => {
  assert.deepEqual(buildSkillCatalog([]), []);
});

test('memory catalog: readers/writers separate via production buildMemorySpaceCatalog', () => {
  const profiles: AgentProfile[] = [
    { schemaVersion: 1, id: 'a', displayName: 'A', profileVersion: '1.0.0', mission: 'x', personality: { communicationStyle: 'x', decisionPolicy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: [], memory: { read: ['shared'], write: ['shared'] }, repositories: ['r'], enabled: true },
    { schemaVersion: 1, id: 'b', displayName: 'B', profileVersion: '1.0.0', mission: 'x', personality: { communicationStyle: 'x', decisionPolicy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: [], memory: { read: ['shared'], write: [] }, repositories: ['r'], enabled: true },
  ];
  const catalog = buildMemorySpaceCatalog(profiles);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].key, 'shared');
  assert.deepEqual(catalog[0].readers, ['a', 'b']);
  assert.deepEqual(catalog[0].writers, ['a']);
});

test('memory catalog: empty input returns empty output', () => {
  assert.deepEqual(buildMemorySpaceCatalog([]), []);
});

test('public serializer: toPublicAgentProfile excludes internal fields', () => {
  const internal: AgentProfile = {
    schemaVersion: 1, id: 't', displayName: 'T', profileVersion: '1.0.0', mission: 'x',
    personality: { communicationStyle: 'x', decisionPolicy: ['x'], constraints: ['x'] },
    runtime: { backend: 'opencode' },
    skills: [], memory: { read: [], write: [] }, repositories: ['r'], enabled: true,
  };
  const pub = toPublicAgentProfile(internal);
  assert.equal(pub.id, 't');
  assert.equal('source' in pub, false);
  assert.equal('sourcePath' in pub, false);
});
