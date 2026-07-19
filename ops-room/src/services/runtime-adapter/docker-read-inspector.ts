import { execFileSync } from 'node:child_process';

import { unknownRuntimeStatus, type RuntimeStatus } from './types.js';

const DEFAULT_CACHE_MS = 5000;

function normalizeContainerNames(containerNames: string[]) {
  return [...new Set(containerNames.map((name) => String(name || '').trim()).filter(Boolean))].sort();
}

function parseInspectOutput(raw: string, containerNames: string[]) {
  const statusByContainer: Record<string, RuntimeStatus> = {};
  const containers = JSON.parse(raw || '[]');

  for (const container of containers) {
    const name = String(container?.Name || '').replace(/^\//, '');
    if (!name) continue;
    const state = container?.State || {};
    const health = state?.Health || {};
    statusByContainer[name] = {
      status: state.Status || 'unknown',
      state: state.Status || 'unknown',
      started_at: state.StartedAt || null,
      finished_at: state.FinishedAt || null,
      restart_count: container.RestartCount != null ? container.RestartCount : 0,
      health: health.Status || (state.Running ? 'none' : 'unknown'),
      exit_code: state.ExitCode != null ? state.ExitCode : null,
      oom_killed: Boolean(state.OOMKilled),
    };
  }

  for (const name of containerNames) {
    if (!statusByContainer[name]) {
      statusByContainer[name] = unknownRuntimeStatus({ status: 'missing', state: 'missing' });
    }
  }

  return statusByContainer;
}

export function createDockerReadInspector({
  execFile = execFileSync,
  now = () => Date.now(),
  cacheMs = DEFAULT_CACHE_MS,
} = {}) {
  let cachedResult = null;
  let cachedAt = 0;
  let cachedKey = '';

  return {
    inspect(containerNames: string[]) {
      const names = normalizeContainerNames(containerNames);
      const key = names.join('\0');
      const currentTime = now();
      if (cachedResult && key === cachedKey && currentTime - cachedAt < cacheMs) {
        return cachedResult;
      }

      let available = false;
      try {
        execFile('docker', ['info', '--format', '{{.ServerVersion}}'], {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        available = true;
      } catch {
        available = false;
      }

      let error = null;
      let statusByContainer: Record<string, RuntimeStatus> = {};

      if (!available) {
        error = 'docker command not available or permission denied';
      } else if (names.length > 0) {
        let raw = '';
        try {
          raw = String(execFile('docker', ['inspect', ...names], {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
          }) || '');
        } catch (inspectionError) {
          const stdout = inspectionError?.stdout;
          raw = typeof stdout === 'string' ? stdout : stdout?.toString?.('utf-8') || '';
        }

        try {
          statusByContainer = parseInspectOutput(raw, names);
        } catch {
          error = 'docker inspection returned invalid data';
          statusByContainer = Object.fromEntries(
            names.map((name) => [name, unknownRuntimeStatus()]),
          );
        }
      }

      const result = {
        available,
        error,
        status_by_container: statusByContainer,
        fetched_at: currentTime,
      };
      cachedResult = result;
      cachedAt = currentTime;
      cachedKey = key;
      return result;
    },
  };
}
