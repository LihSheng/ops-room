import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const windows = process.platform === 'win32';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}

test('SIGTERM drains an idle server and exits cleanly', { skip: windows && 'POSIX signal contract' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-shutdown-'));
  const port = await availablePort();
  const revision = 'b'.repeat(40);
  const child = spawn(process.execPath, ['src/server/webhook.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      OPENAB_WEBHOOK_SECRET: 'shutdown-test',
      OPENAB_WEBHOOK_HOST: '127.0.0.1',
      OPENAB_WEBHOOK_PORT: String(port),
      OPS_ROOM_RELEASE_SHA: revision,
      OPS_ROOM_ISSUE_POLLING_ENABLED: 'false',
      OPS_ROOM_DATA_DIR: join(root, 'ops-room'),
      OPENAB_DATA_DIR: join(root, 'data'),
      OPENAB_WORKSPACES_DIR: join(root, 'workspaces'),
      OPENAB_AGENTS_CONFIG_DIR: join(root, 'config'),
    },
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.ready, true);
    assert.equal(health.revision, revision);
    child.kill('SIGTERM');
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exitCode, 0, stderr);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
