import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_NAMES, BOT_USERS, POLL_AGENTS } from '../lib/config.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

// Explicit mapping for known agents.
// In the future this could parse docker-compose.yml.
const AGENT_CONFIG_MAP = {
  professor: { configName: 'opencode-professor', containerName: 'openab-opencode-professor' },
  berlin:    { configName: 'opencode-1',         containerName: 'openab-opencode-1' },
  tokyo:     { configName: 'opencode-2',         containerName: 'openab-opencode-2' },
  gemini:    { configName: 'gemini',             containerName: 'openab-gemini' },
};

async function configExists(configDir) {
  try {
    await access(configDir);
    return true;
  } catch {
    return false;
  }
}

export async function getAgentList() {
  const agents = [];

  for (const [key, info] of Object.entries(AGENT_CONFIG_MAP)) {
    const configPath = `config/agents/${info.configName}.toml`;
    const exampleConfigPath = `config/agents/${info.configName}.example.toml`;

    const hasConfig = await configExists(join(REPO_ROOT, configPath));
    const hasExample = await configExists(join(REPO_ROOT, exampleConfigPath));

    const missing = [];
    if (!hasConfig) missing.push(configPath);
    if (!hasExample) missing.push(exampleConfigPath);

    agents.push({
      key,
      display_name: AGENT_NAMES[key] || key.charAt(0).toUpperCase() + key.slice(1),
      backend: info.configName.startsWith('opencode') ? 'opencode' : 'gemini',
      config_path: configPath,
      example_config_path: exampleConfigPath,
      container_name: info.containerName,
      github_app_bot_user: BOT_USERS[key] || `lihsheng-${key}[bot]`,
      enabled: hasConfig,
      github_polling_enabled: POLL_AGENTS.includes(key),
      missing: missing.length > 0 ? missing : undefined,
    });
  }

  return agents;
}
