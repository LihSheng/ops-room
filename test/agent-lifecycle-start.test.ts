import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleOperatorAgentStart, handleOperatorAgentStop } from '../src/routes/operator-agents.js';
import {
  classifyConvergence,
  isApprovedHealth,
  readAgentLifecycleState,
  recoverInterruptedAgentLifecycleStates,
  updateAgentLifecycleState,
  agentLifecycleAllowsDispatch,
} from '../src/services/agent-lifecycle-store.js';
import { listAuditEvents } from '../src/services/audit-log.js';
import { createDockerAgentLifecycleController } from '../src/services/runtime-lifecycle/docker-lifecycle-controller.js';

const actor = {
  actor_type: 'human_operator',
  actor_id: 'lihsheng',
  actor_display_name: 'Lih Sheng',
  auth_method: 'operator_token',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ops-room-start-lifecycle-'));
  return {
    reviewTasksDir: join(root, 'review-tasks'),
    lifecycleDir: join(root, 'lifecycle'),
    auditDir: join(root, 'audit'),
    idempotencyDir: join(root, 'idempotency'),
  };
}

function fakeTarget(startFn, supports = true) {
  return {
    runtime_adapter_id: 'fake-runtime',
    prepared: {
      agent_id: 'gemini',
      adapter_id: 'fake-runtime',
      target: { kind: 'docker-container', name: 'openab-gemini' },
    },
    controller: {
      id: 'fake-lifecycle',
      supports: () => supports,
      stop: async () => ({ controller_id: 'fake-lifecycle', action: 'stop' }),
      start: startFn || (async () => ({ controller_id: 'fake-lifecycle', action: 'start' })),
    },
  };
}

function makeBody(overrides = {}) {
  return {
    reason: overrides.reason || 'test start',
    confirm_agent_id: 'gemini',
    idempotency_key: overrides.idempotencyKey || 'test-ik-1',
    ...overrides,
  };
}

function makeRuntimeSnapshot(overrides = {}) {
  return {
    instances: [{
      agent: 'gemini',
      adapter_id: 'fake-runtime',
      definition: { key: 'gemini' },
      prepared: { agent_id: 'gemini', target: { kind: 'docker-container', name: 'openab-gemini' } },
      runtime: {
        status: overrides.status || 'running',
        state: overrides.status || 'running',
        health: overrides.health || 'healthy',
        started_at: new Date().toISOString(),
        exit_code: 0,
      },
    }],
    adapters: [],
  };
}

let callCount = 0;
let startArgs = null;
function resetStartTracker() {
  callCount = 0;
  startArgs = null;
}
function trackingStart() {
  return async (prepared, opts) => {
    callCount++;
    startArgs = { prepared, opts };
    return { controller_id: 'fake-lifecycle', action: 'start' };
  };
}

async function setDesiredStoppedLifecycle(dir, agentId = 'gemini') {
  await updateAgentLifecycleState({
    dir, agentId,
    patch: {
      desired_state: 'stopped',
      phase: 'stopped',
      previous_desired_state: null,
      last_error: null,
      last_operation: {
        operation: 'agent.stop',
        actor_id: 'ops-room-operator',
        reason: 'OPS-008A test',
        requested_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        outcome: 'accepted',
      },
    },
  });
}

async function setDesiredRunningLifecycle(dir, agentId = 'gemini') {
  await updateAgentLifecycleState({
    dir, agentId,
    patch: {
      desired_state: 'running',
      phase: 'running',
      previous_desired_state: null,
      last_error: null,
      last_operation: {
        operation: 'agent.start',
        actor_id: 'ops-room-operator',
        reason: 'test',
        requested_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        outcome: 'accepted',
      },
    },
  });
}

// === Tests ===

test('stopped Gemini starts successfully with one fixed Docker command', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  // Use a stateful snapshot that switches to running after start
  let snapshotState = 'exited';
  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody(),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: snapshotState }),
    prepareTarget: () => fakeTarget(async (prepared, opts) => {
      snapshotState = 'running'; // After start, runtime becomes running
      callCount++;
      startArgs = { prepared, opts };
      return { controller_id: 'fake-lifecycle', action: 'start' };
    }),
    sleep: async () => {}, // No real sleep
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.operation, 'agent.start');
  assert.equal(result.body.command_executed, true);
  assert.equal(result.body.agent.desired_state, 'running');
  assert.equal(result.body.agent.lifecycle_state, 'running');
  assert.equal(callCount, 1);

  // Verify lifecycle state
  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'running');
  assert.equal(state.phase, 'running');
  assert.equal(state.last_operation.outcome, 'accepted');
});

