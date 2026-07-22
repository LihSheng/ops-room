import test from 'node:test';
import assert from 'node:assert/strict';

import { createProcessLifecycle, trackAcceptedOperation } from '../src/services/process-lifecycle.js';

test('process lifecycle drains tracked work and rejects new work', async () => {
  const lifecycle = createProcessLifecycle();
  let finish;
  const operation = lifecycle.run('review:one', () => new Promise((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(lifecycle.getStatus(), {
    state: 'running',
    in_flight: 1,
    operations: ['review:one'],
  });

  lifecycle.beginDrain();
  await assert.rejects(lifecycle.run('review:two', async () => {}), { code: 'OPS_ROOM_DRAINING' });
  finish();
  await operation;

  assert.deepEqual(await lifecycle.waitForIdle(100), {
    idle: true,
    timed_out: false,
    state: 'draining',
    in_flight: 0,
    operations: [],
  });
});

test('process lifecycle reports a bounded drain timeout', async () => {
  const lifecycle = createProcessLifecycle();
  lifecycle.track(new Promise(() => {}), 'stuck');
  lifecycle.beginDrain();

  const result = await lifecycle.waitForIdle(10);
  assert.equal(result.idle, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.in_flight, 1);
});

test('work accepted before drain still executes and remains visible while draining', async () => {
  const lifecycle = createProcessLifecycle();
  let finish;
  let executed = false;
  const task = trackAcceptedOperation(lifecycle, 'legacy-issue:coder#42', async () => {
    executed = true;
    await new Promise((resolve) => { finish = resolve; });
  });
  await new Promise((resolve) => setImmediate(resolve));

  lifecycle.beginDrain();
  assert.equal(executed, true);
  assert.deepEqual(lifecycle.getStatus().operations, ['legacy-issue:coder#42']);

  finish();
  await task;
  assert.equal((await lifecycle.waitForIdle(100)).idle, true);
});
