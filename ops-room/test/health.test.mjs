import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleHealth } from '../src/routes/health.mjs';
import { createProcessLifecycle } from '../src/services/process-lifecycle.mjs';
import { commandExists } from '../src/workflows/github-code.mjs';

test('health reports release revision and critical dependency readiness', async () => {
  const health = await handleHealth({
    commandExistsFn: async () => true,
    directoryCheckFn: async () => ({ status: 'ok', required: true }),
    lifecycle: createProcessLifecycle(),
  });

  assert.equal(health.status, 'ok');
  assert.equal(health.ready, true);
  assert.ok(health.version);
  assert.ok(health.revision);
  assert.deepEqual(Object.keys(health.dependencies), [
    'task_store', 'review_task_store', 'state_store', 'log_store', 'workspace_store',
    'release_identity', 'command_git', 'command_gh',
  ]);
});

test('health becomes non-ready while draining or when a critical store fails', async () => {
  const lifecycle = createProcessLifecycle();
  lifecycle.beginDrain();
  const health = await handleHealth({
    commandExistsFn: async () => false,
    directoryCheckFn: async (path) => ({
      status: path.includes('tasks') ? 'error' : 'ok',
      required: true,
    }),
    lifecycle,
  });

  assert.equal(health.status, 'draining');
  assert.equal(health.ready, false);
  assert.equal(health.lifecycle.state, 'draining');
  assert.equal(health.dependencies.task_store.status, 'error');
  assert.equal(health.dependencies.command_git.status, 'error');
});

test('health checks configured critical commands beyond the default report set', async () => {
  const checked = [];
  const health = await handleHealth({
    commandExistsFn: async (command) => {
      checked.push(command);
      return command !== 'docker';
    },
    directoryCheckFn: async () => ({ status: 'ok', required: true }),
    lifecycle: createProcessLifecycle(),
    requiredCommands: ['git', 'gh', 'docker', 'codex'],
  });

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
  const health = await handleHealth({
    commandExistsFn: async () => true,
    directoryCheckFn: async () => ({ status: 'ok', required: true }),
    lifecycle: createProcessLifecycle(),
    releaseInfoFn: async () => { throw new Error('invalid manifest'); },
  });

  assert.equal(health.ready, false);
  assert.equal(health.revision, 'unknown');
  assert.equal(health.dependencies.release_identity.status, 'error');
});
