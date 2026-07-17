import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_DEFINITIONS } from '../src/services/agent-definitions.js';
import { getAgentList } from '../src/services/agent-registry.js';

test('agent definitions are the unique source for identity and runtime bindings', () => {
  assert.equal(AGENT_DEFINITIONS.length, 4);
  assert.equal(new Set(AGENT_DEFINITIONS.map((agent) => agent.key)).size, 4);
  assert.equal(new Set(AGENT_DEFINITIONS.map((agent) => agent.containerName)).size, 4);
  for (const agent of AGENT_DEFINITIONS) {
    assert.ok(agent.displayName);
    assert.ok(agent.role);
    assert.ok(agent.configName);
    assert.ok(agent.containerName);
    assert.equal(agent.desiredState, 'unmanaged');
  }
});

test('agent registry reports desired and observed state from one definition set', async () => {
  const runtime = { status: 'running', health: 'healthy' };
  const agents = await getAgentList({
    getRuntimeSnapshot: () => ({
      instances: AGENT_DEFINITIONS.map((agent) => ({ agent: agent.key, runtime })),
    }),
  });

  assert.deepEqual(agents.map((agent) => agent.key), AGENT_DEFINITIONS.map((agent) => agent.key));
  for (const agent of agents) {
    assert.equal(agent.desired_state, 'unmanaged');
    assert.equal(agent.observed_state, 'running');
    assert.equal(agent.runtime.health, 'healthy');
    assert.ok(agent.role);
    assert.ok(agent.description);
    assert.equal(JSON.stringify(agent).includes('OPENAB_WEBHOOK_SECRET'), false);
  }
});
