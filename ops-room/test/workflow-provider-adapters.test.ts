import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  buildWorkflowProviderEnv,
  createProfileWorkflowProviderAdapters,
  readWorkflowWorkspaceRemote,
  runWorkflowProviderProcess,
  validateWorkflowProviderGitConfig,
  validateWorkflowProviderRemote,
} from '../src/services/workflow-provider-adapters.js';

const WORKFLOW_ID = 'workflow:LihSheng-ops-room:1234567890abcdef12345678';
const SAFE_REMOTE = 'https://github.com/LihSheng/ops-room.git';

function profile(id: string, overrides: any = {}) {
  return {
    id,
    enabled: true,
    runtime: { backend: 'opencode' },
    repositories: ['LihSheng/ops-room'],
    ...overrides,
  };
}

function adapterInput(ownerAgent = 'professor') {
  return {
    prompt: 'Return bounded JSON',
    cwd: '/internal/workspace/path',
    signal: new AbortController().signal,
    run: {
      workflow_id: WORKFLOW_ID,
      repository_id: 'LihSheng/ops-room',
    },
    child: {
      child_id: `${WORKFLOW_ID}:1:implementation`,
      owner_agent: ownerAgent,
      stage: 'implementation',
    },
  };
}

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    value: '',
    end(value: string) { this.value = value; },
  };
  child.kills = [];
  child.kill = (signal: string) => { child.kills.push(signal); return true; };
  return child;
}

function gitPreflightStub({
  fetchRemote = SAFE_REMOTE,
  pushRemote = SAFE_REMOTE,
  configKeys = ['core.repositoryformatversion', 'remote.origin.url', 'remote.origin.fetch'],
}: any = {}) {
  return async (_command: string, args: string[]) => {
    if (args[0] === 'remote' && args.includes('--push')) {
      return { stdout: `${pushRemote}\n`, stderr: '' };
    }
    if (args[0] === 'remote') {
      return { stdout: `${fetchRemote}\n`, stderr: '' };
    }
    if (args[0] === 'config') {
      return { stdout: `${configKeys.join('\0')}\0`, stderr: '' };
    }
    throw new Error('unexpected_git_command');
  };
}

test('provider environment uses an explicit credential allowlist and disables ambient Git auth', () => {
  const env = buildWorkflowProviderEnv({
    PATH: '/bin',
    HOME: '/home/ops',
    USERPROFILE: 'C:\\Users\\ops',
    OPENCODE_API_KEY: 'provider-secret',
    GH_TOKEN: 'github-secret',
    OPS_ROOM_OPERATOR_TOKEN: 'operator-secret',
    OPENAB_WEBHOOK_SECRET: 'webhook-secret',
    NODE_OPTIONS: '--require unsafe-module',
    NODE_PATH: '/unsafe/node/path',
    RANDOM_UNSAFE_VALUE: 'unsafe',
  });

  assert.equal(env.PATH, '/bin');
  assert.equal(env.OPENCODE_API_KEY, 'provider-secret');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(env.GH_PROMPT_DISABLED, '1');
  assert.equal(Object.hasOwn(env, 'HOME'), false);
  assert.equal(Object.hasOwn(env, 'USERPROFILE'), false);
  assert.equal(Object.hasOwn(env, 'GH_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'OPS_ROOM_OPERATOR_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'OPENAB_WEBHOOK_SECRET'), false);
  assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(env, 'NODE_PATH'), false);
});

test('provider remote preflight accepts only credential-free HTTPS origins', () => {
  assert.equal(validateWorkflowProviderRemote(SAFE_REMOTE), SAFE_REMOTE);

  for (const remote of [
    'https://x-access-token:secret@github.com/LihSheng/ops-room.git',
    'https://user:password@github.com/LihSheng/ops-room.git',
    'git@github.com:LihSheng/ops-room.git',
    'ssh://git@github.com/LihSheng/ops-room.git',
    'http://github.com/LihSheng/ops-room.git',
    'https://github.com/LihSheng/ops-room.git?token=secret',
    'https://github.com/LihSheng/ops-room.git#credential',
  ]) {
    assert.throws(() => validateWorkflowProviderRemote(remote), /workflow_provider_remote_credentials_unsafe/);
  }
});

test('workspace Git preflight validates fetch, push, and local configuration', async () => {
  const remote = await readWorkflowWorkspaceRemote({
    cwd: '/workspace',
    execFile: gitPreflightStub(),
  });
  assert.equal(remote, SAFE_REMOTE);
  assert.doesNotThrow(() => validateWorkflowProviderGitConfig([
    'core.repositoryformatversion',
    'remote.origin.url',
    'remote.origin.fetch',
  ]));
});

test('workspace Git preflight rejects credential config and unsafe push URLs', async () => {
  await assert.rejects(
    readWorkflowWorkspaceRemote({
      cwd: '/workspace',
      execFile: gitPreflightStub({
        configKeys: ['core.repositoryformatversion', 'http.https://github.com/.extraheader'],
      }),
    }),
    /workflow_provider_git_config_unsafe/,
  );

  await assert.rejects(
    readWorkflowWorkspaceRemote({
      cwd: '/workspace',
      execFile: gitPreflightStub({
        pushRemote: 'https://x-access-token:secret@github.com/LihSheng/ops-room.git',
      }),
    }),
    /workflow_provider_remote_credentials_unsafe/,
  );
});

