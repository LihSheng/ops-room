import { execFileSync } from 'node:child_process';
import { POLL_AGENTS } from '../lib/config.mjs';

const OPENAB_INSTANCE_MAP = [
  {
    agent: 'professor',
    displayName: 'Professor',
    service: 'opencode-professor',
    containerName: 'openab-opencode-professor',
    backend: 'opencode',
    image: 'ghcr.io/openabdev/openab-opencode:latest',
    configPath: 'config/agents/opencode-professor.toml',
    dataDir: 'data/agents/opencode-professor',
  },
  {
    agent: 'berlin',
    displayName: 'Berlin',
    service: 'opencode-1',
    containerName: 'openab-opencode-1',
    backend: 'opencode',
    image: 'ghcr.io/openabdev/openab-opencode:latest',
    configPath: 'config/agents/opencode-1.toml',
    dataDir: 'data/agents/opencode-1',
  },
  {
    agent: 'tokyo',
    displayName: 'Tokyo',
    service: 'opencode-2',
    containerName: 'openab-opencode-2',
    backend: 'opencode',
    image: 'ghcr.io/openabdev/openab-opencode:latest',
    configPath: 'config/agents/opencode-2.toml',
    dataDir: 'data/agents/opencode-2',
  },
  {
    agent: 'gemini',
    displayName: 'Gemini',
    service: 'gemini',
    containerName: 'openab-gemini',
    backend: 'gemini',
    image: 'ghcr.io/openabdev/openab-gemini:latest',
    configPath: 'config/agents/gemini.toml',
    dataDir: 'data/agents/gemini',
  },
];

let cachedDockerStatus = null;
let cachedDockerStatusAt = 0;
const DOCKER_STATUS_CACHE_MS = 5000;

function dockerAvailable() {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function getDockerStatusByContainerName(containerNames) {
  if (containerNames.length === 0) return {};

  let raw;
  try {
    raw = execFileSync('docker', ['inspect', ...containerNames], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.stdout) {
      raw = e.stdout;
    } else {
      return {};
    }
  }

  try {
    const containers = JSON.parse(raw);
    const statusMap = {};

    for (const c of containers) {
      const name = (c.Name || '').replace(/^\//, '');
      const state = c.State || {};
      const health = state.Health || {};

      statusMap[name] = {
        status: state.Status || 'unknown',
        state: state.Status || 'unknown',
        started_at: state.StartedAt || null,
        finished_at: state.FinishedAt || null,
        restart_count: c.RestartCount != null ? c.RestartCount : 0,
        health: health.Status || (state.Running ? 'none' : 'unknown'),
        exit_code: state.ExitCode != null ? state.ExitCode : null,
        oom_killed: !!state.OOMKilled,
      };
    }

    for (const name of containerNames) {
      if (!statusMap[name]) {
        statusMap[name] = {
          status: 'missing',
          state: 'missing',
          health: 'unknown',
        };
      }
    }

    return statusMap;
  } catch {
    return {};
  }
}

function getDockerStatus() {
  const now = Date.now();
  if (cachedDockerStatus && now - cachedDockerStatusAt < DOCKER_STATUS_CACHE_MS) {
    return cachedDockerStatus;
  }

  const available = dockerAvailable();
  let dockerError = null;
  let statusMap = {};

  if (available) {
    const names = OPENAB_INSTANCE_MAP.map(i => i.containerName);
    statusMap = getDockerStatusByContainerName(names);
  } else {
    dockerError = 'docker command not available or permission denied';
  }

  cachedDockerStatus = {
    available,
    error: dockerError,
    statusMap,
    fetchedAt: now,
  };
  cachedDockerStatusAt = now;
  return cachedDockerStatus;
}

export function getOpenABInstances() {
  const { available, error, statusMap } = getDockerStatus();

  const instances = OPENAB_INSTANCE_MAP.map(entry => {
    const runtime = statusMap[entry.containerName] || {
      status: 'unknown',
      state: 'unknown',
      health: 'unknown',
    };

    return {
      agent: entry.agent,
      display_name: entry.displayName,
      service: entry.service,
      container_name: entry.containerName,
      backend: entry.backend,
      image: entry.image,
      config_path: entry.configPath,
      data_dir: entry.dataDir,
      github_polling_enabled: POLL_AGENTS.includes(entry.agent),
      runtime,
      links: {
        logs: `/api/logs?agent=${entry.agent}`,
        tasks: '/api/tasks',
      },
    };
  });

  return {
    instances,
    docker: {
      available,
      error,
    },
  };
}