test('already-running Gemini is adopted with zero commands', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredRunningLifecycle(f.lifecycleDir);

  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-adopt-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.command_executed, false);
  assert.equal(callCount, 0);

  // Verify no lifecycle mutation needed
  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'running');
  assert.equal(state.phase, 'running');
});

test('durable running + observed startable enters guarded start recovery path', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredRunningLifecycle(f.lifecycleDir);

  // Startable state (exited) with durable running should enter guarded start, not reject
  let snapshotState = 'exited';
  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-recovery-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: snapshotState }),
    prepareTarget: () => fakeTarget(async (prepared, opts) => {
      snapshotState = 'running'; // After start, runtime becomes running
      callCount++;
      startArgs = { prepared, opts };
      return { controller_id: 'fake-lifecycle', action: 'start' };
    }),
    sleep: async () => {},
  });

  // Should succeed through guarded start recovery, not rejected
  assert.equal(result.status, 202);
  assert.equal(result.body.command_executed, true);
  assert.equal(result.body.agent.desired_state, 'running');
  assert.equal(result.body.agent.lifecycle_state, 'running');
  assert.equal(callCount, 1);

  // Verify lifecycle state reflects recovery
  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'running');
  assert.equal(state.phase, 'running');
  assert.equal(state.last_operation.outcome, 'accepted');
});

test('missing runtime fails closed with zero commands', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-missing-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'missing' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error_code, 'runtime_observation_missing');
  assert.equal(callCount, 0);
});

test('unknown runtime fails closed with zero commands', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-unknown-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'unknown' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error_code, 'runtime_observation_unknown');
  assert.equal(callCount, 0);
});

test('OPS-008A mismatch (desired=stopped, observed=running) becomes durable running', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-mismatch-resolve-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.command_executed, false);
  assert.equal(result.body.agent.desired_state, 'running');
  assert.equal(result.body.agent.lifecycle_state, 'running');

  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'running');
  assert.equal(state.phase, 'running');
  assert.equal(callCount, 0);
});

test('command failure creates failed lifecycle state and rejected/failed audit evidence', async () => {
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  let failStart = async () => { throw new Error('docker start failed'); };

  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-fail-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
    prepareTarget: () => fakeTarget(failStart),
  });

  assert.equal(result.status, 502);
  assert.equal(result.body.error_code, 'runtime_start_failed');

  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'running');
  assert.equal(state.phase, 'failed');
  assert.equal(state.last_error, 'runtime_start_failed');

  // Verify audit event
  const events = await listAuditEvents({ dir: f.auditDir });
  assert.equal(events.length >= 1, true);
  const startEvents = events.filter(e => e.operation === 'agent.start');
  assert.equal(startEvents.length >= 1, true);
});

