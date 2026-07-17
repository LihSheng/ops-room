import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadAgentProfiles } from '../src/services/agent-profile/loader.js';
import { initializeAgentProfileRegistry, listAgentProfiles, resetAgentProfileRegistryForTests } from '../src/services/agent-profile/registry.js';
import { AgentProfileValidationError } from '../src/services/agent-profile/schema.js';

const sourceProfiles = resolve(new URL('../../config/agent-profiles', import.meta.url).pathname);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-profiles-'));
  const dir = join(root, 'agent-profiles');
  await cp(sourceProfiles, dir, { recursive: true });
  return { root, dir };
}

test('loads the four canonical agent profiles and initializes the registry', async () => {
  const { root, dir } = await fixture();
  try {
    const loaded = await loadAgentProfiles(dir);
    assert.deepEqual(loaded.profiles.map((profile) => profile.id), ['berlin', 'gemini', 'professor', 'tokyo']);

    resetAgentProfileRegistryForTests();
    const status = await initializeAgentProfileRegistry(dir);
    assert.equal(status.status, 'ok');
    assert.equal(status.count, 4);
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
    await assert.rejects(() => loadAgentProfiles(dir), (error) => {
      assert.ok(error instanceof AgentProfileValidationError);
      assert.match(error.message, /professor\.json: malformed JSON/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects unsupported schema versions and duplicate skills', async () => {
  const { root, dir } = await fixture();
  try {
    const invalid = {
      schemaVersion: 2,
      id: 'professor',
      displayName: 'Professor',
      profileVersion: '1.0.0',
      mission: 'Build software.',
      personality: {
        communicationStyle: 'Structured.',
        decisionPolicy: ['Inspect code.'],
        constraints: ['Do not merge.'],
      },
      runtime: { backend: 'opencode' },
      skills: ['implementation', 'implementation'],
      memory: { read: [], write: [] },
      repositories: ['LihSheng/ops-room'],
      enabled: true,
    };
    await writeFile(join(dir, 'professor.json'), JSON.stringify(invalid));
    await assert.rejects(() => loadAgentProfiles(dir), (error) => {
      assert.ok(error instanceof AgentProfileValidationError);
      assert.match(error.message, /schemaVersion must be 1/);
      assert.match(error.message, /duplicate skills/);
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
    const profile = {
      schemaVersion: 1,
      id: 'professor',
      displayName: 'Professor',
      profileVersion: '1.0.0',
      mission: 'Build software.',
      personality: {
        communicationStyle: 'Structured.',
        decisionPolicy: ['Inspect code.'],
        constraints: ['Do not merge.'],
      },
      runtime: { backend: 'gemini' },
      skills: ['implementation'],
      memory: { read: [], write: [] },
      repositories: ['LihSheng/ops-room'],
      enabled: true,
    };
    await writeFile(join(dir, 'professor.json'), JSON.stringify(profile));
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
