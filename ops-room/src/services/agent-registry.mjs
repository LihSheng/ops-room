import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_NAMES, BOT_USERS, POLL_AGENTS } from '../lib/config.mjs';
import { AGENT_DEFINITIONS } from './agent-definitions.mjs';
import { getOpenABInstances } from './openab-instances.mjs';
import { AGENTS_CONFIG_DIR } from './runtime-paths.mjs';

async function configExists(configDir) {
  try {
    await access(configDir);
    return true;
  } catch {
    return false;
  }
}

export async function getAgentList({ getRuntimeSnapshot = getOpenABInstances } = {}) {
  const agents = [];
  const runtimeSnapshot = getRuntimeSnapshot();
  const runtimeByAgent = new Map(
    (runtimeSnapshot.instances || []).map((instance) => [instance.agent, instance.runtime]),
  );

  for (const definition of AGENT_DEFINITIONS) {
    const { key } = definition;
    const configPath = `config/agents/${definition.configName}.toml`;
    const exampleConfigPath = `config/agents/${definition.configName}.example.toml`;

    const hasConfig = await configExists(join(AGENTS_CONFIG_DIR, `${definition.configName}.toml`));
    const hasExample = await configExists(join(AGENTS_CONFIG_DIR, `${definition.configName}.example.toml`));

    const missing = [];
    if (!hasConfig) missing.push(configPath);
    if (!hasExample) missing.push(exampleConfigPath);

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
      desired_state: definition.desiredState,
      observed_state: runtimeByAgent.get(key)?.status || 'unknown',
      runtime: runtimeByAgent.get(key) || null,
      missing: missing.length > 0 ? missing : undefined,
    });
  }

  return agents;
}
