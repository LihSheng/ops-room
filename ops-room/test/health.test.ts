import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleHealth } from '../src/routes/health.js';
import { createProcessLifecycle } from '../src/services/process-lifecycle.js';
import { commandExists } from '../src/workflows/github-code.js';

const healthyProfiles = () => ({
  status: 'ok', required: true, count: 4, initialized_at: '2026-07-17T00:00:00.000Z', schema_version: 2,
});
const healthySkills = (overrides = {}) => ({
  status: 'ready', required: true, manifest_count: 12, assignment_count: 12,
  compatible_assignments: 11, incompatible_assignments: 0, unknown_assignments: 1,
  initialized_at: '2026-07-18T00:00:00.000Z', schema_version: 1, ...overrides,
});

function options(overrides = {}) {
  return {
    commandExistsFn: async () => true,
    directoryCheckFn: async () => ({ status: 'ok', required: true }),
    lifecycle: createProcessLifecycle(),
    profileStatusFn: healthyProfiles,
    skillStatusFn: healthySkills,
    ...overrides,
  };
}

test('health reports bounded skill registry status without making compatibility unknown non-ready', async () => {
  const health = await handleHealth(options());

  assert.equal(health.status, 'ok');
  assert.equal(health.ready, true);
  assert.equal(health.profiles.count, 4);
  assert.equal(health.skill_registry.manifest_count, 12);
  assert.equal(health.skill_registry.unknown_assignments, 1);
  assert.equal('sources' in health.skill_registry, false);
  assert.equal('manifests' in health.skill_registry, false);
  assert.deepEqual(Object.keys(health.dependencies), [
    'task_store', 'review_task_store', 'state_store', 'log_store', 'audit_store', 'idempotency_store',
    'workspace_store', 'agent_profiles', 'skill_registry', 'release_identity', 'command_git', 'command_gh',
  ]);
});

test('health becomes non-ready while draining or when a critical store fails', async () => {
  const lifecycle = createProcessLifecycle();
  lifecycle.beginDrain();
  const health = await handleHealth(options({
    commandExistsFn: async () => false,
    directoryCheckFn: async (path) => ({ status: path.includes('tasks') ? 'error' : 'ok', required: true }),
    lifecycle,
  }));

  assert.equal(health.status, 'draining');
  assert.equal(health.ready, false);
  assert.equal(health.dependencies.task_store.status, 'error');
  assert.equal(health.dependencies.command_git.status, 'error');
});

test('structurally invalid profile or skill registry makes health non-ready', async () => {
  const profileHealth = await handleHealth(options({
    profileStatusFn: () => ({ status: 'error', required: true, count: 0, initialized_at: null, schema_version: 2 }),
  }));
  assert.equal(profileHealth.ready, false);
  assert.equal(profileHealth.dependencies.agent_profiles.status, 'error');

  const skillHealth = await handleHealth(options({
    skillStatusFn: () => healthySkills({ status: 'error', manifest_count: 0 }),
  }));
  assert.equal(skillHealth.ready, false);
  assert.equal(skillHealth.dependencies.skill_registry.status, 'error');
});

test('health checks configured critical commands beyond the default report set', async () => {
  const checked = [];
  const health = await handleHealth(options({
    commandExistsFn: async (command) => {
      checked.push(command);
      return command !== 'docker';
    },
    requiredCommands: ['git', 'gh', 'docker', 'codex'],
  }));

  assert.equal(health.ready, false);
  assert.equal(health.commands.docker, false);
  assert.equal(health.dependencies.command_docker.status, 'error');
  assert.ok(checked.includes('docker'));
});

test('configured command checks never execute shell syntax', { skip: process.platform === 'win32' && 'POSIX command lookup' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ops-room-command-check-'));
  const marker = join(temp, 'injected');
  try {
    assert.equal(await commandExists(`missing"; touch "${marker}"; #`), false);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('invalid packaged release identity makes health non-ready', async () => {
  const health = await handleHealth(options({
    releaseInfoFn: async () => { throw new Error('invalid manifest'); },
  }));
  assert.equal(health.ready, false);
  assert.equal(health.revision, 'unknown');
  assert.equal(health.dependencies.release_identity.status, 'error');
});
