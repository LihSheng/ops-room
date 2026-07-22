import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';
import { createOrClaimTask, readTask, transitionTask } from '../src/services/review-task-store.js';
async function availablePort() {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}
async function waitForHealth(url) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch(url);
            if (response.ok)
                return;
        }
        catch { }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('server did not become healthy');
}
function startServer({ root, port, operatorEnabled }) {
    return spawn(process.execPath, ['src/server/webhook.js'], {
        cwd: new URL('../', import.meta.url),
        env: {
            ...process.env,
            OPENAB_WEBHOOK_SECRET: 'operator-http-test',
            OPENAB_WEBHOOK_HOST: '127.0.0.1',
            OPENAB_WEBHOOK_PORT: String(port),
            OPS_ROOM_RELEASE_SHA: 'e'.repeat(40),
            OPS_ROOM_REQUIRED_COMMANDS: '',
            OPS_ROOM_ISSUE_POLLING_ENABLED: 'false',
            OPS_ROOM_OPERATOR_API_ENABLED: operatorEnabled ? 'true' : 'false',
            OPS_ROOM_OPERATOR_TOKEN: 'operator-test-token',
            OPS_ROOM_OPERATOR_ID: 'lihsheng',
            OPS_ROOM_OPERATOR_DISPLAY_NAME: 'Lih Sheng',
            OPS_ROOM_DATA_DIR: join(root, 'ops-room'),
            OPS_ROOM_REVIEW_TASKS_DIR: join(root, 'ops-room', 'review-tasks'),
            OPENAB_DATA_DIR: join(root, 'data'),
            OPENAB_WORKSPACES_DIR: join(root, 'workspaces'),
            OPENAB_AGENTS_CONFIG_DIR: join(root, 'config'),
            OPENAB_REVIEW_MAX_GLOBAL: '0',
        },
        stdio: 'pipe',
    });
}
async function stopServer(child) {
    if (child.exitCode === null)
        child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null)
        child.kill('SIGKILL');
}
function operatorPost(base, path, payload, token = 'operator-test-token') {
    return fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
    });
}
async function createTask(reviewTasksDir, sha, policy = {}) {
    return (await createOrClaimTask({
        dir: reviewTasksDir,
        input: {
            repository: 'LihSheng/ops-room', pr: 42, headSha: sha, agent: 'professor', mode: 'review',
        },
        policy,
    })).task;
}
async function moveToError(reviewTasksDir, task) {
    await transitionTask({ dir: reviewTasksDir, id: task.id, to: 'CLAIMED', reason: 'test' });
    await transitionTask({ dir: reviewTasksDir, id: task.id, to: 'RUNNING', reason: 'test' });
    await transitionTask({ dir: reviewTasksDir, id: task.id, to: 'ERROR', reason: 'test' });
}
test('operator cancellation requires authentication and replays an identical request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-http-'));
    const reviewTasksDir = join(root, 'ops-room', 'review-tasks');
    const port = await availablePort();
    const child = startServer({ root, port, operatorEnabled: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
        const base = `http://127.0.0.1:${port}`;
        await waitForHealth(`${base}/health`);
        const task = await createTask(reviewTasksDir, 'f'.repeat(40));
        const taskPath = `/api/operator/tasks/${task.id}/cancel`;
        const payload = { reason: 'Duplicate task', idempotency_key: 'http-cancel-0001' };
        const unauthorized = await operatorPost(base, taskPath, payload, '');
        assert.equal(unauthorized.status, 401);
        const first = await operatorPost(base, taskPath, payload);
        assert.equal(first.status, 202, stderr);
        const firstBody = await first.json();
        assert.equal(firstBody.idempotent_replay, false);
        const second = await operatorPost(base, taskPath, payload);
        assert.equal(second.status, 202);
        const secondBody = await second.json();
        assert.equal(secondBody.idempotent_replay, true);
        assert.equal(secondBody.audit_event_id, firstBody.audit_event_id);
        const auditResponse = await fetch(`${base}/api/audit-events?operation=task.cancel`, {
            headers: { Authorization: 'Bearer operator-test-token' },
        });
        assert.equal(auditResponse.status, 200);
        const auditBody = await auditResponse.json();
        assert.equal(auditBody.events.length, 1);
        assert.equal(auditBody.events[0].actor.actor_id, 'lihsheng');
    }
    finally {
        await stopServer(child);
        await rm(root, { recursive: true, force: true });
    }
});
test('canonical retry pause resume endpoints use the audited idempotent contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-http-actions-'));
    const reviewTasksDir = join(root, 'ops-room', 'review-tasks');
    const port = await availablePort();
    const child = startServer({ root, port, operatorEnabled: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
        const base = `http://127.0.0.1:${port}`;
        await waitForHealth(`${base}/health`);
        const task = await createTask(reviewTasksDir, '1'.repeat(40));
        const pause = await operatorPost(base, `/api/operator/tasks/${task.id}/pause`, {
            reason: 'Wait for approval', idempotency_key: 'http-pause-00001',
        });
        assert.equal(pause.status, 202, stderr);
        assert.equal((await pause.json()).task.state, 'PAUSED');
        const resumePayload = { reason: 'Approval received', idempotency_key: 'http-resume-0001' };
        const resume = await operatorPost(base, `/api/operator/tasks/${task.id}/resume`, resumePayload);
        assert.equal(resume.status, 202, stderr);
        const resumeBody = await resume.json();
        assert.equal(resumeBody.task.state, 'QUEUED');
        assert.equal(resumeBody.idempotent_replay, false);
        const replay = await operatorPost(base, `/api/operator/tasks/${task.id}/resume`, resumePayload);
        assert.equal(replay.status, 202);
        assert.equal((await replay.json()).idempotent_replay, true);
        await moveToError(reviewTasksDir, task);
        const retry = await operatorPost(base, `/api/operator/tasks/${task.id}/retry`, {
            reason: 'Dependency recovered', idempotency_key: 'http-retry-00001',
        });
        assert.equal(retry.status, 202, stderr);
        const retryBody = await retry.json();
        assert.equal(retryBody.task.state, 'QUEUED');
        assert.equal(retryBody.task.attempt, 1);
        const auditResponse = await fetch(`${base}/api/audit-events?target_id=${encodeURIComponent(task.id)}`, {
            headers: { Authorization: 'Bearer operator-test-token' },
        });
        assert.equal(auditResponse.status, 200);
        const operations = (await auditResponse.json()).events.map((event) => event.operation).sort();
        assert.deepEqual(operations, ['task.pause', 'task.resume', 'task.retry']);
    }
    finally {
        await stopServer(child);
        await rm(root, { recursive: true, force: true });
    }
});
test('legacy review-task mutation aliases enforce reason and idempotency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-http-alias-'));
    const reviewTasksDir = join(root, 'ops-room', 'review-tasks');
    const port = await availablePort();
    const child = startServer({ root, port, operatorEnabled: true });
    try {
        const base = `http://127.0.0.1:${port}`;
        await waitForHealth(`${base}/health`);
        const task = await createTask(reviewTasksDir, '2'.repeat(40));
        const invalid = await operatorPost(base, `/api/review-tasks/${task.id}/pause`, { reason: 'Missing key' });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).error_code, 'invalid_request');
        const valid = await operatorPost(base, `/api/review-tasks/${task.id}/pause`, {
            reason: 'Compatibility alias', idempotency_key: 'legacy-pause-001',
        });
        assert.equal(valid.status, 202);
        assert.equal((await valid.json()).operation, 'task.pause');
        assert.equal((await readTask({ dir: reviewTasksDir, id: task.id })).state, 'PAUSED');
    }
    finally {
        await stopServer(child);
        await rm(root, { recursive: true, force: true });
    }
});
test('operator endpoints remain hidden when mutation API is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ops-room-operator-disabled-'));
    const port = await availablePort();
    const child = startServer({ root, port, operatorEnabled: false });
    try {
        const base = `http://127.0.0.1:${port}`;
        await waitForHealth(`${base}/health`);
        const auditResponse = await fetch(`${base}/api/audit-events`, {
            headers: { Authorization: 'Bearer operator-test-token' },
        });
        assert.equal(auditResponse.status, 404);
        const actionResponse = await operatorPost(base, '/api/operator/tasks/missing/retry', {
            reason: 'Hidden mutation', idempotency_key: 'hidden-retry-001',
        });
        assert.equal(actionResponse.status, 404);
    }
    finally {
        await stopServer(child);
        await rm(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=operator-http.test.js.map