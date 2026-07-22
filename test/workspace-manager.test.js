import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { allocateWorkspace, cleanupWorkspace, requestWorkspaceCleanup } from '../src/services/workspace-manager.js';
import { readWorkspaceRecord } from '../src/services/workspace-store.js';
const run = promisify(execFile);
async function git(args, cwd) {
    const result = await run('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return String(result.stdout || '').trim();
}
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-workspaces-'));
    const source = join(root, 'source');
    await git(['init', source], root);
    await git(['config', 'user.email', 'ops-room@example.invalid'], source);
    await git(['config', 'user.name', 'Ops Room Test'], source);
    await writeFile(join(source, 'README.md'), 'base\n');
    await git(['add', 'README.md'], source);
    await git(['commit', '-m', 'initial'], source);
    const sha = await git(['rev-parse', 'HEAD'], source);
    return {
        root,
        source,
        sha,
        cacheRoot: join(root, 'repositories'),
        workspaceRoot: join(root, 'workspaces'),
        recordRoot: join(root, 'records'),
        lockRoot: join(root, 'locks'),
    };
}
function allocation(f, overrides = {}) {
    return allocateWorkspace({
        cacheRoot: f.cacheRoot,
        workspaceRoot: f.workspaceRoot,
        recordRoot: f.recordRoot,
        lockRoot: f.lockRoot,
        repositoryId: 'ops-room-test',
        remote: f.source,
        workspaceId: overrides.workspaceId || 'workspace-1',
        ownerAgent: overrides.ownerAgent || 'professor',
        taskId: overrides.taskId || 'task-1',
        mode: overrides.mode || 'detached',
        branch: overrides.branch || null,
        revision: overrides.revision || f.sha,
        minimumFreeBytes: 0,
        maxActiveWorkspaces: 8,
    });
}
test('detached workspace is pinned to the requested exact SHA', async () => {
    const f = await fixture();
    const record = await allocation(f);
    assert.equal(record.state, 'active');
    assert.equal(record.mode, 'detached');
    assert.equal(record.resolved_sha, f.sha);
    const checkedOut = await git(['rev-parse', 'HEAD'], join(f.workspaceRoot, record.relative_path));
    assert.equal(checkedOut, f.sha);
});
test('two detached workspaces are isolated while sharing one bare cache', async () => {
    const f = await fixture();
    const first = await allocation(f, { workspaceId: 'review-1', ownerAgent: 'berlin', taskId: 'review-1' });
    const second = await allocation(f, { workspaceId: 'review-2', ownerAgent: 'tokyo', taskId: 'review-2' });
    await writeFile(join(f.workspaceRoot, first.relative_path, 'LOCAL.txt'), 'only first\n');
    await assert.rejects(readFile(join(f.workspaceRoot, second.relative_path, 'LOCAL.txt'), 'utf8'));
    assert.equal(await git(['rev-parse', 'HEAD'], join(f.workspaceRoot, second.relative_path)), f.sha);
});
test('writable branch ownership conflict is rejected before a second worktree is created', async () => {
    const f = await fixture();
    await allocation(f, {
        workspaceId: 'write-1', ownerAgent: 'professor', taskId: 'task-1', mode: 'branch', branch: 'agent/professor/task-1', revision: f.sha,
    });
    await assert.rejects(allocation(f, {
        workspaceId: 'write-2', ownerAgent: 'tokyo', taskId: 'task-2', mode: 'branch', branch: 'agent/professor/task-1', revision: f.sha,
    }), /workspace_branch_owned/);
});
test('cleanup requires a durable request and is idempotent after release', async () => {
    const f = await fixture();
    const record = await allocation(f);
    await requestWorkspaceCleanup({ recordRoot: f.recordRoot, workspaceId: record.workspace_id });
    const released = await cleanupWorkspace({
        cacheRoot: f.cacheRoot,
        workspaceRoot: f.workspaceRoot,
        recordRoot: f.recordRoot,
        lockRoot: f.lockRoot,
        workspaceId: record.workspace_id,
    });
    assert.equal(released.state, 'released');
    const replay = await cleanupWorkspace({
        cacheRoot: f.cacheRoot,
        workspaceRoot: f.workspaceRoot,
        recordRoot: f.recordRoot,
        lockRoot: f.lockRoot,
        workspaceId: record.workspace_id,
    });
    assert.equal(replay.state, 'released');
    assert.equal((await readWorkspaceRecord({ dir: f.recordRoot, workspaceId: record.workspace_id })).state, 'released');
});
test('capacity and exact-SHA rules fail closed', async () => {
    const f = await fixture();
    await allocation(f, { workspaceId: 'one' });
    await assert.rejects(allocateWorkspace({
        cacheRoot: f.cacheRoot,
        workspaceRoot: f.workspaceRoot,
        recordRoot: f.recordRoot,
        lockRoot: f.lockRoot,
        repositoryId: 'ops-room-test',
        remote: f.source,
        workspaceId: 'two',
        ownerAgent: 'berlin',
        taskId: 'two',
        mode: 'detached',
        revision: f.sha,
        maxActiveWorkspaces: 1,
    }), /workspace_capacity_exceeded/);
    await assert.rejects(allocation(f, { workspaceId: 'bad-sha', revision: 'main' }), /detached_workspace_requires_exact_sha/);
});
//# sourceMappingURL=workspace-manager.test.js.map