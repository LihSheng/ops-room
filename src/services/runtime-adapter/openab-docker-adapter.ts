import { createDockerReadInspector } from './docker-read-inspector.js';
import {
  unknownRuntimeStatus,
  type AgentRuntimeAdapter,
  type PreparedRuntime,
  type RuntimeAdapterInspection,
} from './types.js';

const SUPPORTED_BACKENDS = new Set(['opencode', 'gemini']);

export function createOpenABDockerRuntimeAdapter({ inspector = createDockerReadInspector() } = {}): AgentRuntimeAdapter {
  return {
    id: 'openab-docker',

    supports(agentDefinition) {
      return SUPPORTED_BACKENDS.has(agentDefinition?.backend)
        && typeof agentDefinition?.containerName === 'string'
        && agentDefinition.containerName.length > 0;
    },

    prepare(agentDefinition): PreparedRuntime {
      if (!this.supports(agentDefinition)) {
        throw new Error(`Adapter ${this.id} does not support agent ${agentDefinition?.key || 'unknown'}`);
      }
      return {
        agent_id: agentDefinition.key,
        adapter_id: this.id,
        backend: agentDefinition.backend,
        service: agentDefinition.service,
        image: agentDefinition.image || null,
        config_path: `config/agents/${agentDefinition.configName}.toml`,
        data_dir: agentDefinition.dataDir,
        desired_state: agentDefinition.desiredState,
        target: {
          kind: 'docker-container',
          name: agentDefinition.containerName,
        },
      };
    },

    inspect(preparedRuntimes): RuntimeAdapterInspection {
      const result = inspector.inspect(preparedRuntimes.map((runtime) => runtime.target.name));
      const runtimes = Object.fromEntries(preparedRuntimes.map((runtime) => [
        runtime.agent_id,
        result.status_by_container[runtime.target.name] || unknownRuntimeStatus(),
      ]));
      return {
        adapter_id: this.id,
        available: result.available,
        error: result.error,
        fetched_at: result.fetched_at,
        runtimes,
      };
    },
  };
}
