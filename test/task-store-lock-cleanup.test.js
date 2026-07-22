import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupStaleLocks } from '../src/services/task-store.js';
test('startup cleanup removes dead issue locks and preserves live owners', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-room-locks-'));
    try {
        await writeFile(join(dir, 'issue-dead.lock'), JSON.stringify({ harnessPid: 101 }));
        await writeFile(join(dir, 'issue-live.lock'), JSON.stringify({ harnessPid: 202 }));
        await writeFile(join(dir, 'not-a-lock.txt'), 'ignored');
        const removed = await cleanupStaleLocks({
            lockDir: dir,
            processAlive: (pid) => pid === 202,
        });
        assert.deepEqual(removed, ['issue-dead.lock']);
        assert.match(await readFile(join(dir, 'issue-live.lock'), 'utf-8'), /202/);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=task-store-lock-cleanup.test.js.map