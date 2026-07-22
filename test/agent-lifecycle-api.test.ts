import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgentList } from '../src/services/agent-registry.js';
import { getOpenABInstances } from '../src/services/openab-instances.js';

function runtimeSnapshot() {
  return {
    instances: ['professor', 'berlin', 'tokyo', 'gemini'].map((agent) => ({
      agent,
      adapter_id: 'fake-runtime',
      runtime: { status: 'running', state: 'running', health: 'none' },
    })),
    adapters: [],
  };
}

function lifecycleState({ agentId }) {
  return {
    schema: 'ops-room.agent-lifecycle.v1',
    agent_id: agentId,
    desired_state: agentId === 'gemini' ? 'stopped' : 'unmanaged',
    phase: agentId === 'gemini' ? 'stopped' : 'unmanaged',
    previous_desired_state: null,
    last_operation: {
      operation: 'agent.stop',
      actor_id: 'private-operator-id',
      reason: 'private operator reason',
      requested_at: '2026-07-19T00:00:00.000Z',
      completed_at: '2026-07-19T00:00:01.000Z',
      outcome: 'accepted',
    },
    last_error: null,
    updated_at: '2026-07-19T00:00:01.000Z',
  };
}

test('agent and instance read APIs expose bounded lifecycle status only', async () => {
  const options = {
    getRuntimeSnapshot: runtimeSnapshot,
    getLifecycleState: lifecycleState,
    lifecycleDir: '/unused',
  };

  const agents = await getAgentList(options);
  const instances = getOpenABInstances(options);
  const geminiAgent = agents.find((agent) => agent.key === 'gemini');
  const geminiInstance = instances.instances.find((instance) => instance.agent === 'gemini');

  assert.equal(geminiAgent.desired_state, 'stopped');
  assert.equal(geminiAgent.lifecycle_state, 'stopped');
  assert.equal(geminiAgent.lifecycle_updated_at, '2026-07-19T00:00:01.000Z');
  assert.equal('lifecycle' in geminiAgent, false);

  assert.equal(geminiInstance.desired_state, 'stopped');
  assert.equal(geminiInstance.lifecycle_state, 'stopped');
  assert.equal('lifecycle' in geminiInstance, false);

  const serialized = JSON.stringify({ agents, instances });
  assert.equal(serialized.includes('private-operator-id'), false);
  assert.equal(serialized.includes('private operator reason'), false);
});