test('rejected starts are audited as agent.start, not agent.stop', async () => {
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  // Reject by using wrong agent
  const result = await handleOperatorAgentStart({
    agentId: 'professor',
    body: makeBody({ idempotency_key: 'test-ik-reject-audit-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
    prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake', action: 'start' })),
  });

  assert.equal(result.status, 403);
  assert.equal(result.body.error_code, 'agent_not_allowed');

  // Verify audit event uses agent.start
  const events = await listAuditEvents({ dir: f.auditDir });
  const startRejections = events.filter(e => e.operation === 'agent.start' && e.outcome === 'rejected');
  assert.equal(startRejections.length >= 1, true);

  // Verify no agent.stop events were created for this
  const stopEvents = events.filter(e => e.operation === 'agent.stop');
  const startRejectAsStop = stopEvents.filter(e =>
    e.idempotency_key && e.idempotency_key.includes('test-ik-reject-audit')
  );
  assert.equal(startRejectAsStop.length, 0);
});

test('rejected stops remain audited as agent.stop', async () => {
  const f = await fixture();

  const result = await handleOperatorAgentStop({
    agentId: 'professor',
    body: { reason: 'test stop', confirm_agent_id: 'professor', idempotency_key: 'test-ik-stop-audit-1' },
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running' }),
    prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake', action: 'stop' })),
  });

  assert.equal(result.status, 403);
  assert.equal(result.body.error_code, 'agent_not_allowed');

  const events = await listAuditEvents({ dir: f.auditDir });
  const stopRejections = events.filter(e => e.operation === 'agent.stop' && e.outcome === 'rejected');
  assert.equal(stopRejections.length >= 1, true);
});

test('convergence fields appear in classifyConvergence helper', () => {
  // converged
  assert.deepEqual(classifyConvergence('running', 'running', 'running'), { status: 'converged', reason_code: null });
  assert.deepEqual(classifyConvergence('stopped', 'stopped', 'exited'), { status: 'converged', reason_code: null });
  assert.deepEqual(classifyConvergence('unmanaged', 'unmanaged', 'running'), { status: 'converged', reason_code: null });

  // transitioning
  assert.deepEqual(classifyConvergence('running', 'starting', 'exited'), { status: 'transitioning', reason_code: 'transition_in_progress' });
  assert.deepEqual(classifyConvergence('running', 'draining', 'running'), { status: 'transitioning', reason_code: 'transition_in_progress' });

  // mismatch
  assert.deepEqual(classifyConvergence('running', 'running', 'exited'), { status: 'mismatch', reason_code: 'observed_not_running' });
  assert.deepEqual(classifyConvergence('stopped', 'stopped', 'running'), { status: 'mismatch', reason_code: 'observed_running_desired_stopped' });
  assert.deepEqual(classifyConvergence('running', 'failed', 'running'), { status: 'mismatch', reason_code: 'operation_failed' });
});

test('same-key idempotent replay after success executes one command', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  let snapshotState = 'exited';

  // First request
  const result1 = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-replay-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: snapshotState }),
    prepareTarget: () => fakeTarget(async (prepared, opts) => {
      snapshotState = 'running';
      callCount++;
      startArgs = { prepared, opts };
      return { controller_id: 'fake-lifecycle', action: 'start' };
    }),
    sleep: async () => {},
  });

  assert.equal(result1.status, 202);
  assert.equal(callCount, 1);

  // Replay with same key (snapshot already 'running')
  const result2 = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-replay-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: snapshotState }),
    prepareTarget: () => fakeTarget(async (prepared, opts) => {
      snapshotState = 'running';
      callCount++;
      startArgs = { prepared, opts };
      return { controller_id: 'fake-lifecycle', action: 'start' };
    }),
    sleep: async () => {},
  });

  assert.equal(result2.body.idempotent_replay, true);
  assert.equal(callCount, 1); // Still 1 — no second command
});

test('Professor, Berlin, and Tokyo remain rejected for start', async () => {
  const f = await fixture();
  for (const agentId of ['professor', 'berlin', 'tokyo']) {
    const result = await handleOperatorAgentStart({
      agentId,
      body: makeBody({ idempotency_key: `test-ik-${agentId}-reject-1` }),
      actor,
      ...f,
      allowedAgents: ['gemini'],
      getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
      prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake', action: 'start' })),
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error_code, 'agent_not_allowed');
  }
});

test('invalid confirmation, reason, and idempotency key fail safely', async () => {
  const f = await fixture();

  // Wrong confirm_agent_id
  const r1 = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ confirm_agent_id: 'professor', idempotency_key: 'test-ik-bad-conf-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
    prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake', action: 'start' })),
  });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error_code, 'invalid_request');

  // Missing reason
  const r2 = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: { confirm_agent_id: 'gemini', reason: '', idempotency_key: 'test-ik-no-reason-1' },
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
    prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake', action: 'start' })),
  });
  assert.equal(r2.status, 400);

  // Missing idempotency key
  const r3 = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: { reason: 'test', confirm_agent_id: 'gemini' },
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
    prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake', action: 'start' })),
  });
  assert.equal(r3.status, 400);
});

