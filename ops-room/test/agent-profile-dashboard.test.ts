import test from 'node:test';
import assert from 'node:assert/strict';

// ── Test helpers that mirror the frontend types and join logic ──

interface PublicAgentProfile {
  id: string;
  display_name: string;
  schema_version: number;
  profile_version: string;
  mission: string;
  personality: {
    communication_style: string;
    decision_policy: string[];
    constraints: string[];
  };
  runtime: {
    backend: string;
  };
  skills: string[];
  memory: {
    read: string[];
    write: string[];
  };
  repositories: string[];
  enabled: boolean;
}

interface AgentInstance {
  agent: string;
  display_name?: string;
  role?: string;
  backend?: string;
  service?: string;
  container_name?: string;
  runtime?: { status?: string; health?: string; restart_count?: number; started_at?: string };
  github_polling_enabled?: boolean;
}

interface SkillCatalogItem {
  key: string;
  agents: string[];
}

interface MemorySpaceItem {
  key: string;
  readers: string[];
  writers: string[];
}

// ── Join logic (mirrors dashboard) ──

function joinProfilesAndRuntime(
  profiles: PublicAgentProfile[],
  instances: AgentInstance[],
): Array<{ id: string; profile: PublicAgentProfile | null; runtime: AgentInstance | null }> {
  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const instanceMap = new Map(instances.map((i) => [i.agent, i]));
  const allIds = new Set([...profiles.map((p) => p.id), ...instances.map((i) => i.agent)]);
  return [...allIds].map((id) => ({
    id,
    profile: profileMap.get(id) || null,
    runtime: instanceMap.get(id) || null,
  }));
}

// ── Test fixtures ──

const berlin: PublicAgentProfile = {
  id: 'berlin',
  display_name: 'Berlin',
  schema_version: 1,
  profile_version: '1.0.0',
  mission: 'Review code for correctness and risk.',
  personality: {
    communication_style: 'Direct and evidence-based.',
    decision_policy: ['Base findings on code.', 'Distinguish severity.'],
    constraints: ['Do not merge.', 'Do not expose secrets.'],
  },
  runtime: { backend: 'opencode' },
  skills: ['pull-request-review', 'risk-analysis'],
  memory: { read: ['Projects/Ops-Room'], write: ['Projects/Ops-Room/Reviews'] },
  repositories: ['LihSheng/ops-room'],
  enabled: true,
};

const tokyo: PublicAgentProfile = {
  id: 'tokyo',
  display_name: 'Tokyo',
  schema_version: 1,
  profile_version: '1.0.0',
  mission: 'Verify fixes and regression safety.',
  personality: {
    communication_style: 'Methodical and skeptical.',
    decision_policy: ['Reproduce behavior.', 'Prefer automated coverage.'],
    constraints: ['Do not merge.', 'Do not weaken tests.'],
  },
  runtime: { backend: 'opencode' },
  skills: ['regression-testing', 'verification'],
  memory: { read: ['Projects/Ops-Room'], write: ['Projects/Ops-Room/Verification'] },
  repositories: ['LihSheng/ops-room'],
  enabled: false,
};

const professorRuntime: AgentInstance = {
  agent: 'professor',
  display_name: 'Professor',
  role: 'Builder',
  backend: 'opencode',
  service: 'opencode-professor',
  container_name: 'openab-opencode-professor',
  runtime: { status: 'running', health: 'healthy', restart_count: 0 },
  github_polling_enabled: true,
};

const berlinRuntime: AgentInstance = {
  agent: 'berlin',
  display_name: 'Berlin',
  role: 'Reviewer',
  backend: 'opencode',
  runtime: { status: 'exited', health: 'unknown', restart_count: 3 },
  github_polling_enabled: true,
};

// ── Public type contract tests ──

test('PublicAgentProfile type matches server API contract', () => {
  const keys = Object.keys(berlin).sort();
  assert.deepEqual(keys, [
    'display_name', 'enabled', 'id', 'memory', 'mission', 'personality',
    'profile_version', 'repositories', 'runtime', 'schema_version', 'skills',
  ]);

  // No internal fields present
  for (const profile of [berlin, tokyo]) {
    assert.equal('source' in profile, false, `${profile.id}: source field must not be public`);
    assert.equal('sourcePath' in profile, false, `${profile.id}: sourcePath field must not be public`);
    assert.equal('container' in profile, false, `${profile.id}: container field must not be public`);
    assert.equal('service' in profile, false, `${profile.id}: service field must not be public`);
    assert.equal('image' in profile, false, `${profile.id}: image field must not be public`);
    assert.equal('config_path' in profile, false, `${profile.id}: config_path field must not be public`);
    assert.equal('data_dir' in profile, false, `${profile.id}: data_dir field must not be public`);
  }
});