test('profile adapters authorize agent, repository, and remote before invoking opencode', async () => {
  const calls: any[] = [];
  const adapters = createProfileWorkflowProviderAdapters({
    profileLookup: (id: string) => profile(id),
    remoteInspector: async () => SAFE_REMOTE,
    envSource: {
      PATH: '/bin',
      HOME: '/host/home/must-not-leak',
      USERPROFILE: 'C:\\host-home-must-not-leak',
      OPENCODE_API_KEY: 'provider-secret',
      GH_TOKEN: 'must-not-leak',
    },
    processRunner: async (input: any) => {
      calls.push(input);
      return '{"outcome":"completed","output_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';
    },
  });

  const result = await adapters.professor(adapterInput());

  assert.match(result, /"completed"/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'opencode');
  assert.deepEqual(calls[0].args, ['run', '-']);
  assert.equal(calls[0].cwd, '/internal/workspace/path');
  assert.equal(calls[0].stdin, 'Return bounded JSON');
  assert.equal(calls[0].env.OPENCODE_API_KEY, 'provider-secret');
  assert.equal(calls[0].env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(calls[0].env.GIT_TERMINAL_PROMPT, '0');
  assert.match(calls[0].env.HOME, /ops-room-provider-/);
  assert.match(calls[0].env.USERPROFILE, /ops-room-provider-/);
  assert.match(calls[0].env.GH_CONFIG_DIR, /ops-room-provider-/);
  assert.notEqual(calls[0].env.HOME, '/host/home/must-not-leak');
  assert.notEqual(calls[0].env.USERPROFILE, 'C:\\host-home-must-not-leak');
  assert.equal(Object.hasOwn(calls[0].env, 'GH_TOKEN'), false);
});

test('profile adapters fail closed for disabled, mismatched, unsupported, or unauthorized profiles', async () => {
  const cases = [
    [profile('professor', { enabled: false }), /workflow_provider_profile_disabled/],
    [profile('tokyo'), /workflow_provider_profile_missing/],
    [profile('professor', { runtime: { backend: 'gemini' } }), /workflow_provider_backend_unsupported/],
    [profile('professor', { repositories: ['LihSheng/LinkUp'] }), /workflow_provider_repository_not_allowed/],
  ];

  for (const [profileValue, expected] of cases as any[]) {
    let calls = 0;
    const adapters = createProfileWorkflowProviderAdapters({
      profileLookup: () => profileValue,
      remoteInspector: async () => SAFE_REMOTE,
      processRunner: async () => { calls += 1; return ''; },
    });
    await assert.rejects(adapters.professor(adapterInput()), expected);
    assert.equal(calls, 0);
  }
});

test('unsafe workspace remote blocks provider execution before subprocess creation', async () => {
  let calls = 0;
  const adapters = createProfileWorkflowProviderAdapters({
    profileLookup: (id: string) => profile(id),
    remoteInspector: async () => 'https://x-access-token:secret@github.com/LihSheng/ops-room.git',
    processRunner: async () => { calls += 1; return ''; },
  });

  await assert.rejects(
    adapters.professor(adapterInput()),
    /workflow_provider_remote_credentials_unsafe/,
  );
  assert.equal(calls, 0);
});

test('subprocess runner uses shell-free stdin execution and returns bounded stdout', async () => {
  const child = fakeChild();
  let spawnInput: any = null;
  const promise = runWorkflowProviderProcess({
    command: 'opencode',
    args: ['run', '-'],
    cwd: '/workspace',
    stdin: 'bounded prompt',
    env: { PATH: '/bin' },
    spawnFn: (command: string, args: string[], options: any) => {
      spawnInput = { command, args, options };
      queueMicrotask(() => {
        child.stdout.write('{"outcome":"needs_human","reason":"verification_failed"}');
        child.stdout.end();
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const output = await promise;
  assert.match(output, /verification_failed/);
  assert.equal(spawnInput.command, 'opencode');
  assert.deepEqual(spawnInput.args, ['run', '-']);
  assert.equal(spawnInput.options.shell, false);
  assert.deepEqual(spawnInput.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(child.stdin.value, 'bounded prompt');
});

test('subprocess stderr and failures are never included in the public error', async () => {
  const child = fakeChild();
  const promise = runWorkflowProviderProcess({
    command: 'opencode',
    args: ['run', '-'],
    cwd: '/workspace',
    stdin: 'prompt',
    env: {},
    spawnFn: () => {
      queueMicrotask(() => {
        child.stderr.write('token=super-secret-value');
        child.stderr.end();
        child.emit('close', 2, null);
      });
      return child;
    },
  });

  await assert.rejects(promise, (error: any) => {
    assert.equal(error.message, 'workflow_provider_process_failed');
    assert.equal(error.message.includes('super-secret-value'), false);
    return true;
  });
});

test('pre-cancelled subprocess execution never spawns a provider', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;

  await assert.rejects(
    runWorkflowProviderProcess({
      command: 'opencode',
      args: ['run', '-'],
      cwd: '/workspace',
      stdin: 'prompt',
      env: {},
      signal: controller.signal,
      spawnFn: () => { spawned = true; return fakeChild(); },
    }),
    /workflow_provider_cancelled/,
  );
  assert.equal(spawned, false);
});

test('subprocess cancellation waits for the child close event before settling', async () => {
  const controller = new AbortController();
  const child = fakeChild();
  const promise = runWorkflowProviderProcess({
    command: 'opencode',
    args: ['run', '-'],
    cwd: '/workspace',
    stdin: 'prompt',
    env: {},
    signal: controller.signal,
    spawnFn: () => child,
  });
  let settled = false;
  const observed = promise.then(
    () => new Error('unexpected provider success'),
    (error) => error,
  ).finally(() => { settled = true; });

  controller.abort();
  assert.deepEqual(child.kills, ['SIGTERM']);
  await delay(10);
  assert.equal(settled, false);

  child.emit('close', null, 'SIGTERM');
  const error = await observed;
  assert.equal(error.message, 'workflow_provider_cancelled');
  assert.equal(settled, true);
});