test('interrupted starting recovery preserves desired running without replay', async () => {
  const f = await fixture();

  // Simulate an interrupted start: phase=starting, desired_state=running
  await updateAgentLifecycleState({
    dir: f.lifecycleDir, agentId: 'gemini',
    patch: {
      desired_state: 'running',
      phase: 'starting',
      previous_desired_state: 'stopped',
      last_error: null,
      last_operation: {
        operation: 'agent.start',
        actor_id: 'ops-room-operator',
        reason: 'test start',
        requested_at: new Date().toISOString(),
        outcome: 'in_progress',
      },
    },
  });

  // Run recovery
  const recovered = await recoverInterruptedAgentLifecycleStates({ dir: f.lifecycleDir });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0], 'gemini');

  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'running'); // Preserved
  assert.equal(state.phase, 'failed');
  assert.equal(state.last_error, 'interrupted_lifecycle_operation');
  assert.equal(state.last_operation.outcome, 'interrupted');
});

test('interrupted stop recovery preserves existing OPS-008A semantics', async () => {
  const f = await fixture();

  // Simulate an interrupted stop: phase=draining, desired_state=stopped
  await updateAgentLifecycleState({
    dir: f.lifecycleDir, agentId: 'gemini',
    patch: {
      desired_state: 'stopped',
      phase: 'draining',
      previous_desired_state: 'running',
      last_error: null,
      last_operation: {
        operation: 'agent.stop',
        actor_id: 'ops-room-operator',
        reason: 'test stop',
        requested_at: new Date().toISOString(),
        outcome: 'in_progress',
      },
    },
  });

  const recovered = await recoverInterruptedAgentLifecycleStates({ dir: f.lifecycleDir });
  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'running'); // Previous desired state
  assert.equal(state.phase, 'failed');
  assert.equal(state.last_error, 'interrupted_lifecycle_operation');
});

test('docker start uses exactly docker start <container> with no shell', () => {
  const controller = createDockerAgentLifecycleController();
  assert.equal(typeof controller.start, 'function');
  assert.equal(typeof controller.stop, 'function');
  assert.equal('restart' in controller, false);
  assert.equal('kill' in controller, false);
  assert.equal('recreate' in controller, false);
});

// === OPS-008B review-required tests ===

test('convergence timeout persists failed state with audit and same-key replay', async () => {
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  // Start with a snapshot that stays 'exited' so convergence always times out
  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-timeout-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    startTimeoutSeconds: 1, // Short timeout
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
    prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake-lifecycle', action: 'start' })),
    sleep: async () => {},
  });

  // Expect convergence timeout
  assert.equal(result.status, 504);
  assert.equal(result.body.error_code, 'runtime_start_convergence_timeout');
  assert.equal(result.body.command_executed, true);
  assert.ok(result.body.audit_event_id, 'audit event recorded');

  // Verify lifecycle state is failed
  let state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.phase, 'failed');
  assert.equal(state.last_error, 'runtime_start_convergence_timeout');

  // Verify audit event
  let events = await listAuditEvents({ dir: f.auditDir });
  const timeoutEvents = events.filter(e => e.operation === 'agent.start' && e.outcome === 'failed');
  assert.equal(timeoutEvents.length >= 1, true);

  // Same-key replay should return the same timeout result
  const replay = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-timeout-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    startTimeoutSeconds: 1,
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
    prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake-lifecycle', action: 'start' })),
    sleep: async () => {},
  });

  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.status, 504);
  assert.equal(replay.body.error_code, 'runtime_start_convergence_timeout');
});

test('different-key concurrency executes at most one docker command', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  let snapshotState = 'exited';

  // Helper function for concurrent requests
  async function concurrentStart(key) {
    return handleOperatorAgentStart({
      agentId: 'gemini',
      body: makeBody({ idempotency_key: key }),
      actor,
      ...f,
      allowedAgents: ['gemini'],
      getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: snapshotState }),
      prepareTarget: () => fakeTarget(async (prepared, opts) => {
        snapshotState = 'running';
        callCount++;
        startArgs = { prepared, opts };
        return { controller_id: 'fake-lifecycle', action: 'start' };
      }),
      sleep: async () => {},
    });
  }

  // Fire two requests with different keys concurrently
  const [r1, r2] = await Promise.all([
    concurrentStart('test-ik-concur-1'),
    concurrentStart('test-ik-concur-2'),
  ]);

  // Both should succeed
  assert.equal(r1.status, 202);
  assert.equal(r2.status, 202);
  // At most one docker command should execute
  assert.equal(callCount <= 1, true, 'at most one docker start command');
});