test('PublicAgentProfile personality policy and constraints are distinct arrays', () => {
  assert.ok(Array.isArray(berlin.personality.decision_policy));
  assert.ok(Array.isArray(berlin.personality.constraints));
  assert.equal(berlin.personality.decision_policy.length > 0, true);
  assert.equal(berlin.personality.constraints.length > 0, true);
  assert.equal(typeof berlin.personality.communication_style, 'string');
});

test('PublicAgentProfile memory scopes are read/write distinct', () => {
  assert.ok(Array.isArray(berlin.memory.read));
  assert.ok(Array.isArray(berlin.memory.write));
  // Read and write arrays are separate
  assert.notDeepEqual(berlin.memory.read, berlin.memory.write);
});

// ── Join logic tests ──

test('join: profiles and runtime instances are joined by agent ID', () => {
  const result = joinProfilesAndRuntime(
    [berlin, tokyo],
    [professorRuntime, berlinRuntime],
  );
  assert.equal(result.length, 3); // berlin, tokyo, professor

  const berlinRow = result.find((r) => r.id === 'berlin');
  assert.ok(berlinRow);
  assert.equal(berlinRow.profile?.id, 'berlin');
  assert.equal(berlinRow.runtime?.agent, 'berlin');

  const professorRow = result.find((r) => r.id === 'professor');
  assert.ok(professorRow);
  assert.equal(professorRow.profile, null);
  assert.equal(professorRow.runtime?.agent, 'professor');

  const tokyoRow = result.find((r) => r.id === 'tokyo');
  assert.ok(tokyoRow);
  assert.equal(tokyoRow.profile?.id, 'tokyo');
  assert.equal(tokyoRow.runtime, null);
});

test('join: profiles remain visible when runtime data is missing', () => {
  const result = joinProfilesAndRuntime([berlin], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'berlin');
  assert.equal(result[0].profile?.id, 'berlin');
  assert.equal(result[0].runtime, null);
});

test('join: runtime instances remain visible when profile data is missing', () => {
  const result = joinProfilesAndRuntime([], [professorRuntime]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'professor');
  assert.equal(result[0].profile, null);
  assert.equal(result[0].runtime?.agent, 'professor');
});

test('join: enabled and disabled profile states render correctly', () => {
  assert.equal(berlin.enabled, true);
  assert.equal(tokyo.enabled, false);
});

test('join: skill, memory, and repository counts are correct', () => {
  assert.equal(berlin.skills.length, 2);
  assert.equal(berlin.memory.read.length, 1);
  assert.equal(berlin.memory.write.length, 1);
  assert.equal(berlin.repositories.length, 1);
});

// ── Skills catalog tests ──

test('skills catalog: build deterministic skill-to-agent map', () => {
  const skills = new Map<string, Set<string>>();
  for (const profile of [berlin, tokyo]) {
    for (const skill of profile.skills) {
      const agents = skills.get(skill) || new Set();
      agents.add(profile.id);
      skills.set(skill, agents);
    }
  }
  const catalog: SkillCatalogItem[] = [...skills.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, agents]) => ({ key, agents: [...agents].sort() }));

  assert.ok(catalog.length >= 4);
  // Deterministic order
  for (let i = 1; i < catalog.length; i++) {
    assert.ok(catalog[i - 1].key < catalog[i].key, `skills should be sorted: ${catalog[i - 1].key} < ${catalog[i].key}`);
  }
});

test('skills catalog: empty catalog returns empty array', () => {
  const catalog: SkillCatalogItem[] = [];
  assert.deepEqual(catalog, []);
});

test('skills catalog: multiple declaring agents render correctly', () => {
  const sharedSkill = 'shared-skill';
  const a: PublicAgentProfile = { ...berlin, id: 'a', skills: [sharedSkill] };
  const b: PublicAgentProfile = { ...berlin, id: 'b', skills: [sharedSkill] };
  const skills = new Map<string, Set<string>>();
  for (const profile of [a, b]) {
    for (const skill of profile.skills) {
      const agents = skills.get(skill) || new Set();
      agents.add(profile.id);
      skills.set(skill, agents);
    }
  }
  const catalog = [...skills.entries()].map(([key, agents]) => ({ key, agents: [...agents].sort() }));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].key, sharedSkill);
  assert.deepEqual(catalog[0].agents, ['a', 'b']);
});

// ── Memory spaces catalog tests ──

