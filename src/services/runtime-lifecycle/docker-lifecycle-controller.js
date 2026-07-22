import { spawn } from 'node:child_process';
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function normalizeTimeoutSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 20;
    return Math.min(Math.max(Math.trunc(parsed), 1), 120);
}
function runBoundedCommand(command, args, { timeoutMs }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(command, args, {
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
        });
        const finish = (error = null) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else
                resolve();
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(new Error('runtime command timed out'));
        }, timeoutMs);
        child.once('error', () => finish(new Error('runtime command failed')));
        child.once('close', (code) => {
            if (code === 0)
                finish();
            else
                finish(new Error('runtime command failed'));
        });
    });
}
export function createDockerAgentLifecycleController({ runCommand = runBoundedCommand } = {}) {
    return {
        id: 'docker-container-lifecycle',
        supports(preparedRuntime) {
            return preparedRuntime?.target?.kind === 'docker-container'
                && SAFE_CONTAINER_NAME.test(String(preparedRuntime.target.name || ''));
        },
        async stop(preparedRuntime, { timeoutSeconds = 20 } = {}) {
            if (!this.supports(preparedRuntime)) {
                throw new Error('Docker lifecycle controller does not support this runtime target');
            }
            const timeout = normalizeTimeoutSeconds(timeoutSeconds);
            const containerName = preparedRuntime.target.name;
            try {
                await runCommand('docker', ['stop', '--time', String(timeout), containerName], { timeoutMs: (timeout + 5) * 1000 });
            }
            catch {
                throw new Error('docker stop failed');
            }
            return {
                controller_id: this.id,
                action: 'stop',
                target_kind: 'docker-container',
            };
        },
        async start(preparedRuntime, { timeoutSeconds = 20 } = {}) {
            if (!this.supports(preparedRuntime)) {
                throw new Error('Docker lifecycle controller does not support this runtime target');
            }
            const timeout = normalizeTimeoutSeconds(timeoutSeconds);
            const containerName = preparedRuntime.target.name;
            try {
                await runCommand('docker', ['start', containerName], { timeoutMs: (timeout + 5) * 1000 });
            }
            catch {
                throw new Error('docker start failed');
            }
            return {
                controller_id: this.id,
                action: 'start',
                target_kind: 'docker-container',
            };
        },
    };
}
//# sourceMappingURL=docker-lifecycle-controller.js.map