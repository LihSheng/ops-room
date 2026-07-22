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
  renderAskpassScript,
} = await import('../src/workflows/github-code.js');

// ── Environment snapshot/restore ─────────────────────────────────────

let envSnapshot = {};

test.beforeEach(() => {
  // Snapshot all process.env values that tests might mutate
  envSnapshot = {};
  for (const key of [
    'PATH', 'HOME', 'USER', 'USERPROFILE',
    'OPENAB_WEBHOOK_SECRET', 'OPS_ROOM_DASHBOARD_TOKEN', 'OPS_ROOM_OPERATOR_TOKEN',
    'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_KEY_PATH',
    'GH_TOKEN', 'GIT_ASKPASS_TOKEN',
    'OPENAI_API_KEY', 'OPENCODE_API_KEY', 'NVIDIA_API_KEY',
  ]) {
    if (key in process.env) envSnapshot[key] = process.env[key];
  }
});

test.afterEach(() => {
  // Restore all snapshotted env vars and delete any we added
  for (const key of Object.keys(envSnapshot)) {
    process.env[key] = envSnapshot[key];
  }
  for (const key of [
    'OPENAB_WEBHOOK_SECRET', 'OPS_ROOM_DASHBOARD_TOKEN', 'OPS_ROOM_OPERATOR_TOKEN',
    'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_KEY_PATH',
    'GH_TOKEN', 'GIT_ASKPASS_TOKEN',
    'OPENAI_API_KEY',
  ]) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  envSnapshot = {};
});

// ── maskToken ────────────────────────────────────────────────────────