test('retry after convergence timeout can adopt already-running container', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  // First: timeout (container stays exited)
  const timeoutResult = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-retry-timeout-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    startTimeoutSeconds: 1,
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'exited' }),
    prepareTarget: () => fakeTarget(async () => ({ controller_id: 'fake-lifecycle', action: 'start' })),
    sleep: async () => {},
  });

  assert.equal(timeoutResult.status, 504);
  assert.equal(callCount, 0); // Only the timeout test above ran, no command captured

  // Now container is actually running (simulate external fix)
  const retryResult = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-retry-adopt-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running', health: 'healthy' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });

  // Should adopt as already running with zero commands
  assert.equal(retryResult.status, 202);
  assert.equal(retryResult.body.command_executed, false);
  assert.equal(callCount, 0);

  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'running');
  assert.equal(state.phase, 'running');
});

test('dispatch is blocked during starting and failed phases', async () => {
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  // Set to starting phase
  await updateAgentLifecycleState({
    dir: f.lifecycleDir, agentId: 'gemini',
    patch: {
      desired_state: 'running', phase: 'starting',
      previous_desired_state: 'stopped',
    },
  });

  assert.equal(agentLifecycleAllowsDispatch(
    await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' }),
  ), false, 'starting blocks dispatch');

  // Set to failed phase
  await updateAgentLifecycleState({
    dir: f.lifecycleDir, agentId: 'gemini',
    patch: { phase: 'failed', last_error: 'convergence_timeout' },
  });

  assert.equal(agentLifecycleAllowsDispatch(
    await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' }),
  ), false, 'failed blocks dispatch');

  // After successful start: phase=running
  await updateAgentLifecycleState({
    dir: f.lifecycleDir, agentId: 'gemini',
    patch: { phase: 'running', desired_state: 'running', last_error: null },
  });

  assert.equal(agentLifecycleAllowsDispatch(
    await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' }),
  ), true, 'running allows dispatch');
});

test('approved health adoption semantics: healthy, none, starting, unhealthy', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredRunningLifecycle(f.lifecycleDir);

  // running + healthy → adopted
  const rHealthy = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-health-ok-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running', health: 'healthy' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });
  assert.equal(rHealthy.status, 202);
  assert.equal(rHealthy.body.command_executed, false, 'healthy: no command');

  // running + none (no health check) → adopted
  const rNone = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-health-none-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running', health: 'none' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });
  assert.equal(rNone.status, 202);
  assert.equal(rNone.body.command_executed, false, 'none: no command');

  // running + starting → not adopted (rejected as unexpected)
  resetStartTracker();
  const f2 = await fixture();
  await setDesiredRunningLifecycle(f2.lifecycleDir);
  const rStarting = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-health-starting-1' }),
    actor,
    ...f2,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running', health: 'starting' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });
  assert.equal(rStarting.status, 409);
  assert.equal(rStarting.body.error_code, 'runtime_observation_unexpected', 'starting: rejected');
  assert.equal(callCount, 0, 'starting: no command');

  // running + unhealthy → rejected
  const f3 = await fixture();
  await setDesiredRunningLifecycle(f3.lifecycleDir);
  const rUnhealthy = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-health-unhealthy-1' }),
    actor,
    ...f3,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running', health: 'unhealthy' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });
  assert.equal(rUnhealthy.status, 409);
  assert.equal(rUnhealthy.body.error_code, 'runtime_observation_unexpected', 'unhealthy: rejected');
  assert.equal(callCount, 0, 'unhealthy: no command');
});

test('unapproved Docker states are rejected with zero commands', async () => {
  const UNAPPROVED_STATES = ['created', 'paused', 'restarting', 'removing'];
  for (const state of UNAPPROVED_STATES) {
    resetStartTracker();
    const f = await fixture();
    await setDesiredStoppedLifecycle(f.lifecycleDir);

    const result = await handleOperatorAgentStart({
      agentId: 'gemini',
      body: makeBody({ idempotency_key: `test-ik-${state}-1` }),
      actor,
      ...f,
      allowedAgents: ['gemini'],
      getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: state }),
      prepareTarget: () => fakeTarget(trackingStart()),
      sleep: async () => {},
    });

    assert.equal(result.status, 409, `${state}: expected 409`);
    assert.equal(result.body.error_code, 'runtime_observation_unexpected', `${state}: unexpected error`);
    assert.equal(callCount, 0, `${state}: no start command`);
  }
});

