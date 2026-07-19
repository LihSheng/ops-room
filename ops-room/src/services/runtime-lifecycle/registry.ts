import { AGENT_DEFINITIONS } from '../agent-definitions.js';
import { prepareAgentRuntimes } from '../runtime-adapter/registry.js';
import { createDockerAgentLifecycleController } from './docker-lifecycle-controller.js';

const APPROVED_LIFECYCLE_CONTROL = Object.freeze(new Set(['guarded-stop-test', 'guarded-test']));

const DEFAULT_LIFECYCLE_CONTROLLERS = Object.freeze([
  createDockerAgentLifecycleController(),
]);

function selectLifecycleController(preparedRuntime, controllers) {
  const matches = controllers.filter((controller) => controller.supports(preparedRuntime));
  if (matches.length === 0) {
    throw new Error(`No lifecycle controller supports agent ${preparedRuntime.agent_id}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple lifecycle controllers support agent ${preparedRuntime.agent_id}`);
  }
  return matches[0];
}

export function prepareAgentLifecycleTarget(agentId: string, {
  definitions = AGENT_DEFINITIONS,
  runtimeAdapters,
  lifecycleControllers = DEFAULT_LIFECYCLE_CONTROLLERS,
} = {}) {
  const definition = definitions.find((entry) => entry.key === agentId);
  if (!definition) throw new Error(`Unknown agent: ${agentId}`);
  if (!APPROVED_LIFECYCLE_CONTROL.has(definition.lifecycleControl)) {
    throw new Error(`Lifecycle control is not approved for agent ${agentId}`);
  }

  const preparedRecords = runtimeAdapters
    ? prepareAgentRuntimes({ definitions: [definition], adapters: runtimeAdapters })
    : prepareAgentRuntimes({ definitions: [definition] });
  const preparedRecord = preparedRecords[0];
  const controller = selectLifecycleController(preparedRecord.prepared, lifecycleControllers);

  return {
    definition,
    runtime_adapter_id: preparedRecord.adapter.id,
    prepared: preparedRecord.prepared,
    controller,
  };
}

export function getDefaultAgentLifecycleControllers() {
  return [...DEFAULT_LIFECYCLE_CONTROLLERS];
}
