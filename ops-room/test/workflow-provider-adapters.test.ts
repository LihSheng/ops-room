import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildWorkflowProviderEnv,
  createProfileWorkflowProviderAdapters,
  runWorkflowProviderProcess,
} from '../src/services/workflow-provider-adapters.js';

const WORKFLOW_ID = 'workflow:LihSheng-ops-room:1234567890abcdef12345678';

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

test('provider environment uses an explicit credential allowlist', () => {
  const env = buildWorkflowProviderEnv({
    PATH: '/bin',
    HOME: '/home/ops',
    OPENCODE_API_KEY: 'provider-secret',
    GH_TOKEN: 'github-secret',
    OPS_ROOM_OPERATOR_TOKEN: 'operator-secret',
    OPENAB_WEBHOOK_SECRET: 'webhook-secret',
    RANDOM_UNSAFE_VALUE: 'unsafe',
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/home/ops',
    OPENCODE_API_KEY: 'provider-secret',
  });
  assert.equal(Object.hasOwn(env, 'GH_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'OPS_ROOM_OPERATOR_TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'OPENAB_WEBHOOK_SECRET'), false);
});

test('profile adapters authorize agent and repository before invoking opencode', async () => {
  const calls: any[] = [];
  const adapters = createProfileWorkflowProviderAdapters({
    profileLookup: (id: string) => profile(id),
    envSource: { PATH: '/bin', OPENCODE_API_KEY: 'provider-secret', GH_TOKEN: 'must-not-leak' },
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
      processRunner: async () => { calls += 1; return ''; },
    });
    await assert.rejects(adapters.professor(adapterInput()), expected);
    assert.equal(calls, 0);
  }
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
