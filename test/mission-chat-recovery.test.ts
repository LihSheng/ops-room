import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { reconcileMissionChatOnStartup } from '../src/services/mission-chat-recovery.js';

test('startup recovery removes abandoned Mission chat locks before reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-mission-chat-recovery-'));
  const lockDir = join(root, '.locks');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, 'mission-chat-abandoned.lock');
  await writeFile(lockPath, '{"pid":1234}\n', 'utf-8');

  let called = false;
  const result = await reconcileMissionChatOnStartup({
    dir: root,
    reconcile: async ({ dir }: any) => {
      called = true;
      await assert.rejects(readFile(lockPath, 'utf-8'), (error: any) => error.code === 'ENOENT');
      assert.equal(dir, root);
      return { scanned_sessions: 1, recovered_turns: 1, recovered: ['mission-turn:1'] };
    },
  });

  assert.equal(called, true);
  assert.equal(result.recovered_turns, 1);
});

test('Mission chat startup recovery requires an explicit durable directory', async () => {
  await assert.rejects(
    reconcileMissionChatOnStartup({ dir: '' }),
    /mission_chat_recovery_dir_required/,
  );
});
