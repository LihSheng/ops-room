import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadBootstrapEnvironment,
  main,
  missingStartupVars,
  STARTUP_REQUIRED_VARS,
} from '../scripts/bootstrap.mjs';

test('bootstrap loads the selected env file without exposing repo .env', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'ops-room-bootstrap-'));
  const envPath = join(tempDir, '.env');
  const previousSecret = process.env.OPENAB_WEBHOOK_SECRET;
  const previousPort = process.env.OPENAB_WEBHOOK_PORT;

  try {
    delete process.env.OPENAB_WEBHOOK_SECRET;
    delete process.env.OPENAB_WEBHOOK_PORT;
    await writeFile(envPath, 'OPENAB_WEBHOOK_SECRET=test-secret\nOPENAB_WEBHOOK_PORT=17381\n');

    assert.equal(await loadBootstrapEnvironment(envPath), true);
    assert.equal(process.env.OPENAB_WEBHOOK_SECRET, 'test-secret');
    assert.equal(process.env.OPENAB_WEBHOOK_PORT, '17381');
  } finally {
    if (previousSecret === undefined) delete process.env.OPENAB_WEBHOOK_SECRET;
    else process.env.OPENAB_WEBHOOK_SECRET = previousSecret;
    if (previousPort === undefined) delete process.env.OPENAB_WEBHOOK_PORT;
    else process.env.OPENAB_WEBHOOK_PORT = previousPort;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('bootstrap startup contract matches the server-required secret', () => {
  assert.deepEqual(STARTUP_REQUIRED_VARS, ['OPENAB_WEBHOOK_SECRET']);
  assert.deepEqual(missingStartupVars({}), ['OPENAB_WEBHOOK_SECRET']);
  assert.deepEqual(missingStartupVars({ OPENAB_WEBHOOK_SECRET: 'test-secret' }), []);
  assert.deepEqual(missingStartupVars({ OPENAB_WEBHOOK_SECRET: '' }), ['OPENAB_WEBHOOK_SECRET']);
});

test('bootstrap tolerates a missing selected env file', async () => {
  const missingPath = join(tmpdir(), `ops-room-missing-${process.pid}-${Date.now()}`, '.env');
  assert.equal(await loadBootstrapEnvironment(missingPath), false);
});

test('bootstrap reports a missing webhook secret as startup-blocking', async () => {
  const messages = [];
  const output = {
    log: (message) => messages.push(String(message)),
    error: (message) => messages.push(String(message)),
  };
  const missingPath = join(tmpdir(), `ops-room-missing-${process.pid}-${Date.now()}`, '.env');

  const exitCode = await main({
    envPath: missingPath,
    env: {},
    createDirectories: false,
    output,
  });

  assert.equal(exitCode, 1);
  assert.match(messages.join('\n'), /Startup blocked: OPENAB_WEBHOOK_SECRET must be set\./);
});