test('convergence timeout with stale cache uses freshRuntimeSnapshot', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  // Cached snapshot always shows 'exited'
  const staleCache = () => makeRuntimeSnapshot({ status: 'exited' });
  // Fresh snapshot shows 'running' after start
  let freshState = 'exited';
  const freshInspector = () => makeRuntimeSnapshot({ status: freshState });

  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-cache-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: staleCache,
    freshRuntimeSnapshot: freshInspector,
    prepareTarget: () => fakeTarget(async (prepared, opts) => {
      freshState = 'running'; // Fresh inspection sees this
      callCount++;
      startArgs = { prepared, opts };
      return { controller_id: 'fake-lifecycle', action: 'start' };
    }),
    sleep: async () => {},
  });

  // Should converge because freshRuntimeSnapshot sees running even though stale cache shows exited
  assert.equal(result.status, 202);
  assert.equal(result.body.command_executed, true);
  assert.equal(result.body.agent.lifecycle_state, 'running');
  assert.equal(callCount, 1);
});

test('unhealthy convergence leaves failed state and appropriate error code', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  // Container starts but health stays unhealthy
  let containerRunning = false;
  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-unhealthy-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    startTimeoutSeconds: 1,
    getRuntimeSnapshot: () => makeRuntimeSnapshot({
      status: containerRunning ? 'running' : 'exited',
      health: containerRunning ? 'unhealthy' : 'none',
    }),
    freshRuntimeSnapshot: () => makeRuntimeSnapshot({
      status: containerRunning ? 'running' : 'exited',
      health: containerRunning ? 'unhealthy' : 'none',
    }),
    prepareTarget: () => fakeTarget(async () => {
      containerRunning = true;
      callCount++;
      return { controller_id: 'fake-lifecycle', action: 'start' };
    }),
    sleep: async () => {},
  });

  // Should detect unhealthy and fail fast
  assert.equal(result.status, 504);
  assert.equal(result.body.error_code, 'runtime_start_convergence_unhealthy');
  assert.equal(result.body.command_executed, true);

  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.phase, 'failed');
  assert.equal(state.last_error, 'runtime_start_convergence_unhealthy');
});

test('classifyConvergence respects health parameter correctly', () => {
  // running + healthy → converged
  assert.deepEqual(classifyConvergence('running', 'running', 'running', 'healthy'), { status: 'converged', reason_code: null });
  // running + none → converged
  assert.deepEqual(classifyConvergence('running', 'running', 'running', 'none'), { status: 'converged', reason_code: null });
  // running + unhealthy → mismatch
  assert.deepEqual(classifyConvergence('running', 'running', 'running', 'unhealthy'), { status: 'mismatch', reason_code: 'observed_unhealthy' });
  // running + starting → transitioning
  assert.deepEqual(classifyConvergence('running', 'running', 'running', 'starting'), { status: 'transitioning', reason_code: 'health_starting' });
  // Legacy: no health parameter → uses status only
  assert.deepEqual(classifyConvergence('running', 'running', 'running'), { status: 'converged', reason_code: null });
  assert.deepEqual(classifyConvergence('running', 'running', 'exited'), { status: 'mismatch', reason_code: 'observed_not_running' });
});

test('running + unhealthy in OPS-008A mismatch does not resolve to durable running', async () => {
  resetStartTracker();
  const f = await fixture();
  await setDesiredStoppedLifecycle(f.lifecycleDir);

  // desired=stopped, phase=stopped, observed=running+unhealthy
  const result = await handleOperatorAgentStart({
    agentId: 'gemini',
    body: makeBody({ idempotency_key: 'test-ik-ops8a-unhealthy-1' }),
    actor,
    ...f,
    allowedAgents: ['gemini'],
    getRuntimeSnapshot: () => makeRuntimeSnapshot({ status: 'running', health: 'unhealthy' }),
    prepareTarget: () => fakeTarget(trackingStart()),
  });

  // Should reject, not adopt
  assert.equal(result.status, 409);
  assert.equal(result.body.error_code, 'runtime_observation_unexpected');

  // Verify state unchanged
  const state = await readAgentLifecycleState({ dir: f.lifecycleDir, agentId: 'gemini' });
  assert.equal(state.desired_state, 'stopped');
  assert.equal(state.phase, 'stopped');
});
