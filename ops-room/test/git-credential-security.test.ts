import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

const {
  buildAskpassScriptPath,
  cleanupAskpassHelper,
  buildAgentEnv,
  maskToken,
} = await import('../src/workflows/github-code.js');

test('maskToken redacts x-access-token URLs', () => {
  const input = 'https://x-access-token:ghs_fake123456789@github.com/owner/repo.git';
  const output = maskToken(input);
  assert.equal(output.includes('ghs_fake123456789'), false);
  assert.match(output, /REDACTED/);
  assert.equal(output.includes('github.com/owner/repo.git'), true);
});

test('maskToken preserves clean URLs', () => {
  const input = 'https://github.com/owner/repo.git';
  const output = maskToken(input);
  assert.equal(output, 'https://github.com/owner/repo.git');
});

test('maskToken does not redact non-token URLs', () => {
  const input = 'https://api.github.com/repos/owner/repo';
  const output = maskToken(input);
  assert.equal(output, 'https://api.github.com/repos/owner/repo');
});

test('buildAgentEnv excludes secrets from coding-agent env', () => {
  process.env.OPENAB_WEBHOOK_SECRET = 'should-be-excluded';
  process.env.OPS_ROOM_DASHBOARD_TOKEN = 'should-be-excluded';
  process.env.OPS_ROOM_OPERATOR_TOKEN = 'should-be-excluded';
  process.env.GITHUB_APP_PRIVATE_KEY = 'should-be-excluded';
  process.env.GITHUB_APP_KEY_PATH = 'should-be-excluded';
  process.env.OPENAI_API_KEY = 'should-be-included';
  process.env.PATH = '/usr/bin';

  const env = buildAgentEnv();

  assert.equal(env.OPENAB_WEBHOOK_SECRET, undefined);
  assert.equal(env.OPS_ROOM_DASHBOARD_TOKEN, undefined);
  assert.equal(env.OPS_ROOM_OPERATOR_TOKEN, undefined);
  assert.equal(env.GITHUB_APP_PRIVATE_KEY, undefined);
  assert.equal(env.GITHUB_APP_KEY_PATH, undefined);
  assert.equal(env.OPENAI_API_KEY, 'should-be-included');
  assert.equal(env.PATH, '/usr/bin');
});

test('buildAgentEnv includes required OS vars', () => {
  process.env.PATH = '/custom/path';
  const env = buildAgentEnv();
  assert.equal(env.PATH, '/custom/path');
});

test('buildAskpassScriptPath creates unique paths per issue/agent', () => {
  const ctxA = { issueNumber: 1, agent: 'agent-a' };
  const ctxB = { issueNumber: 2, agent: 'agent-b' };

  const pathA = buildAskpassScriptPath(ctxA);
  const pathB = buildAskpassScriptPath(ctxB);

  assert.notEqual(pathA, pathB);
  assert.match(pathA, /issue-1-agent-a/);
  assert.match(pathB, /issue-2-agent-b/);
});

test('buildAskpassScriptPath uses tmpdir', () => {
  const ctx = { issueNumber: 42, agent: 'professor' };
  const scriptPath = buildAskpassScriptPath(ctx);
  assert.equal(scriptPath.startsWith(tmpdir()), true);
  const suffix = platform() === 'win32' ? 'askpass.bat' : 'askpass.sh';
  assert.equal(scriptPath.endsWith(suffix), true);
});

test('askpass script created with correct format (simulated, Unix)', { skip: platform() === 'win32' }, () => {
  const token = 'test-token-value';
  const ctx = { issueNumber: 99999, agent: 'test-agent' };
  const scriptPath = buildAskpassScriptPath(ctx);

  try {
    writeFileSync(scriptPath, `#!/bin/sh\necho "username=x-access-token"\necho "password=$GIT_ASKPASS_TOKEN"\n`, { mode: 0o500 });
    const env = {
      GIT_ASKPASS: scriptPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS_TOKEN: token,
    };

    const output = execFileSync(scriptPath, [], {
      encoding: 'utf-8',
      env,
      timeout: 5000,
    });

    assert.match(output, /username=x-access-token/);
    assert.match(output, /password=test-token-value/);
  } finally {
    cleanupAskpassHelper({ _askpassScriptPath: scriptPath });
  }
});

test('askpass script created with correct format (simulated, Windows)', { skip: platform() !== 'win32' }, () => {
  const token = 'test-token-value';
  const ctx = { issueNumber: 99998, agent: 'test-agent' };
  const scriptPath = buildAskpassScriptPath(ctx);

  try {
    writeFileSync(scriptPath, `@echo off\r\necho username=x-access-token\r\necho password=%GIT_ASKPASS_TOKEN%\r\n`);
    const env = {
      GIT_ASKPASS: scriptPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS_TOKEN: token,
    };

    const comspec = process.env.ComSpec || process.env.WINDIR + '\\System32\\cmd.exe';
    const output = execFileSync(comspec, ['/c', scriptPath], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 5000,
    });

    assert.match(output, /username=x-access-token/);
    assert.match(output, /password=test-token-value/);
  } finally {
    cleanupAskpassHelper({ _askpassScriptPath: scriptPath });
  }
});

test('cleanupAskpassHelper removes askpass directory', () => {
  const ctx = { issueNumber: 99997, agent: 'test-agent' };
  const scriptPath = buildAskpassScriptPath(ctx);

  writeFileSync(scriptPath, '#!/bin/sh\necho test\n', { mode: 0o500 });
  const scriptDir = dirname(scriptPath);
  assert.ok(statSync(scriptDir).isDirectory());

  cleanupAskpassHelper({ _askpassScriptPath: scriptPath });

  assert.equal(existsSync(scriptDir), false);
});

test('cleanupAskpassHelper is safe with missing path', () => {
  cleanupAskpassHelper({});
  cleanupAskpassHelper({ _askpassScriptPath: null });
  cleanupAskpassHelper({ _askpassScriptPath: '/nonexistent/path' });
});

test('askpass script does not contain token in file body (simulated)', () => {
  const token = 'ghs_secret_token_value';
  const ctx = { issueNumber: 99996, agent: 'test-agent' };
  const scriptPath = buildAskpassScriptPath(ctx);

  try {
    if (platform() === 'win32') {
      writeFileSync(scriptPath, `@echo off\r\necho username=x-access-token\r\necho password=%GIT_ASKPASS_TOKEN%\r\n`);
    } else {
      writeFileSync(scriptPath, `#!/bin/sh\necho "username=x-access-token"\necho "password=$GIT_ASKPASS_TOKEN"\n`, { mode: 0o500 });
    }

    const content = readFileSync(scriptPath, 'utf-8');
    assert.equal(content.includes(token), false,
      'token must not be written into the askpass script');
    assert.match(content, /GIT_ASKPASS_TOKEN/);
  } finally {
    cleanupAskpassHelper({ _askpassScriptPath: scriptPath });
  }
});

test.after(() => {
  const testDirs = join(tmpdir(), 'openab-askpass');
  try { rmSync(testDirs, { recursive: true, force: true }); } catch {}
});