test('maskToken redacts x-access-token URLs', () => {
  const input = 'https://x-access-token:secret123@github.com/owner/repo.git';
  const output = maskToken(input);
  assert.equal(output.includes('secret123'), false);
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

// ── renderAskpassScript ──────────────────────────────────────────────

test('renderAskpassScript contains x-access-token without username= prefix (Unix)', { skip: platform() === 'win32' }, () => {
  const script = renderAskpassScript();
  // Should contain the literal x-access-token for Username case
  assert.match(script, /x-access-token/);
  // Should NOT have username= or password= prefix
  assert.doesNotMatch(script, /^username=/m);
  assert.doesNotMatch(script, /^password=/m);
  // Should reference the token via env var, not inline it
  assert.match(script, /\$GIT_ASKPASS_TOKEN/);
});

test('renderAskpassScript contains x-access-token without username= prefix (Windows)', { skip: platform() !== 'win32' }, () => {
  const script = renderAskpassScript();
  assert.match(script, /x-access-token/);
  assert.doesNotMatch(script, /^username=/m);
  assert.doesNotMatch(script, /^password=/m);
  assert.match(script, /%GIT_ASKPASS_TOKEN%/);
  // Should use explicit findstr.exe path for PATH-independence
  assert.match(script, /%SystemRoot%\\System32\\findstr\.exe/);
});

// ── buildAgentEnv: env isolation ──────────────────────────────────────

test('buildAgentEnv excludes GH_TOKEN from coding-agent env', () => {
  process.env.GH_TOKEN = 'should-be-excluded';
  const env = buildAgentEnv();
  assert.equal(env.GH_TOKEN, undefined, 'GH_TOKEN must not leak to coding agents');
});

test('buildAgentEnv excludes all known harness secrets from coding-agent env', () => {
  process.env.OPENAB_WEBHOOK_SECRET = 'should-be-excludedws';
  process.env.OPS_ROOM_DASHBOARD_TOKEN = 'should-be-excludeddt';
  process.env.OPS_ROOM_OPERATOR_TOKEN = 'should-be-excludedot';
  process.env.GITHUB_APP_PRIVATE_KEY = 'should-be-excludedpk';
  process.env.GITHUB_APP_KEY_PATH = 'should-be-excludedkp';
  process.env.GH_TOKEN = 'should-be-excludedgh';
  process.env.GIT_ASKPASS_TOKEN = 'should-be-excludedat';
  process.env.OPENAI_API_KEY = 'should-be-included';
  process.env.PATH = '/usr/bin';

  const env = buildAgentEnv();

  assert.equal(env.OPENAB_WEBHOOK_SECRET, undefined);
  assert.equal(env.OPS_ROOM_DASHBOARD_TOKEN, undefined);
  assert.equal(env.OPS_ROOM_OPERATOR_TOKEN, undefined);
  assert.equal(env.GITHUB_APP_PRIVATE_KEY, undefined);
  assert.equal(env.GITHUB_APP_KEY_PATH, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GIT_ASKPASS_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, 'should-be-included');
  assert.equal(env.PATH, '/usr/bin');
});

test('buildAgentEnv includes required OS vars', () => {
  process.env.PATH = '/custom/path';
  const env = buildAgentEnv();
  assert.equal(env.PATH, '/custom/path');
});

// ── Askpass script path ──────────────────────────────────────────────

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

// ── Askpass protocol: Unix ───────────────────────────────────────────

test('askpass helper responds with x-access-token for username prompt (Unix)', { skip: platform() === 'win32' }, () => {
  const scriptPath = join(tmpdir(), 'openab-askpass-test-uname', 'askpass.sh');
  mkdirSync(dirname(scriptPath), { recursive: true });
  try {
    writeFileSync(scriptPath, renderAskpassScript(), { mode: 0o500 });

    // Username prompt → should return just "x-access-token"
    const usernameOut = execFileSync(scriptPath, ["Username for 'https://github.com':"], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    assert.equal(usernameOut.trim(), 'x-access-token');
    assert.doesNotMatch(usernameOut, /^username=/);

    // Password prompt → should return the token value
    const fakeToken = 'ghs_test_fake_token_12345';
    const passwordOut = execFileSync(scriptPath, ["Password for 'https://github.com':"], {
      encoding: 'utf-8',
      env: { GIT_ASKPASS_TOKEN: fakeToken },
      timeout: 5000,
    });
    assert.equal(passwordOut.trim(), fakeToken);
    assert.doesNotMatch(passwordOut, /^password=/);
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});

test('askpass helper exits non-zero for unknown prompts (Unix)', { skip: platform() === 'win32' }, () => {
  const scriptPath = join(tmpdir(), 'openab-askpass-test-unknown', 'askpass.sh');
  mkdirSync(dirname(scriptPath), { recursive: true });
  try {
    writeFileSync(scriptPath, renderAskpassScript(), { mode: 0o500 });

    assert.throws(() => {
      execFileSync(scriptPath, ["Hostname: github.com"], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    }, { status: 1 }, 'should exit with code 1 for unknown prompts');
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});

// ── Askpass protocol: Windows ────────────────────────────────────────

test('askpass helper responds with x-access-token for username prompt (Windows)', { skip: platform() !== 'win32' }, () => {
  const scriptPath = join(tmpdir(), 'openab-askpass-test-win', 'askpass.bat');
  mkdirSync(dirname(scriptPath), { recursive: true });
  try {
    writeFileSync(scriptPath, renderAskpassScript());

    const comspec = process.env.ComSpec || process.env.WINDIR + '\\System32\\cmd.exe';

    const usernameOut = execFileSync(comspec, ['/c', scriptPath, "Username for 'https://github.com':"], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    assert.equal(usernameOut.trim(), 'x-access-token');

    const fakeToken = 'ghs_win_test_token_67890';
    const passwordOut = execFileSync(comspec, ['/c', scriptPath, "Password for 'https://github.com':"], {
      encoding: 'utf-8',
      env: { ...process.env, GIT_ASKPASS_TOKEN: fakeToken },
      timeout: 5000,
    });
    assert.equal(passwordOut.trim(), fakeToken);
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});

test('askpass helper exits non-zero for unknown prompts (Windows)', { skip: platform() !== 'win32' }, () => {
  const scriptPath = join(tmpdir(), 'openab-askpass-test-win-unknown', 'askpass.bat');
  mkdirSync(dirname(scriptPath), { recursive: true });
  try {
    writeFileSync(scriptPath, renderAskpassScript());

    const comspec = process.env.ComSpec || process.env.WINDIR + '\\System32\\cmd.exe';
    assert.throws(() => {
      execFileSync(comspec, ['/c', scriptPath, "Hostname: github.com"], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    });
  } finally {
    rmSync(dirname(scriptPath), { recursive: true, force: true });
  }
});

// ── Token must not appear in script body ─────────────────────────────

test('askpass script does not contain token in file body', () => {
  const token = 'ghs_secret_token_value';
  const ctx = { issueNumber: 99996, agent: 'test-agent' };
  const scriptPath = buildAskpassScriptPath(ctx);

  try {
    writeFileSync(scriptPath, renderAskpassScript(),
      platform() !== 'win32' ? { mode: 0o500 } : {});

    const content = readFileSync(scriptPath, 'utf-8');
    assert.equal(content.includes(token), false,
      'token must not be written into the askpass script');
    assert.match(content, /GIT_ASKPASS_TOKEN/);
  } finally {
    cleanupAskpassHelper({ _askpassScriptPath: scriptPath });
  }
});

// ── Cleanup ──────────────────────────────────────────────────────────

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

test.after(() => {
  const testDirs = join(tmpdir(), 'openab-askpass');
  try { rmSync(testDirs, { recursive: true, force: true }); } catch {}
});
