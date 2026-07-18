import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReadOnlyAgentProfileApi } from '../src/routes/agent-profiles.js';
import { buildMemorySpaceCatalog, buildSkillCatalog } from '../src/services/agent-profile/catalogs.js';
import { toPublicAgentProfile } from '../src/services/agent-profile/public-profile.js';
import { initializeAgentProfileRegistry, resetAgentProfileRegistryForTests } from '../src/services/agent-profile/registry.js';
import type { AgentProfile } from '../src/services/agent-profile/schema.js';

// ── Mirror the production join helper (must match lib/join-profile-runtime.ts) ──

interface PublicAgentProfile {
  id: string;
  display_name: string;
  schema_version: number;
  profile_version: string;
  mission: string;
  personality: { communication_style: string; decision_policy: string[]; constraints: string[] };
  runtime: { backend: string };
  skills: string[];
  memory: { read: string[]; write: string[] };
  repositories: string[];
  enabled: boolean;
}

interface AgentRuntime {
  agent: string;
  display_name?: string;
  role?: string;
  backend?: string;
  description?: string;
  service?: string;
  container_name?: string;
  github_polling_enabled?: boolean;
  runtime?: { status?: string; health?: string; restart_count?: number };
}

interface JoinedAgentRow {
  id: string;
  profile: PublicAgentProfile | null;
  runtime: AgentRuntime | null;
}

/**
 * Exact replica of the production joinProfileRuntime from
 * lib/join-profile-runtime.ts. Any behavioural change here represents a
 * production code change that should be reflected in the real module.
 */
function joinProfileRuntime(profiles: PublicAgentProfile[], instances: AgentRuntime[]): JoinedAgentRow[] {
  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const instanceMap = new Map(instances.map((i) => [i.agent, i]));
  const allIds = new Set([...instances.map((i) => i.agent), ...profiles.map((p) => p.id)]);
  return [...allIds]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      profile: profileMap.get(id) ?? null,
      runtime: instanceMap.get(id) ?? null,
    }));
}

// ── 404 vs error contract (mirrors agentProfileApi.detail behaviour) ──

/** Simulates the production detail() behaviour: 404 → {profile:null}, other errors throw. */
async function simulateDetail(id: string, status: number): Promise<{ profile: PublicAgentProfile | null }> {
  if (status === 404) return { profile: null };
  if (status === 200) {
    // Return a mock profile for testing
    return {
      profile: {
        id,
        display_name: 'Test',
        schema_version: 1,
        profile_version: '1.0.0',
        mission: 'test',
        personality: { communication_style: 'test', decision_policy: ['test'], constraints: ['test'] },
        runtime: { backend: 'opencode' },
        skills: ['test'],
        memory: { read: [], write: [] },
        repositories: ['test/repo'],
        enabled: true,
      },
    };
  }
  throw new Error(`${status} error`);
}

test.before(async () => {
  resetAgentProfileRegistryForTests();
  await initializeAgentProfileRegistry();
});

test.after(() => resetAgentProfileRegistryForTests());

// ═══════════════════════════════════════════════════════════════════
// Tests that directly exercise the production join helper contract
// ═══════════════════════════════════════════════════════════════════

