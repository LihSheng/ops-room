import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';

import { createOrClaimTask } from '../src/services/review-task-store.js';

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
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}

function startServer({ root, port, operatorEnabled }) {
  return spawn(process.execPath, ['src/server/webhook.js'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      OPENAB_WEBHOOK_SECRET: 'operator-http-test',
      OPENAB_WEBHOOK_HOST: '127.0.0.1',
      OPENAB_WEBHOOK_PORT: String(port),
      OPS_ROOM_RELEASE_SHA: 'e'.repeat(40),
      OPS_ROOM_REQUIRED_COMMANDS: '',
      OPS_ROOM_ISSUE_POLLING_ENABLED: 'false',
      OPS_ROOM_OPERATOR_API_ENABLED: operatorEnabled ? 'true' : 'false',
      OPS_ROOM_OPERATOR_TOKEN: 'operator-test-token',
      OPS_ROOM_OPERATOR_ID: 'lihsheng',
      OPS_ROOM_OPERATOR_DISPLAY_NAME: 'Lih Sheng',
      OPS_ROOM_DATA_DIR: join(root, 'ops-room'),
      OPS_ROOM_REVIEW_TASKS_DIR: join(root, 'ops-room', 'review-tasks'),
      OPENAB_DATA_DIR: join(root, 'data'),
      OPENAB_WORKSPACES_DIR: join(root, 'workspaces'),
      OPENAB_AGENTS_CONFIG_DIR: join(root, 'config'),
    },
    stdio: 'pipe',
  });
}

async function stopServer(child) {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('operator cancellation requires authentication and replays an identical request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-http-'));
  const reviewTasksDir = join(root, 'ops-room', 'review-tasks');
  const task = (await createOrClaimTask({
    dir: reviewTasksDir,
    input: {
      repository: 'LihSheng/LinkUp', pr: 42, headSha: 'f'.repeat(40), agent: 'professor', mode: 'review',
    },
  })).task;
  const port = await availablePort();
  const child = startServer({ root, port, operatorEnabled: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(`${base}/health`);
    const payload = JSON.stringify({ reason: 'Duplicate task', idempotency_key: 'http-cancel-0001' });

    const unauthorized = await fetch(`${base}/api/operator/tasks/${encodeURIComponent(task.id)}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
    });
    assert.equal(unauthorized.status, 401);

    const request = () => fetch(`${base}/api/operator/tasks/${encodeURIComponent(task.id)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer operator-test-token' },
      body: payload,
    });
    const first = await request();
    assert.equal(first.status, 202, stderr);
    const firstBody = await first.json();
    assert.equal(firstBody.idempotent_replay, false);

    const second = await request();
    assert.equal(second.status, 202);
    const secondBody = await second.json();
    assert.equal(secondBody.idempotent_replay, true);
    assert.equal(secondBody.audit_event_id, firstBody.audit_event_id);

    const auditResponse = await fetch(`${base}/api/audit-events?operation=task.cancel`, {
      headers: { Authorization: 'Bearer operator-test-token' },
    });
    assert.equal(auditResponse.status, 200);
    const auditBody = await auditResponse.json();
    assert.equal(auditBody.events.length, 1);
    assert.equal(auditBody.events[0].actor.actor_id, 'lihsheng');
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('operator endpoints remain hidden when mutation API is disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-disabled-'));
  const port = await availablePort();
  const child = startServer({ root, port, operatorEnabled: false });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(`${base}/health`);
    const response = await fetch(`${base}/api/audit-events`, {
      headers: { Authorization: 'Bearer operator-test-token' },
    });
    assert.equal(response.status, 404);
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});
