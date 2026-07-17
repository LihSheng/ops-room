import { execFileSync } from 'node:child_process';
import { POLL_AGENTS } from '../lib/config.js';
import { AGENT_DEFINITIONS } from './agent-definitions.js';

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
    const names = AGENT_DEFINITIONS.map(i => i.containerName);
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

  const instances = AGENT_DEFINITIONS.map(entry => {
    const runtime = statusMap[entry.containerName] || {
      status: 'unknown',
      state: 'unknown',
      health: 'unknown',
    };

    return {
      agent: entry.key,
      display_name: entry.displayName,
      role: entry.role,
      description: entry.description,
      service: entry.service,
      container_name: entry.containerName,
      backend: entry.backend,
      image: entry.image,
      config_path: `config/agents/${entry.configName}.toml`,
      data_dir: entry.dataDir,
      github_polling_enabled: POLL_AGENTS.includes(entry.key),
      desired_state: entry.desiredState,
      observed_state: runtime.status || 'unknown',
      runtime,
      links: {
        logs: `/api/logs?agent=${entry.key}`,
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
