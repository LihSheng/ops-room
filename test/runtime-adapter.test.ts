import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgentList } from '../src/services/agent-registry.js';
import { getOpenABInstances } from '../src/services/openab-instances.js';
import { createDockerReadInspector } from '../src/services/runtime-adapter/docker-read-inspector.js';
import { createOpenABDockerRuntimeAdapter } from '../src/services/runtime-adapter/openab-docker-adapter.js';
import { inspectAgentRuntimes, prepareAgentRuntimes } from '../src/services/runtime-adapter/registry.js';

function definition(key, backend = 'fake') {
  return {
    key,
    displayName: key.toUpperCase(),
    role: 'Test',
    description: 'Test runtime',
    service: `${key}-service`,
    configName: key,
    containerName: `${key}-container`,
    backend,
    image: `${key}:latest`,
    dataDir: `data/${key}`,
    desiredState: 'unmanaged',
  };
}

function fakeAdapter({ id = 'fake-adapter', fail = false } = {}) {
  return {
    id,
    supports: (agentDefinition) => agentDefinition.backend === 'fake',
    prepare: (agentDefinition) => ({
      agent_id: agentDefinition.key,
      adapter_id: id,
      backend: agentDefinition.backend,
      service: agentDefinition.service,
      image: agentDefinition.image,
      config_path: `config/agents/${agentDefinition.configName}.toml`,
      data_dir: agentDefinition.dataDir,
      desired_state: agentDefinition.desiredState,
      target: { kind: 'unknown', name: agentDefinition.key },
    }),
    inspect: (preparedRuntimes) => {
      if (fail) throw new Error('provider details must not escape');
      return {
        adapter_id: id,
        available: true,
        error: null,
        fetched_at: 1234,
        runtimes: Object.fromEntries(preparedRuntimes.map((prepared) => [prepared.agent_id, {
          status: prepared.agent_id === 'alpha' ? 'running' : 'exited',
          state: prepared.agent_id === 'alpha' ? 'running' : 'exited',
          health: 'none',
          restart_count: 0,
        }])),
      };
    },
  };
}

test('runtime adapter contract prepares and inspects provider-neutral records', () => {
  const definitions = [definition('alpha'), definition('beta')];
  const adapters = [fakeAdapter()];

  const prepared = prepareAgentRuntimes({ definitions, adapters });
  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].prepared.agent_id, 'alpha');
  assert.equal(prepared[0].prepared.adapter_id, 'fake-adapter');

  const snapshot = inspectAgentRuntimes({ definitions, adapters });
  assert.equal(snapshot.instances.length, 2);
  assert.equal(snapshot.instances[0].runtime.status, 'running');
  assert.equal(snapshot.instances[1].runtime.status, 'exited');
  assert.deepEqual(snapshot.adapters, [{
    adapter_id: 'fake-adapter', available: true, error: null, fetched_at: 1234,
  }]);
});

test('shared OpenAB adapter supports OpenCode and Gemini without lifecycle methods', () => {
  const inspectedTargets = [];
  const adapter = createOpenABDockerRuntimeAdapter({
    inspector: {
      inspect: (containerNames) => {
        inspectedTargets.push(...containerNames);
        return {
          available: true,
          error: null,
          fetched_at: 55,
          status_by_container: Object.fromEntries(containerNames.map((name) => [name, {
            status: 'running', state: 'running', health: 'none',
          }])),
        };
      },
    },
  });
  const definitions = [definition('professor', 'opencode'), definition('gemini', 'gemini')];
  const snapshot = inspectAgentRuntimes({ definitions, adapters: [adapter] });

  assert.equal(adapter.supports(definition('other', 'unsupported')), false);
  assert.equal(snapshot.instances.every((instance) => instance.adapter_id === 'openab-docker'), true);
  assert.deepEqual(inspectedTargets.sort(), ['gemini-container', 'professor-container']);
  assert.equal(snapshot.instances.every((instance) => instance.runtime.status === 'running'), true);
  assert.equal('start' in adapter, false);
  assert.equal('stop' in adapter, false);
  assert.equal('restart' in adapter, false);
});

test('runtime adapter registry rejects unsupported and ambiguous definitions', () => {
  assert.throws(
    () => prepareAgentRuntimes({ definitions: [definition('alpha', 'unsupported')], adapters: [fakeAdapter()] }),
    /No runtime adapter supports agent alpha/,
  );
  assert.throws(
    () => prepareAgentRuntimes({ definitions: [definition('alpha')], adapters: [fakeAdapter({ id: 'one' }), fakeAdapter({ id: 'two' })] }),
    /Multiple runtime adapters support agent alpha/,
  );
});

test('adapter inspection failures degrade to bounded unknown runtime status', () => {
  const snapshot = inspectAgentRuntimes({
    definitions: [definition('alpha')],
    adapters: [fakeAdapter({ fail: true })],
  });
  assert.equal(snapshot.instances[0].runtime.status, 'unknown');
  assert.deepEqual(snapshot.adapters[0], {
    adapter_id: 'fake-adapter',
    available: false,
    error: 'runtime adapter inspection failed',
    fetched_at: snapshot.adapters[0].fetched_at,
  });
});

test('docker inspector normalizes read-only inspect output and caches identical requests', () => {
  const calls = [];
  const execFile = (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'info') return '27.0.0';
    return JSON.stringify([{
      Name: '/alpha-container',
      RestartCount: 2,
      State: {
        Status: 'running', Running: true, StartedAt: '2026-07-19T00:00:00Z', FinishedAt: '',
        ExitCode: 0, OOMKilled: false, Health: { Status: 'healthy' },
      },
    }]);
  };
  let clock = 1000;
  const inspector = createDockerReadInspector({ execFile, now: () => clock, cacheMs: 5000 });

  const first = inspector.inspect(['missing-container', 'alpha-container']);
  assert.equal(first.available, true);
  assert.equal(first.status_by_container['alpha-container'].health, 'healthy');
  assert.equal(first.status_by_container['missing-container'].status, 'missing');
  assert.equal(calls.length, 2);

  clock = 2000;
  const second = inspector.inspect(['alpha-container', 'missing-container']);
  assert.equal(second, first);
  assert.equal(calls.length, 2);
});

test('instance and agent APIs retain existing fields while consuming adapter snapshots', async () => {
  const runtimeByAgent = {
    professor: 'running',
    berlin: 'exited',
    tokyo: 'missing',
    gemini: 'running',
  };
  const snapshot = {
    instances: Object.entries(runtimeByAgent).map(([agent, status]) => ({
      agent,
      adapter_id: 'fake-runtime',
      runtime: { status, state: status, health: 'none' },
    })),
    adapters: [{ adapter_id: 'openab-docker', available: true, error: null, fetched_at: 777 }],
  };

  const instances = getOpenABInstances({ getRuntimeSnapshot: () => snapshot });
  assert.equal(instances.instances.length, 4);
  assert.equal(instances.instances.find((item) => item.agent === 'professor').observed_state, 'running');
  assert.equal(instances.instances.find((item) => item.agent === 'professor').runtime_adapter, 'fake-runtime');
  assert.equal(instances.docker.available, true);
  assert.equal(instances.runtime_adapters[0].adapter_id, 'openab-docker');

  const agents = await getAgentList({ getRuntimeSnapshot: () => snapshot });
  assert.equal(agents.find((item) => item.key === 'berlin').observed_state, 'exited');
  assert.equal(agents.find((item) => item.key === 'berlin').runtime_adapter, 'fake-runtime');
});
