import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAgentProfiles } from '../src/services/agent-profile/loader.js';
import { evaluateSkillCompatibility } from '../src/services/skill-registry/compatibility.js';
import { loadSkillManifests } from '../src/services/skill-registry/loader.js';
import { resolveSkillAssignments, skillManifestId } from '../src/services/skill-registry/resolver.js';
import {
  ALLOWED_SKILL_PERMISSIONS,
  SkillManifestValidationError,
  validateSkillManifest,
} from '../src/services/skill-registry/schema.js';

const sourceSkills = fileURLToPath(new URL('../../config/skills/', import.meta.url));
const sourceProfiles = fileURLToPath(new URL('../../config/agent-profiles/', import.meta.url));

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    key: 'sample-skill',
    version: '1.0.0',
    description: 'A safe test skill.',
    supportedRuntimes: ['opencode'],
    requiredCommands: ['git'],
    requiredCredentials: ['github'],
    permissions: ['repository.read'],
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-skills-'));
  const dir = join(root, 'skills');
  await cp(sourceSkills, dir, { recursive: true });
  return { root, dir };
}

test('manifest schema accepts the documented safe shape', () => {
  assert.deepEqual(validateSkillManifest(manifest(), 'sample/1.0.0/manifest.json'), manifest());
  assert.ok(ALLOWED_SKILL_PERMISSIONS.has('repository.read'));
});

test('manifest schema rejects unsupported versions, invalid identity, empty fields, unknown values, duplicates, wildcards, paths, and secret fields', () => {
  const cases = [
    [manifest({ schemaVersion: 2 }), /schemaVersion must be 1/],
    [manifest({ key: 'Bad Key' }), /key must use lowercase/],
    [manifest({ version: 'latest' }), /valid semantic version/],
    [manifest({ description: '' }), /description is required/],
    [manifest({ description: '/etc/passwd' }), /absolute path/],
    [manifest({ supportedRuntimes: [] }), /supportedRuntimes must not be empty/],
    [manifest({ supportedRuntimes: ['docker'] }), /unsupported value docker/],
    [manifest({ requiredCommands: ['git', 'git'] }), /duplicate requiredCommands/],
    [manifest({ requiredCommands: ['git --version'] }), /invalid value/],
    [manifest({ requiredCredentials: ['github', 'github'] }), /duplicate requiredCredentials/],
    [manifest({ permissions: ['*'] }), /wildcard permission/],
    [manifest({ permissions: ['root.access'] }), /unsupported value/],
    [manifest({ prompt: 'do unsafe things' }), /secret-looking field prompt/],
    [manifest({ requiredCredentials: ['../secret'] }), /unsafe path value/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => validateSkillManifest(value, 'fixture/manifest.json'), pattern as RegExp);
  }
  assert.throws(() => validateSkillManifest([], 'fixture/manifest.json'), /must be a JSON object/);
});

