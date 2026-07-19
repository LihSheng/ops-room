import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleOperatorAgentStop } from '../src/routes/operator-agents.js';
import {
  readAgentLifecycleState,
  recoverInterruptedAgentLifecycleStates,
  updateAgentLifecycleState,
} from '../src/services/agent-lifecycle-store.js';
import { listAuditEvents } from '../src/services/audit-log.js';
import { createOrClaimTask, readTask, transitionTask } from '../src/services/review-task-store.js';
import { dispatchEligibleTasks } from '../src/services/review-reconciler.js';
import { createDockerAgentLifecycleController } from '../src/services/runtime-lifecycle/docker-lifecycle-controller.js';

const actor = {
  actor_type: 'human_operator',
  actor_id: 'lihsheng',
  actor_display_name: 'Lih Sheng',
  auth_method: 'operator_token',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-agent-lifecycle-'));
  return {
    reviewTasksDir: join(root, 'review-tasks'),
    lifecycleDir: join(root, 'lifecycle'),
    auditDir: join(root, 'audit'),
    idempotencyDir: join(root, 'idempotency'),
  };
}

function fakeTarget(stop) {
  return {
    runtime_adapter_id: 'fake-runtime',
    prepared: {
      agent_id: 'gemini',
      adapter_id: 'fake-runtime',
      target: { kind: 'docker-container', name: 'openab-gemini' },
    },
    controller: {
      id: 'fake-lifecycle',
      supports: () => true,
      stop,
    },
  };
}

function runningSnapshot() {
  return {
    instances: [{
      agent: 'gemini',
      adapter_id: 'fake-runtime',
      runtime: { status: 'running', state: 'running', health: 'none' },
    }],
    adapters: [],
  };
}

function stopRequest(dirs, overrides = {}) {
  return {
    agentId: 'gemini',
    body: {
      reason: 'Stop the approved non-critical test agent',
      idempotency_key: 'agent-stop-gemini-0001',
      confirm_agent_id: 'gemini',
    },
    actor,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: runningSnapshot,
    drainTimeoutMs: 0,
    ...dirs,
    ...overrides,
  };
}

test('guarded stop is audited, durable, confirmed, and idempotent', async () => {
  const dirs = await fixture();
  let stopCalls = 0;
  const request = stopRequest(dirs, {
    prepareTarget: () => fakeTarget(async () => {
      stopCalls += 1;
      return { controller_id: 'fake-lifecycle', action: 'stop' };
    }),
  });

  const first = await handleOperatorAgentStop(request);
  const replay = await handleOperatorAgentStop(request);

  assert.equal(first.status, 202);
  assert.equal(first.body.operation, 'agent.stop');
  assert.equal(first.body.agent.desired_state, 'stopped');
  assert.equal(first.body.agent.lifecycle_state, 'stopped');
  assert.equal(first.body.command_executed, true);
  assert.equal(first.body.idempotent_replay, false);
  assert.equal(replay.status, 202);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.body.audit_event_id, first.body.audit_event_id);
  assert.equal(stopCalls, 1);

  const state = await readAgentLifecycleState({ dir: dirs.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'stopped');
  assert.equal(state.phase, 'stopped');
  assert.equal(state.last_operation.outcome, 'accepted');

  const events = await listAuditEvents({ dir: dirs.auditDir, operation: 'agent.stop' });
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'accepted');
  assert.equal(events[0].resulting_state, 'stopped');
  assert.equal(events[0].metadata.command_executed, true);
});

test('different idempotency keys serialize without a second runtime stop', async () => {
  const dirs = await fixture();
  let stopCalls = 0;
  const prepareTarget = () => fakeTarget(async () => {
    stopCalls += 1;
    return { controller_id: 'fake-lifecycle', action: 'stop' };
  });

  const [first, second] = await Promise.all([
    handleOperatorAgentStop(stopRequest(dirs, { prepareTarget })),
    handleOperatorAgentStop(stopRequest(dirs, {
      prepareTarget,
      body: {
        reason: 'Second confirmed stop request',
        idempotency_key: 'agent-stop-gemini-0002',
        confirm_agent_id: 'gemini',
      },
    })),
  ]);

  assert.deepEqual([first.status, second.status], [202, 202]);
  assert.equal(stopCalls, 1);
  assert.deepEqual(
    [first.body.command_executed, second.body.command_executed].sort(),
    [false, true],
  );

  const events = await listAuditEvents({ dir: dirs.auditDir, operation: 'agent.stop' });
  assert.equal(events.length, 2);
  assert.equal(events.filter((event) => event.metadata.command_executed).length, 1);
  assert.equal(events.filter((event) => event.metadata.already_desired_state).length, 1);
});

