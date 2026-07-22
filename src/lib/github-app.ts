import { execFileSync } from 'node:child_process';
import { GITHUB_APP_CONFIG } from './config.js';

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const tokenCache = new Map();

export function githubEnvForAgent(agentKey, processEnv = process.env) {
  const cfg = GITHUB_APP_CONFIG[agentKey] || GITHUB_APP_CONFIG.professor;
  const appId = processEnv[cfg.appId];
  const installationId = processEnv[cfg.installationId];
  const keyPath = processEnv[cfg.keyPath];
  const botUser = processEnv[cfg.botUser];

  if (!appId || !installationId || !keyPath) {
    return null;
  }

  return {
    GITHUB_APP_ID: appId,
    GITHUB_APP_INSTALLATION_ID: installationId,
    GITHUB_APP_KEY_PATH: keyPath,
    GITHUB_APP_BOT_USER: botUser || 'bot',
  };
}

function fetchTokenForAgent(agentKey, tokenScriptPath, processEnv) {
  const env = githubEnvForAgent(agentKey, processEnv);
  if (!env) throw new Error(`missing GitHub App config for ${agentKey}`);

  const tokenResult = execFileSync(
    'node',
    [tokenScriptPath],
    {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...processEnv, ...env },
    },
  ).trim();

  return JSON.parse(tokenResult);
}

export function getTokenForAgent(agentKey, tokenScriptPath, processEnv = process.env) {
  const cached = tokenCache.get(agentKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const parsed = fetchTokenForAgent(agentKey, tokenScriptPath, processEnv);

  tokenCache.set(agentKey, {
    token: parsed.token,
    expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
  });

  return parsed.token;
}

export function clearTokenCache() {
  tokenCache.clear();
}
