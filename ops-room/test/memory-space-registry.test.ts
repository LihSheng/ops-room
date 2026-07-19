import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAgentProfiles } from '../src/services/agent-profile/loader.js';
import { loadMemorySpaceManifests } from '../src/services/memory-space-registry/loader.js';
import { resolveMemoryAssignments } from '../src/services/memory-space-registry/resolver.js';
import {
  MemorySpaceValidationError,
  validateMemorySpaceManifest,
} from '../src/services/memory-space-registry/schema.js';

const sourceMemorySpaces = fileURLToPath(new URL('../../config/memory-spaces/', import.meta.url));
const sourceProfiles = fileURLToPath(new URL('../../config/agent-profiles/', import.meta.url));

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    key: 'sample-space',
    version: '1.0.0',
    displayName: 'Sample Space',
    description: 'A curated test publication space.',
    kind: 'project',
    publicationPath: '20_Projects/Sample',
    writePolicy: 'review-required',
    provenance: {
      requiredFields: ['agent_id', 'task_id', 'source_refs', 'created_at'],
      reviewRequired: true,
    },
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'agent',
    displayName: 'Agent',
    profileVersion: '2.1.0',
    mission: 'Test.',
    personality: { communicationStyle: 'Test.', decisionPolicy: ['Test.'], constraints: ['Test.'] },
    runtime: { backend: 'opencode' },
    skills: [{ key: 'implementation', version: '1.0.0' }],
    memory: { read: ['sample-space'], write: ['sample-space'] },
    repositories: ['LihSheng/ops-room'],
    enabled: true,
    ...overrides,
  } as any;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-memory-spaces-'));
  const dir = join(root, 'memory-spaces');
  await cp(sourceMemorySpaces, dir, { recursive: true });
  return { root, dir };
}

test('manifest schema accepts curated relative paths and governance metadata', () => {
  assert.deepEqual(validateMemorySpaceManifest(manifest(), 'sample-space/1.0.0/manifest.json'), manifest());
});

test('manifest schema rejects unsafe roots, traversal, wildcard, ownership, write policy, provenance, and secret fields', () => {
  const cases = [
    [manifest({ schemaVersion: 2 }), /schemaVersion must be 1/],
    [manifest({ key: 'Bad Key' }), /key must use lowercase/],
    [manifest({ version: 'latest' }), /valid semantic version/],
    [manifest({ publicationPath: '/etc/secret' }), /curated relative path/],
    [manifest({ publicationPath: '20_Projects/../Secrets' }), /curated relative path/],
    [manifest({ publicationPath: '20_Projects/*' }), /curated relative path/],
    [manifest({ kind: 'shared', publicationPath: '20_Projects/Sample' }), /rooted under 90_Shared/],
    [manifest({ kind: 'private-agent' }), /require ownerAgent/],
    [manifest({ ownerAgent: 'agent' }), /only allowed for private-agent/],
    [manifest({ kind: 'archive', publicationPath: '99_Archive/Sample', writePolicy: 'review-required' }), /archive spaces must be read-only/],
    [manifest({ provenance: { requiredFields: ['secret_value'], reviewRequired: true } }), /unsupported provenance field/],
    [manifest({ provenance: { requiredFields: ['agent_id'], reviewRequired: false } }), /must require provenance review/],
    [manifest({ token: 'never-allowed' }), /secret-looking field token/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => validateMemorySpaceManifest(value, 'fixture/manifest.json'), pattern as RegExp);
  }
});

test('loader discovers the exact canonical registry in deterministic order', async () => {
  const loaded = await loadMemorySpaceManifests(sourceMemorySpaces);
  assert.equal(loaded.manifests.length, 12);
  assert.deepEqual(loaded.manifests.map((item) => item.key), [...loaded.manifests.map((item) => item.key)].sort());
  assert.equal(loaded.manifests.filter((item) => item.kind === 'private-agent').length, 4);
  assert.equal(loaded.manifests.filter((item) => item.kind === 'archive').length, 1);
});

test('loader rejects malformed JSON, unexpected files, symlinks, and ungoverned overlaps', async (t) => {
  const { root, dir } = await fixture();
  try {
    await writeFile(join(dir, 'ops-room-project', '1.0.0', 'README.md'), 'not approved');
    await mkdir(join(dir, 'unsafe-child', '1.0.0'), { recursive: true });
    await writeFile(join(dir, 'unsafe-child', '1.0.0', 'manifest.json'), JSON.stringify(manifest({
      key: 'unsafe-child',
      publicationPath: '20_Projects/Ops-Room/Unsafe',
    })));
    await assert.rejects(() => loadMemorySpaceManifests(dir), (error) => {
      assert.ok(error instanceof MemorySpaceValidationError);
      assert.match(error.message, /only a regular manifest\.json is allowed/);
      assert.match(error.message, /overlapping publicationPath must declare parentKey ops-room-project/);
      return true;
    });

    await rm(join(dir, 'unsafe-child'), { recursive: true, force: true });
    await rm(join(dir, 'ops-room-project', '1.0.0', 'README.md'));
    const outside = join(root, 'outside');
    await mkdir(outside);
    try {
      await symlink(outside, join(dir, 'escape'), 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable on this platform');
        return;
      }
      throw error;
    }
    await assert.rejects(() => loadMemorySpaceManifests(dir), /symlink entries are not allowed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('canonical profile assignments resolve to approved spaces with owner and write governance', async () => {
  const [loadedMemory, loadedProfiles] = await Promise.all([
    loadMemorySpaceManifests(sourceMemorySpaces),
    loadAgentProfiles(sourceProfiles),
  ]);
  const manifests = new Map(loadedMemory.manifests.map((item) => [item.key, item]));
  const resolved = resolveMemoryAssignments({ profiles: loadedProfiles.profiles, manifests });
  assert.equal(resolved.length, 27);
  assert.equal(resolved.filter((item) => item.access === 'write').length, 8);
  assert.ok(resolved.every((item) => item.manifest.publicationPath.split('/')[0] !== '..'));
  assert.ok(resolved.filter((item) => item.manifest.kind === 'private-agent').every((item) => item.manifest.ownerAgent === item.agentId));
  assert.ok(resolved.filter((item) => item.access === 'write').every((item) => item.manifest.writePolicy === 'review-required'));
});

test('assignment resolution rejects missing spaces, foreign private access, read-only writes, and write-without-read', () => {
  const manifests = new Map<string, any>([
    ['sample-space', manifest()],
    ['read-only', manifest({ key: 'read-only', writePolicy: 'read-only', provenance: { requiredFields: [], reviewRequired: false } })],
    ['owner-private', manifest({
      key: 'owner-private',
      kind: 'private-agent',
      publicationPath: '90_Agents/owner',
      ownerAgent: 'owner',
    })],
  ]);
  assert.throws(() => resolveMemoryAssignments({
    profiles: [profile({ memory: { read: ['missing'], write: [] } })],
    manifests,
  }), /does not resolve/);
  assert.throws(() => resolveMemoryAssignments({
    profiles: [profile({ memory: { read: ['owner-private'], write: [] } })],
    manifests,
  }), /cannot access private memory space/);
  assert.throws(() => resolveMemoryAssignments({
    profiles: [profile({ memory: { read: ['read-only'], write: ['read-only'] } })],
    manifests,
  }), /cannot write to read-only/);
  assert.throws(() => resolveMemoryAssignments({
    profiles: [profile({ memory: { read: [], write: ['sample-space'] } })],
    manifests,
  }), /must also be declared in memory.read/);
});