test('active tasks prevent stop and restore dispatchable desired state', async () => {
  const dirs = await fixture();
  const task = (await createOrClaimTask({
    dir: dirs.reviewTasksDir,
    input: {
      repository: 'LihSheng/ops-room',
      pr: 88,
      headSha: 'a'.repeat(40),
      agent: 'gemini',
      mode: 'review',
    },
  })).task;
  await transitionTask({ dir: dirs.reviewTasksDir, id: task.id, to: 'CLAIMED', reason: 'test' });
  await transitionTask({ dir: dirs.reviewTasksDir, id: task.id, to: 'RUNNING', reason: 'test' });

  let stopCalls = 0;
  const result = await handleOperatorAgentStop(stopRequest(dirs, {
    prepareTarget: () => fakeTarget(async () => { stopCalls += 1; }),
  }));

  assert.equal(result.status, 409);
  assert.equal(result.body.error_code, 'agent_not_drained');
  assert.equal(stopCalls, 0);
  const state = await readAgentLifecycleState({ dir: dirs.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'unmanaged');
  assert.equal(state.phase, 'failed');
  assert.equal(state.last_error, 'agent_not_drained');

  const events = await listAuditEvents({ dir: dirs.auditDir, operation: 'agent.stop' });
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'rejected');
  assert.equal(events[0].metadata.remaining_task_count, 1);
});

test('corrupt lifecycle state fails closed without executing the runtime command', async () => {
  const dirs = await fixture();
  await mkdir(dirs.lifecycleDir, { recursive: true });
  await writeFile(join(dirs.lifecycleDir, 'agent-gemini.json'), '{not-json', 'utf-8');
  let stopCalls = 0;

  const result = await handleOperatorAgentStop(stopRequest(dirs, {
    prepareTarget: () => fakeTarget(async () => { stopCalls += 1; }),
  }));

  assert.equal(result.status, 409);
  assert.equal(result.body.error_code, 'lifecycle_state_unavailable');
  assert.equal(stopCalls, 0);
  const state = await readAgentLifecycleState({ dir: dirs.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.phase, 'failed');
  assert.equal(state.last_error, 'lifecycle_state_unavailable');
});

test('dispatch path fails closed when lifecycle policy blocks an agent', async () => {
  const dirs = await fixture();
  const task = (await createOrClaimTask({
    dir: dirs.reviewTasksDir,
    input: {
      repository: 'LihSheng/ops-room',
      pr: 89,
      headSha: 'b'.repeat(40),
      agent: 'gemini',
      mode: 'review',
    },
  })).task;

  const result = await dispatchEligibleTasks({
    dir: dirs.reviewTasksDir,
    instanceId: 'test-instance',
    canDispatchAgent: async (agentId) => agentId !== 'gemini',
  });

  assert.equal(result.dispatched, 0);
  assert.equal((await readTask({ dir: dirs.reviewTasksDir, id: task.id })).state, 'QUEUED');
});

test('startup recovery marks interrupted lifecycle operations failed', async () => {
  const dirs = await fixture();
  await updateAgentLifecycleState({
    dir: dirs.lifecycleDir,
    agentId: 'gemini',
    patch: {
      desired_state: 'stopped',
      previous_desired_state: 'unmanaged',
      phase: 'draining',
      last_operation: {
        operation: 'agent.stop',
        actor_id: 'lihsheng',
        reason: 'test recovery',
        requested_at: '2026-07-19T00:00:00.000Z',
        outcome: 'in_progress',
      },
    },
  });

  const recovered = await recoverInterruptedAgentLifecycleStates({ dir: dirs.lifecycleDir });
  const state = await readAgentLifecycleState({ dir: dirs.lifecycleDir, agentId: 'gemini' });

  assert.deepEqual(recovered, ['gemini']);
  assert.equal(state.phase, 'failed');
  assert.equal(state.desired_state, 'unmanaged');
  assert.equal(state.last_error, 'interrupted_lifecycle_operation');
});

test('docker lifecycle controller uses fixed argv and exposes no force operations', async () => {
  const calls = [];
  const controller = createDockerAgentLifecycleController({
    runCommand: async (command, args, options) => { calls.push({ command, args, options }); },
  });
  const prepared = {
    agent_id: 'gemini',
    target: { kind: 'docker-container', name: 'openab-gemini' },
  };

  const result = await controller.stop(prepared, { timeoutSeconds: 15 });

  assert.equal(result.controller_id, 'docker-container-lifecycle');
  assert.deepEqual(calls[0].args, ['stop', '--time', '15', 'openab-gemini']);
  assert.equal(calls[0].command, 'docker');
  assert.equal(calls[0].options.timeoutMs, 20_000);
  assert.equal('start' in controller, false);
  assert.equal('restart' in controller, false);
  assert.equal('kill' in controller, false);
  await assert.rejects(
    () => controller.stop({ agent_id: 'bad', target: { kind: 'docker-container', name: 'bad;name' } }),
    /does not support/,
  );
});
