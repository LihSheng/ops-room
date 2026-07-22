import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
const SAFE_LOCK = /^[A-Za-z0-9._-]{1,160}$/;
export async function withWorkspaceLock({ dir, name, execute, timeoutMs = 10_000, staleAfterMs = 60_000, pollMs = 50, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), }) {
    if (!SAFE_LOCK.test(name))
        throw new Error('invalid_workspace_lock_name');
    await mkdir(dir, { recursive: true });
    const lockPath = join(dir, `${name}.lock`);
    const started = now();
    while (true) {
        try {
            const handle = await open(lockPath, 'wx', 0o600);
            await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
            await handle.close();
            try {
                return await execute();
            }
            finally {
                await rm(lockPath, { force: true });
            }
        }
        catch (error) {
            if (error?.code !== 'EEXIST')
                throw error;
            try {
                const info = await stat(lockPath);
                if (now() - info.mtimeMs > staleAfterMs) {
                    await readFile(lockPath, 'utf8').catch(() => '');
                    await rm(lockPath, { force: true });
                    continue;
                }
            }
            catch (statError) {
                if (statError?.code === 'ENOENT')
                    continue;
                throw statError;
            }
            if (now() - started >= timeoutMs)
                throw new Error('workspace_lock_timeout');
            await sleep(pollMs);
        }
    }
}
//# sourceMappingURL=workspace-locks.js.map