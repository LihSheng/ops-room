import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { reconcileAgentChatOnStartup } from '../src/services/agent-chat-recovery.js';

test('startup recovery removes abandoned chat locks before reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-agent-chat-recovery-'));
  const lockDir = join(root, '.locks');
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, 'agent-chat-abandoned.lock');
  await writeFile(lockPath, '{"pid":1234}\n', 'utf-8');

  let called = false;
  const result = await reconcileAgentChatOnStartup({
    dir: root,
    reconcile: async ({ dir }: any) => {
      called = true;
      await assert.rejects(readFile(lockPath, 'utf-8'), (error: any) => error.code === 'ENOENT');
      assert.equal(dir, root);
      return { scanned_sessions: 1, recovered_turns: 1, recovered: ['turn:1'] };
    },
  });

  assert.equal(called, true);
  assert.equal(result.recovered_turns, 1);
});

test('startup recovery requires an explicit durable chat directory', async () => {
  await assert.rejects(
    reconcileAgentChatOnStartup({ dir: '' }),
    /agent_chat_recovery_dir_required/,
  );
});
