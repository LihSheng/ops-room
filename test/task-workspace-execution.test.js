import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTaskInWorkspace } from '../src/services/task-workspace-execution.js';
function reviewTask(overrides = {}) {
    return {
        id: 'review-ops-room-32-berlin',
        kind: 'review',
        state: 'CLAIMED',
        repository: 'ops-room',
        agent: 'berlin',
        reviewed_sha: 'a'.repeat(40),
        ...overrides,
    };
}
function binding(reused = false) {
    return {
        reused,
        workspace_path: '/workspaces/berlin/task-1',
        record: {
            workspace_id: 'task-1',
            task_id: 'review-ops-room-32-berlin',
            owner_agent: 'berlin',
            repository_id: 'ops-room',
            mode: 'detached',
            branch: null,
            resolved_sha: 'a'.repeat(40),
            relative_path: 'berlin/task-1',
            state: 'active',
        },
    };
}
test('persists workspace before execution and cleans up after durable success', async () => {
    const events = [];
    const transitions = [];
    const result = await executeTaskInWorkspace({
        task: reviewTask(),
        taskDir: '/tasks',
        cacheRoot: '/cache',
        workspaceRoot: '/workspaces',
        recordRoot: '/records',
        lockRoot: '/locks',
        remote: 'unused',
        ensureWorkspace: async () => { events.push('ensure'); return binding(false); },
        transition: async (input) => {
            transitions.push(input);
            events.push(`transition:${input.to}`);
            return { ...reviewTask(), ...input.patch, state: input.to };
        },
        execute: async ({ cwd, task }) => {
            events.push('execute');
            assert.equal(cwd, '/workspaces/berlin/task-1');
            assert.equal(task.workspace_id, 'task-1');
            return { state: 'PASSED', patch: { review_result: 'approved' } };
        },
        applyOutcome: async ({ task }) => {
            events.push('outcome');
            assert.equal(task.state, 'PASSED');
            return { action: 'cleanup', workspace: { state: 'cleanup_requested' } };
        },
    });
    assert.deepEqual(events, ['ensure', 'transition:RUNNING', 'execute', 'transition:PASSED', 'outcome']);
    assert.equal(transitions[0].patch.workspace_id, 'task-1');
    assert.equal(result.workspace_action, 'cleanup');
    assert.equal(result.workspace_reused, false);
});
test('provider failure durably transitions to ERROR before investigation hold', async () => {
    const events = [];
    const result = await executeTaskInWorkspace({
        task: reviewTask(),
        taskDir: '/tasks',
        cacheRoot: '/cache',
        workspaceRoot: '/workspaces',
        recordRoot: '/records',
        lockRoot: '/locks',
        remote: 'unused',
        ensureWorkspace: async () => binding(true),
        transition: async (input) => {
            events.push(`transition:${input.to}`);
            return { ...reviewTask(), ...input.patch, state: input.to };
        },
        execute: async () => { events.push('execute'); throw new Error('provider_failed'); },
        applyOutcome: async ({ task }) => {
            events.push('outcome');
            assert.equal(task.state, 'ERROR');
            assert.equal(task.last_error, 'provider_failed');
            return { action: 'hold', workspace: { state: 'held_for_investigation' } };
        },
    });
    assert.deepEqual(events, ['transition:RUNNING', 'execute', 'transition:ERROR', 'outcome']);
    assert.equal(result.workspace_action, 'hold');
    assert.equal(result.workspace_reused, true);
});
test('fix tasks enter FIXING and execute from their writable worktree', async () => {
    let activeState = null;
    await executeTaskInWorkspace({
        task: reviewTask({ kind: 'fix', state: 'CLAIMED', agent: 'professor' }),
        taskDir: '/tasks',
        cacheRoot: '/cache',
        workspaceRoot: '/workspaces',
        recordRoot: '/records',
        lockRoot: '/locks',
        remote: 'unused',
        ensureWorkspace: async () => ({
            reused: false,
            workspace_path: '/workspaces/professor/task-2',
            record: {
                ...binding().record,
                workspace_id: 'task-2',
                task_id: 'review-ops-room-32-berlin',
                owner_agent: 'professor',
                mode: 'branch',
                branch: 'agent/professor/fix-32',
                relative_path: 'professor/task-2',
            },
        }),
        transition: async (input) => {
            if (!activeState)
                activeState = input.to;
            return { ...reviewTask({ kind: 'fix', agent: 'professor' }), ...input.patch, state: input.to };
        },
        execute: async ({ cwd }) => {
            assert.equal(cwd, '/workspaces/professor/task-2');
            return { state: 'FIX_PUSHED' };
        },
        applyOutcome: async () => ({ action: 'cleanup', workspace: { state: 'cleanup_requested' } }),
    });
    assert.equal(activeState, 'FIXING');
});
test('invalid terminal provider result is converted to ERROR and held', async () => {
    let terminal = null;
    await executeTaskInWorkspace({
        task: reviewTask(),
        taskDir: '/tasks',
        cacheRoot: '/cache',
        workspaceRoot: '/workspaces',
        recordRoot: '/records',
        lockRoot: '/locks',
        remote: 'unused',
        ensureWorkspace: async () => binding(false),
        transition: async (input) => {
            terminal = input.to;
            return { ...reviewTask(), ...input.patch, state: input.to };
        },
        execute: async () => ({ state: 'RUNNING' }),
        applyOutcome: async ({ task }) => {
            assert.equal(task.state, 'ERROR');
            assert.equal(task.last_error, 'task_workspace_terminal_state_invalid');
            return { action: 'hold', workspace: { state: 'held_for_investigation' } };
        },
    });
    assert.equal(terminal, 'ERROR');
});
//# sourceMappingURL=task-workspace-execution.test.js.map