import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareAgentLifecycleTarget } from '../src/services/runtime-lifecycle/registry.js';
function fakeRuntimeAdapter() {
    return {
        id: 'fake-runtime',
        supports: () => true,
        prepare: (definition) => ({
            agent_id: definition.key,
            adapter_id: 'fake-runtime',
            backend: definition.backend,
            service: definition.service,
            image: definition.image,
            config_path: `config/agents/${definition.configName}.toml`,
            data_dir: definition.dataDir,
            desired_state: definition.desiredState,
            target: { kind: 'docker-container', name: definition.containerName },
        }),
        inspect: () => ({
            adapter_id: 'fake-runtime',
            available: true,
            error: null,
            fetched_at: 1,
            runtimes: {},
        }),
    };
}
function fakeLifecycleController() {
    return {
        id: 'fake-lifecycle',
        supports: () => true,
        stop: () => ({ controller_id: 'fake-lifecycle', action: 'stop' }),
    };
}
test('only the canonical guarded-stop test agent can prepare a lifecycle target', () => {
    const options = {
        runtimeAdapters: [fakeRuntimeAdapter()],
        lifecycleControllers: [fakeLifecycleController()],
    };
    const gemini = prepareAgentLifecycleTarget('gemini', options);
    assert.equal(gemini.definition.lifecycleControl, 'guarded-test');
    assert.equal(gemini.prepared.agent_id, 'gemini');
    for (const agentId of ['professor', 'berlin', 'tokyo']) {
        assert.throws(() => prepareAgentLifecycleTarget(agentId, options), new RegExp(`Lifecycle control is not approved for agent ${agentId}`));
    }
});
//# sourceMappingURL=agent-lifecycle-policy.test.js.map