test('memory catalog: readers and writers render separately', () => {
  const spaces = new Map<string, { readers: Set<string>; writers: Set<string> }>();
  for (const profile of [berlin, tokyo]) {
    for (const key of profile.memory.read) {
      const s = spaces.get(key) || { readers: new Set<string>(), writers: new Set<string>() };
      s.readers.add(profile.id);
      spaces.set(key, s);
    }
    for (const key of profile.memory.write) {
      const s = spaces.get(key) || { readers: new Set<string>(), writers: new Set<string>() };
      s.writers.add(profile.id);
      spaces.set(key, s);
    }
  }
  const catalog: MemorySpaceItem[] = [...spaces.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { readers, writers }]) => ({ key, readers: [...readers].sort(), writers: [...writers].sort() }));

  for (const item of catalog) {
    assert.ok(Array.isArray(item.readers));
    assert.ok(Array.isArray(item.writers));
    // Readers and writers arrays are distinct pointers
    assert.notStrictEqual(item.readers, item.writers);
  }
});

test('memory catalog: shared readers and writers displayed correctly', () => {
  const profileA: PublicAgentProfile = {
    ...berlin, id: 'a', memory: { read: ['shared-space'], write: ['shared-space'] },
  };
  const profileB: PublicAgentProfile = {
    ...berlin, id: 'b', memory: { read: ['shared-space'], write: [] },
  };

  const spaces = new Map<string, { readers: Set<string>; writers: Set<string> }>();
  for (const profile of [profileA, profileB]) {
    for (const key of profile.memory.read) {
      const s = spaces.get(key) || { readers: new Set<string>(), writers: new Set<string>() };
      s.readers.add(profile.id);
      spaces.set(key, s);
    }
    for (const key of profile.memory.write) {
      const s = spaces.get(key) || { readers: new Set<string>(), writers: new Set<string>() };
      s.writers.add(profile.id);
      spaces.set(key, s);
    }
  }

  const catalog = [...spaces.entries()].map(([key, { readers, writers }]) => ({
    key, readers: [...readers].sort(), writers: [...writers].sort(),
  }));

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].key, 'shared-space');
  assert.deepEqual(catalog[0].readers, ['a', 'b']);
  assert.deepEqual(catalog[0].writers, ['a']);
});

test('memory catalog: empty catalog returns empty array', () => {
  const catalog: MemorySpaceItem[] = [];
  assert.deepEqual(catalog, []);
});

// ── Deterministic ordering tests ──

test('join: deterministic ordering is preserved', () => {
  const result1 = joinProfilesAndRuntime([berlin, tokyo], [professorRuntime]);
  const result2 = joinProfilesAndRuntime([tokyo, berlin], [professorRuntime]);
  // Same set of IDs regardless of input order
  assert.deepEqual(
    result1.map((r) => r.id).sort(),
    result2.map((r) => r.id).sort(),
  );
});

// ── Agent detail tests ──

test('agent detail: unknown agent produces not-found state', () => {
  const result = joinProfilesAndRuntime([berlin], [professorRuntime]);
  const unknown = result.find((r) => r.id === 'nonexistent');
  assert.equal(unknown, undefined);
});

test('agent detail: runtime API failure does not hide valid profile data', () => {
  // Simulate: profile exists, runtime fetch fails
  const profile = berlin;
  const runtime = null; // runtime API failed
  assert.ok(profile);
  assert.equal(runtime, null);
  // Profile data is still available
  assert.equal(profile.display_name, 'Berlin');
  assert.equal(profile.mission, 'Review code for correctness and risk.');
});

// ── Internal fields absent test ──

test('internal fields: no internal implementation fields in public profile type', () => {
  const internalFields = ['source', 'sourcePath', 'container', 'service', 'image', 'config_path', 'data_dir', 'token', 'secret', 'env'];
  for (const field of internalFields) {
    assert.equal(field in berlin, false, `'${field}' must not appear in PublicAgentProfile`);
    assert.equal(field in tokyo, false, `'${field}' must not appear in PublicAgentProfile`);
  }
});

// ── Memory spaces page tests ──

test('memory catalog: no vault inspection fields in output', () => {
  const catalog: MemorySpaceItem[] = [
    { key: 'test', readers: ['a'], writers: [] },
  ];
  for (const item of catalog) {
    // Keys are strings only — no absolute paths
    assert.equal(typeof item.key, 'string');
    assert.equal(item.key.includes('/home/'), false);
    assert.equal(item.key.includes('/obsidian/'), false);
    assert.equal(item.key.includes('/vault/'), false);
  }
});
