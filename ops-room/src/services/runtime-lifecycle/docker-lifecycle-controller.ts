import { execFileSync } from 'node:child_process';

const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function normalizeTimeoutSeconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(Math.max(Math.trunc(parsed), 1), 120);
}

export function createDockerAgentLifecycleController({ execFile = execFileSync } = {}) {
  return {
    id: 'docker-container-lifecycle',

    supports(preparedRuntime) {
      return preparedRuntime?.target?.kind === 'docker-container'
        && SAFE_CONTAINER_NAME.test(String(preparedRuntime.target.name || ''));
    },

    stop(preparedRuntime, { timeoutSeconds = 30 } = {}) {
      if (!this.supports(preparedRuntime)) {
        throw new Error('Docker lifecycle controller does not support this runtime target');
      }
      const timeout = normalizeTimeoutSeconds(timeoutSeconds);
      const containerName = preparedRuntime.target.name;
      try {
        execFile('docker', ['stop', '--time', String(timeout), containerName], {
          encoding: 'utf-8',
          timeout: (timeout + 10) * 1000,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        throw new Error('docker stop failed');
      }
      return {
        controller_id: this.id,
        action: 'stop',
        target_kind: 'docker-container',
      };
    },
  };
}
