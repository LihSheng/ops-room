import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeAtomic } from '../src/services/review-task-store.js';

test('atomic task writes retry bounded transient replacement errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-atomic-write-'));
  const path = join(dir, 'task.json');
  const delays = [];
  let attempts = 0;

  await writeAtomic(path, { state: 'QUEUED' }, {
    renameFn: async (source, target) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('temporarily locked');
        error.code = 'EPERM';
        throw error;
      }
      const { rename } = await import('node:fs/promises');
      await rename(source, target);
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')), { state: 'QUEUED' });
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});

test('atomic task writes do not retry non-transient replacement errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-atomic-write-'));
  const path = join(dir, 'task.json');
  let attempts = 0;

  await assert.rejects(
    writeAtomic(path, { state: 'QUEUED' }, {
      renameFn: async () => {
        attempts += 1;
        const error = new Error('invalid target');
        error.code = 'EINVAL';
        throw error;
      },
      sleep: async () => { throw new Error('sleep should not be called'); },
    }),
    /invalid target/,
  );

  assert.equal(attempts, 1);
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});
