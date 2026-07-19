import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readAgentLifecycleState } from '../src/services/agent-lifecycle-store.js';

async function lifecycleFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ops-room-lifecycle-store-'));
  await mkdir(dir, { recursive: true });
  return dir;
}

test('lifecycle records expose only the bounded schema fields', async () => {
  const dir = await lifecycleFixture();
  await writeFile(join(dir, 'agent-gemini.json'), JSON.stringify({
    schema: 'ops-room.agent-lifecycle.v1',
    agent_id: 'gemini',
    desired_state: 'stopped',
    phase: 'stopped',
    previous_desired_state: null,
    last_operation: {
      operation: 'agent.stop',
      actor_id: 'lihsheng',
      reason: 'Approved stop',
      requested_at: '2026-07-19T00:00:00.000Z',
      completed_at: '2026-07-19T00:00:01.000Z',
      outcome: 'accepted',
      token: 'must-not-escape',
    },
    last_error: null,
    updated_at: '2026-07-19T00:00:01.000Z',
    secret: 'must-not-escape',
  }), 'utf-8');

  const state = await readAgentLifecycleState({ dir, agentId: 'gemini' });

  assert.equal(state.phase, 'stopped');
  assert.equal('secret' in state, false);
  assert.equal('token' in state.last_operation, false);
});

test('unsupported lifecycle values fail closed', async () => {
  const dir = await lifecycleFixture();
  await writeFile(join(dir, 'agent-gemini.json'), JSON.stringify({
    schema: 'ops-room.agent-lifecycle.v1',
    agent_id: 'gemini',
    desired_state: 'running',
    phase: 'restarting',
    previous_desired_state: null,
    last_operation: null,
    last_error: null,
    updated_at: '2026-07-19T00:00:01.000Z',
  }), 'utf-8');

  const state = await readAgentLifecycleState({ dir, agentId: 'gemini' });

  assert.equal(state.desired_state, 'stopped');
  assert.equal(state.phase, 'failed');
  assert.equal(state.last_error, 'lifecycle_state_unavailable');
});
