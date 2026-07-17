import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPreflight } from '../scripts/deploy/preflight-host.js';

async function prepareHost({ nodeVersion = '20.19.0', relativeDataPath = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-preflight-'));
  const installRoot = join(root, 'opt', 'ops-room');
  const scriptsDir = join(installRoot, 'scripts');
  const nodeBin = join(installRoot, 'bin', 'node');
  const envFile = join(root, 'etc', 'openab', 'ops-room.env');
  const serviceFile = join(root, 'etc', 'systemd', 'openab-ops-room.service');

  await mkdir(join(installRoot, 'releases'), { recursive: true });
  await mkdir(join(installRoot, 'locks'), { recursive: true });
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(join(installRoot, 'bin'), { recursive: true });
  await mkdir(join(root, 'etc', 'openab'), { recursive: true });
  await mkdir(join(root, 'etc', 'systemd'), { recursive: true });

  await writeFile(nodeBin, '#!/usr/bin/env bash\necho "$OPS_ROOM_TEST_NODE_VERSION"\n');
  await writeFile(join(scriptsDir, 'activate-release.sh'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(join(scriptsDir, 'rollback-release.sh'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(join(scriptsDir, 'verify-release.js'), 'process.exit(0);\n');
  await chmod(nodeBin, 0o755);
  await chmod(join(scriptsDir, 'activate-release.sh'), 0o755);
  await chmod(join(scriptsDir, 'rollback-release.sh'), 0o755);
  await chmod(join(scriptsDir, 'verify-release.js'), 0o644);

  const dataPath = relativeDataPath ? 'data/ops-room' : join(root, 'data', 'ops-room');
  await writeFile(envFile, [
    `OPS_ROOM_DATA_DIR=${dataPath}`,
    `OPS_ROOM_TASKS_DIR=${join(root, 'data', 'ops-room', 'tasks')}`,
    `OPS_ROOM_REVIEW_TASKS_DIR=${join(root, 'data', 'ops-room', 'review-tasks')}`,
    `OPS_ROOM_STATE_DIR=${join(root, 'data', 'ops-room', 'state')}`,
    `OPS_ROOM_LOGS_DIR=${join(root, 'data', 'ops-room', 'logs')}`,
    `OPENAB_WORKSPACES_DIR=${join(root, 'data', 'workspaces')}`,
    'OPENAB_WEBHOOK_SECRET=test-secret',
    '',
  ].join('\n'));
  await chmod(envFile, 0o640);

  await writeFile(serviceFile, [
    '[Service]',
    `WorkingDirectory=${join(installRoot, 'current', 'ops-room')}`,
    `EnvironmentFile=${envFile}`,
    `ExecStart=${nodeBin} src/server/webhook.js`,
    '',
  ].join('\n'));
  await chmod(serviceFile, 0o644);

  return { installRoot, scriptsDir, nodeBin, envFile, serviceFile, nodeVersion };
}

test('deployment preflight accepts a prepared immutable host layout', async () => {
  const host = await prepareHost();
  const result = await runPreflight({
    ...host,
    requireRootOwnership: false,
    runCommand: () => ({ status: 0, stdout: `${host.nodeVersion}\n`, stderr: '' }),
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.summary.failed, 0);
  assert.ok(result.checks.some((check) => check.name === 'current release link' && check.status === 'warn'));
});

test('deployment preflight rejects an unsupported Node version and relative persistent paths', async () => {
  const host = await prepareHost({ nodeVersion: '20.18.0', relativeDataPath: true });
  const result = await runPreflight({
    ...host,
    requireRootOwnership: false,
    runCommand: () => ({ status: 0, stdout: `${host.nodeVersion}\n`, stderr: '' }),
  });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.name === 'Node version' && check.status === 'fail'));
  assert.ok(result.checks.some((check) => check.name === 'persistent path configuration' && check.status === 'fail'));
});
