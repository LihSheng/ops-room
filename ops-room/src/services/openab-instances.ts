import { POLL_AGENTS } from '../lib/config.js';
import { AGENT_DEFINITIONS } from './agent-definitions.js';
import { inspectAgentRuntimes } from './runtime-adapter/registry.js';
import { unknownRuntimeStatus } from './runtime-adapter/types.js';

function instanceAgentId(instance) {
  return instance?.agent || instance?.agent_id || instance?.definition?.key || null;
}

export function getOpenABInstances({ getRuntimeSnapshot = inspectAgentRuntimes } = {}) {
  const snapshot = getRuntimeSnapshot();
  const inspectedByAgent = new Map(
    (snapshot.instances || []).map((instance) => [instanceAgentId(instance), instance]),
  );

  const instances = AGENT_DEFINITIONS.map((entry) => {
    const inspected = inspectedByAgent.get(entry.key);
    const prepared = inspected?.prepared || null;
    const runtime = inspected?.runtime || unknownRuntimeStatus();
    const containerName = prepared?.target?.kind === 'docker-container'
      ? prepared.target.name
      : entry.containerName;

    return {
      agent: entry.key,
      display_name: entry.displayName,
      role: entry.role,
      description: entry.description,
      service: prepared?.service || entry.service,
      container_name: containerName,
      backend: prepared?.backend || entry.backend,
      image: prepared?.image || entry.image,
      config_path: prepared?.config_path || `config/agents/${entry.configName}.toml`,
      data_dir: prepared?.data_dir || entry.dataDir,
      github_polling_enabled: POLL_AGENTS.includes(entry.key),
      desired_state: prepared?.desired_state || entry.desiredState,
      observed_state: runtime.status || 'unknown',
      runtime_adapter: inspected?.adapter_id || null,
      runtime,
      links: {
        logs: `/api/logs?agent=${entry.key}`,
        tasks: '/api/tasks',
      },
    };
  });

  const adapterDiagnostics = Array.isArray(snapshot.adapters) ? snapshot.adapters : [];
  const dockerAdapter = adapterDiagnostics.find((adapter) => adapter.adapter_id === 'openab-docker');
  const legacyDocker = snapshot.docker || null;

  return {
    instances,
    docker: {
      available: Boolean(dockerAdapter?.available ?? legacyDocker?.available ?? false),
      error: dockerAdapter?.error ?? legacyDocker?.error ?? null,
    },
    runtime_adapters: adapterDiagnostics,
  };
}