test('loader discovers exactly the canonical manifests in deterministic order', async () => {
  const { root, dir } = await fixture();
  try {
    const first = await loadSkillManifests(dir);
    const second = await loadSkillManifests(dir);
    assert.equal(first.manifests.length, 12);
    assert.deepEqual(first.manifests.map((item) => `${item.key}@${item.version}`), second.manifests.map((item) => `${item.key}@${item.version}`));
    assert.deepEqual(first.manifests.map((item) => item.key), [...first.manifests.map((item) => item.key)].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader reports malformed JSON and field context without content leakage', async () => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, 'implementation', '1.0.0', 'manifest.json'), '{ token: super-secret');
    await assert.rejects(() => loadSkillManifests(dir), (error) => {
      assert.ok(error instanceof SkillManifestValidationError);
      assert.match(error.message, /implementation\/1\.0\.0\/manifest\.json: malformed JSON/);
      assert.equal(error.message.includes('super-secret'), false);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader rejects directory identity mismatch, duplicate key/version, and non-manifest files', async () => {
  const { root, dir } = await fixture();
  try {
    await mkdir(join(dir, 'copy', '1.0.0'), { recursive: true });
    const duplicate = JSON.stringify(manifest({ key: 'implementation', requiredCredentials: [], permissions: ['repository.read'] }));
    await writeFile(join(dir, 'copy', '1.0.0', 'manifest.json'), duplicate);
    await writeFile(join(dir, 'implementation', '1.0.0', 'README.md'), 'not approved');
    await assert.rejects(() => loadSkillManifests(dir), (error) => {
      assert.match(error.message, /directory key must match manifest key implementation/);
      assert.match(error.message, /duplicate key\/version pair/);
      assert.match(error.message, /only a regular manifest\.json is allowed/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loader rejects symlink entries and does not follow them outside the approved root', async (t) => {
  const { root, dir } = await fixture();
  try {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'manifest.json'), JSON.stringify(manifest()));
    try {
      await symlink(outside, join(dir, 'escape'), 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable on this platform');
        return;
      }
      throw error;
    }
    await assert.rejects(() => loadSkillManifests(dir), /symlink entries are not allowed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every canonical profile assignment resolves to the exact declared version', async () => {
  const [loadedSkills, loadedProfiles] = await Promise.all([
    loadSkillManifests(sourceSkills),
    loadAgentProfiles(sourceProfiles),
  ]);
  const manifests = new Map(loadedSkills.manifests.map((item) => [skillManifestId(item.key, item.version), item]));
  const resolved = resolveSkillAssignments({
    profiles: loadedProfiles.profiles,
    manifests,
    commandPresence: { git: true, gh: true },
    credentialResolver: () => 'present',
  });
  assert.equal(resolved.length, 12);
  assert.ok(resolved.every((item) => item.resolutionStatus === 'resolved'));
  assert.ok(resolved.every((item) => item.compatibility.status === 'compatible'));

  const wrongVersionProfiles = [{
    ...loadedProfiles.profiles[0],
    skills: [{ key: loadedProfiles.profiles[0].skills[0].key, version: '9.9.9' }],
  }];
  const unresolved = resolveSkillAssignments({ profiles: wrongVersionProfiles, manifests, commandPresence: {}, credentialResolver: () => 'unknown' });
  assert.equal(unresolved[0].resolutionStatus, 'unresolved');
  assert.deepEqual(unresolved[0].compatibility.reasons.map((reason) => reason.code), ['manifest_unresolved']);
});

test('compatibility evaluator reports deterministic runtime, command, and credential reasons', () => {
  const profile = {
    schemaVersion: 2, id: 'agent', displayName: 'Agent', profileVersion: '2.0.0', mission: 'Test.',
    personality: { communicationStyle: 'Test.', decisionPolicy: ['Test.'], constraints: ['Test.'] },
    runtime: { backend: 'gemini' }, skills: [{ key: 'sample-skill', version: '1.0.0' }],
    memory: { read: [], write: [] }, repositories: ['LihSheng/ops-room'], enabled: true,
  } as const;
  const result = evaluateSkillCompatibility({
    profile: profile as any,
    manifest: manifest({ requiredCommands: ['git', 'gh'], requiredCredentials: ['github', 'cloud'] }) as any,
    commandPresence: { git: false, gh: false },
    credentialResolver: (reference) => reference === 'github' ? 'missing' : 'unknown',
  });
  assert.equal(result.status, 'incompatible');
  assert.deepEqual(result.reasons.map((reason) => `${reason.code}:${reason.subject || ''}`), [
    'unsupported_runtime:gemini',
    'missing_command:gh',
    'missing_command:git',
    'missing_credential_reference:github',
    'credential_state_unknown:cloud',
  ]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('runtime data unavailable and credential unknown remain explicit unknown states', () => {
  const profile = {
    schemaVersion: 2, id: 'agent', displayName: 'Agent', profileVersion: '2.0.0', mission: 'Test.',
    personality: { communicationStyle: 'Test.', decisionPolicy: ['Test.'], constraints: ['Test.'] },
    runtime: { backend: 'opencode' }, skills: [{ key: 'sample-skill', version: '1.0.0' }],
    memory: { read: [], write: [] }, repositories: ['LihSheng/ops-room'], enabled: true,
  } as any;
  const result = evaluateSkillCompatibility({
    profile,
    manifest: manifest() as any,
    commandPresence: null,
    credentialResolver: () => 'unknown',
  });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.reasons.map((reason) => reason.code), ['runtime_data_unavailable', 'credential_state_unknown']);
});
