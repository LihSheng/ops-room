import test from 'node:test';
import assert from 'node:assert/strict';

import { handleHealth } from '../src/routes/health.mjs';
import { createProcessLifecycle } from '../src/services/process-lifecycle.mjs';

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
    'task_store', 'state_store', 'log_store', 'workspace_store',
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
});
