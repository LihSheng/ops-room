import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAgentProfiles } from '../src/services/agent-profile/loader.js';
import { initializeAgentProfileRegistry, listAgentProfiles, resetAgentProfileRegistryForTests } from '../src/services/agent-profile/registry.js';
import { AgentProfileValidationError } from '../src/services/agent-profile/schema.js';

const sourceProfiles = fileURLToPath(new URL('../config/agent-profiles/', import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-profiles-'));
  const dir = join(root, 'agent-profiles');
  await cp(sourceProfiles, dir, { recursive: true });
  return { root, dir };
}

function minimalProfile(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'professor',
    displayName: 'Professor',
    profileVersion: '2.1.0',
    mission: 'Build software.',
    personality: {
      communicationStyle: 'Structured.',
      decisionPolicy: ['Inspect code.'],
      constraints: ['Do not merge.'],
    },
    runtime: { backend: 'opencode' },
    skills: [{ key: 'implementation', version: '1.0.0' }],
    memory: { read: [], write: [] },
    repositories: ['LihSheng/ops-room'],
    enabled: true,
    ...overrides,
  };
}

test('loads canonical schema-v2 profiles with exact skill versions and logical memory keys', async () => {
  const { root, dir } = await fixture();
  try {
    const loaded = await loadAgentProfiles(dir);
    assert.deepEqual(loaded.profiles.map((profile) => profile.id), ['berlin', 'gemini', 'professor', 'tokyo']);
    for (const profile of loaded.profiles) {
      assert.equal(profile.schemaVersion, 2);
      assert.equal(profile.profileVersion, '2.1.0');
      assert.ok(profile.skills.every((skill) => skill.key && skill.version === '1.0.0'));
      assert.ok([...profile.memory.read, ...profile.memory.write].every((key) => /^[a-z][a-z0-9-]*$/.test(key)));
    }

    resetAgentProfileRegistryForTests();
    const status = await initializeAgentProfileRegistry(dir);
    assert.equal(status.status, 'ok');
    assert.equal(status.schema_version, 2);
    assert.equal(listAgentProfiles().length, 4);
  } finally {
    resetAgentProfileRegistryForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed JSON', async () => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, 'professor.json'), '{ invalid json');
    await assert.rejects(() => loadAgentProfiles(dir), /professor\.json: malformed JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects old schema, unversioned skills, duplicate keys, invalid semantic versions, and path-shaped memory values', async () => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, 'professor.json'), JSON.stringify(minimalProfile({
      schemaVersion: 1,
      profileVersion: '2',
      skills: [
        { key: 'implementation', version: '1.0.0' },
        { key: 'implementation', version: 'latest' },
      ],
      memory: { read: ['20_Projects/Ops-Room'], write: [] },
    })));
    await assert.rejects(() => loadAgentProfiles(dir), (error) => {
      assert.ok(error instanceof AgentProfileValidationError);
      assert.match(error.message, /schemaVersion must be 2/);
      assert.match(error.message, /profileVersion must be semantic version format/);
      assert.match(error.message, /duplicate skill assignments/);
      assert.match(error.message, /version must be a valid semantic version/);
      assert.match(error.message, /normalized logical memory-space keys/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects missing profiles and backend mismatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-profiles-invalid-'));
  const dir = join(root, 'agent-profiles');
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, 'professor.json'), JSON.stringify(minimalProfile({ runtime: { backend: 'gemini' } })));
    await assert.rejects(() => loadAgentProfiles(dir), (error) => {
      assert.ok(error instanceof AgentProfileValidationError);
      assert.match(error.message, /runtime backend must match agent definition/);
      assert.match(error.message, /berlin: missing required profile/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