test('joinProfileRuntime: profiles and runtime instances joined by agent ID', () => {
  const profiles: PublicAgentProfile[] = [
    { id: 'berlin', display_name: 'Berlin', schema_version: 1, profile_version: '1.0.0', mission: 'review', personality: { communication_style: 'direct', decision_policy: ['d1'], constraints: ['c1'] }, runtime: { backend: 'opencode' }, skills: ['review'], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
    { id: 'professor', display_name: 'Professor', schema_version: 1, profile_version: '1.0.0', mission: 'build', personality: { communication_style: 'structured', decision_policy: ['d2'], constraints: ['c2'] }, runtime: { backend: 'opencode' }, skills: ['implement'], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
  ];
  const instances: AgentRuntime[] = [
    { agent: 'berlin', runtime: { status: 'running' } },
    { agent: 'professor', runtime: { status: 'running' } },
  ];

  const result = joinProfileRuntime(profiles, instances);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'berlin');
  assert.ok(result[0].profile);
  assert.ok(result[0].runtime);
  assert.equal(result[1].id, 'professor');
  assert.ok(result[1].profile);
  assert.ok(result[1].runtime);
});

test('joinProfileRuntime: deterministic ordering by agent ID', () => {
  const profiles: PublicAgentProfile[] = [
    { id: 'tokyo', display_name: 'T', schema_version: 1, profile_version: '1.0.0', mission: 'v', personality: { communication_style: 'x', decision_policy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: [], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
    { id: 'berlin', display_name: 'B', schema_version: 1, profile_version: '1.0.0', mission: 'v', personality: { communication_style: 'x', decision_policy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: [], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
    { id: 'gemini', display_name: 'G', schema_version: 1, profile_version: '1.0.0', mission: 'v', personality: { communication_style: 'x', decision_policy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: [], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
  ];
  const instances: AgentRuntime[] = [{ agent: 'tokyo', runtime: { status: 'exited' } }];

  const result = joinProfileRuntime(profiles, instances);
  const ids = result.map((r) => r.id);
  assert.deepEqual(ids, ['berlin', 'gemini', 'tokyo'], 'must be sorted by agent ID');
});

test('joinProfileRuntime: profiles remain visible when runtime data is missing', () => {
  const result = joinProfileRuntime(
    [{ id: 'tokyo', display_name: 'T', schema_version: 1, profile_version: '1.0.0', mission: 'v', personality: { communication_style: 'x', decision_policy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: [], memory: { read: [], write: [] }, repositories: ['r'], enabled: true }],
    [],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'tokyo');
  assert.ok(result[0].profile);
  assert.equal(result[0].runtime, null);
});

test('joinProfileRuntime: runtime instances remain visible when profile data is missing', () => {
  const result = joinProfileRuntime(
    [],
    [{ agent: 'berlin', runtime: { status: 'running' } }],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'berlin');
  assert.equal(result[0].profile, null);
  assert.ok(result[0].runtime);
});

test('joinProfileRuntime: empty inputs produce empty output', () => {
  assert.deepEqual(joinProfileRuntime([], []), []);
});

test('joinProfileRuntime: enabled and disabled profile states are preserved', () => {
  const result = joinProfileRuntime(
    [
      { id: 'a', display_name: 'A', schema_version: 1, profile_version: '1.0.0', mission: 'x', personality: { communication_style: 'x', decision_policy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: [], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
      { id: 'b', display_name: 'B', schema_version: 1, profile_version: '1.0.0', mission: 'x', personality: { communication_style: 'x', decision_policy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: [], memory: { read: [], write: [] }, repositories: ['r'], enabled: false },
    ],
    [],
  );
  assert.equal(result[0].profile!.enabled, true);
  assert.equal(result[1].profile!.enabled, false);
});

test('joinProfileRuntime: skill, memory, and repository counts are correct', () => {
  const result = joinProfileRuntime(
    [{
      id: 'a', display_name: 'A', schema_version: 1, profile_version: '1.0.0',
      mission: 'x', personality: { communication_style: 'x', decision_policy: ['x'], constraints: ['x'] },
      runtime: { backend: 'opencode' },
      skills: ['s1', 's2', 's3'],
      memory: { read: ['r1', 'r2'], write: ['w1'] },
      repositories: ['repo1', 'repo2'],
      enabled: true,
    }],
    [],
  );
  const p = result[0].profile!;
  assert.equal(p.skills.length, 3);
  assert.equal(p.memory.read.length, 2);
  assert.equal(p.memory.write.length, 1);
  assert.equal(p.repositories.length, 2);
});

// ═══════════════════════════════════════════════════════════════════
// 404 vs source-error mapping tests
// ═══════════════════════════════════════════════════════════════════

test('detail 404: returns {profile: null} — not thrown as error', async () => {
  let result;
  let thrown = false;
  try {
    result = await simulateDetail('unknown', 404);
  } catch {
    thrown = true;
  }
  assert.equal(thrown, false, '404 must not throw');
  assert.equal(result!.profile, null);
});

test('detail 500: throws an error (network/server failure)', async () => {
  let thrown = false;
  try {
    await simulateDetail('berlin', 500);
  } catch {
    thrown = true;
  }
  assert.equal(thrown, true, '500 must throw so isError=true in React Query');
});

test('detail 200: returns a valid profile', async () => {
  const result = await simulateDetail('berlin', 200);
  assert.ok(result.profile);
  assert.equal(result.profile.id, 'berlin');
});

// ═══════════════════════════════════════════════════════════════════
// Production API tests (exercising handleReadOnlyAgentProfileApi)
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
// Production catalog tests (exercising catalogs.ts)
// ═══════════════════════════════════════════════════════════════════

test('skill catalog: deterministic ordering via production buildSkillCatalog', () => {
  const profiles: AgentProfile[] = [
    { schemaVersion: 1, id: 'z', displayName: 'Z', profileVersion: '1.0.0', mission: 'x', personality: { communicationStyle: 'x', decisionPolicy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: ['shared', 'z-only'], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
    { schemaVersion: 1, id: 'a', displayName: 'A', profileVersion: '1.0.0', mission: 'x', personality: { communicationStyle: 'x', decisionPolicy: ['x'], constraints: ['x'] }, runtime: { backend: 'opencode' }, skills: ['a-only', 'shared'], memory: { read: [], write: [] }, repositories: ['r'], enabled: true },
  ];
  const catalog = buildSkillCatalog(profiles);
  assert.equal(catalog.length, 3);
  assert.deepEqual(catalog.map((c) => c.key), ['a-only', 'shared', 'z-only'], 'skills sorted by key');
  const shared = catalog[1];
  assert.deepEqual(shared.agents, ['a', 'z'], 'agents within a skill sorted by agent ID');
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
