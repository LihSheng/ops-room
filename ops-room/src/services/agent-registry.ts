import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_NAMES, BOT_USERS, POLL_AGENTS } from '../lib/config.js';
import { AGENT_DEFINITIONS } from './agent-definitions.js';
import { readAgentLifecycleState } from './agent-lifecycle-store.js';
import { inspectAgentRuntimes } from './runtime-adapter/registry.js';
import { AGENTS_CONFIG_DIR, LIFECYCLE_DIR } from './runtime-paths.js';

async function configExists(configDir) {
  try {
    await access(configDir);
    return true;
  } catch {
    return false;
  }
}

function instanceAgentId(instance) {
  return instance?.agent || instance?.agent_id || instance?.definition?.key || null;
}

export async function getAgentList({
  getRuntimeSnapshot = inspectAgentRuntimes,
  getLifecycleState = readAgentLifecycleState,
  lifecycleDir = LIFECYCLE_DIR,
} = {}) {
  const agents = [];
  const runtimeSnapshot = getRuntimeSnapshot();
  const runtimeByAgent = new Map(
    (runtimeSnapshot.instances || []).map((instance) => [instanceAgentId(instance), instance]),
  );

  for (const definition of AGENT_DEFINITIONS) {
    const { key } = definition;
    const configPath = `config/agents/${definition.configName}.toml`;
    const exampleConfigPath = `config/agents/${definition.configName}.example.toml`;

    const hasConfig = await configExists(join(AGENTS_CONFIG_DIR, `${definition.configName}.toml`));
    const hasExample = await configExists(join(AGENTS_CONFIG_DIR, `${definition.configName}.example.toml`));
    const lifecycle = await getLifecycleState({ dir: lifecycleDir, agentId: key });

    const missing = [];
    if (!hasConfig) missing.push(configPath);
    if (!hasExample) missing.push(exampleConfigPath);

    const inspected = runtimeByAgent.get(key);
    const runtime = inspected?.runtime || null;

    agents.push({
      key,
      display_name: AGENT_NAMES[key] || definition.displayName,
      role: definition.role,
      description: definition.description,
      backend: definition.backend,
      config_path: configPath,
      example_config_path: exampleConfigPath,
      service: definition.service,
      container_name: definition.containerName,
      data_dir: definition.dataDir,
      github_app_bot_user: BOT_USERS[key] || `lihsheng-${key}[bot]`,
      enabled: hasConfig,
      github_polling_enabled: POLL_AGENTS.includes(key),
      desired_state: lifecycle.desired_state || definition.desiredState,
      lifecycle_state: lifecycle.phase,
      lifecycle,
      observed_state: runtime?.status || 'unknown',
      runtime_adapter: inspected?.adapter_id || null,
      runtime,
      missing: missing.length > 0 ? missing : undefined,
    });
  }

  return agents;
}
