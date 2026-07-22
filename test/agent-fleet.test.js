import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentFleet, getAgentFleet } from '../src/services/agent-fleet.js';
function profile(id, { enabled = true } = {}) {
    return {
        schemaVersion: 2,
        id,
        displayName: id.charAt(0).toUpperCase() + id.slice(1),
        profileVersion: '2.0.0',
        mission: `${id} responsibility`,
        personality: {
            communicationStyle: 'concise',
            decisionPolicy: ['use evidence'],
            constraints: ['stay bounded'],
        },
        runtime: { backend: 'opencode' },
        skills: [],
        memory: { read: [], write: [] },
        repositories: ['LihSheng/ops-room'],
        enabled,
    };
}
function runtime(key, status, extra = {}) {
    return {
        key,
        display_name: key.toUpperCase(),
        role: 'Test role',
        description: 'Test agent',
        backend: 'opencode',
        observed_state: status,
        desired_state: 'unmanaged',
        lifecycle_state: 'unmanaged',
        convergence_status: 'converged',
        convergence_reason_code: null,
        lifecycle_error: null,
        runtime: {
            status,
            health: status === 'running' ? 'healthy' : 'none',
            restart_count: 0,
            started_at: '2026-07-22T08:00:00.000Z',
        },
        ...extra,
    };
}
test('agent fleet joins profile, runtime, and current task into deterministic V2 states', () => {
    const result = buildAgentFleet({
        profiles: [profile('tokyo'), profile('berlin'), profile('professor'), profile('gemini', { enabled: false })],
        agents: [
            runtime('professor', 'running'),
            runtime('berlin', 'exited'),
            runtime('tokyo', 'running'),
            runtime('gemini', 'running'),
            runtime('orphan', 'running'),
        ],
        tasks: [
            {
                id: 'task-professor',
                agent: 'professor',
                status: 'RUNNING',
                task_text: 'Implement the fleet read model',
                repository: 'LihSheng/ops-room',
                updated_at: '2026-07-22T09:00:00.000Z',
            },
            {
                id: 'task-tokyo',
                agent: 'tokyo',
                status: 'NEEDS_HUMAN',
                task_text: 'Validate runtime evidence',
                repository: 'LihSheng/ops-room',
                updated_at: '2026-07-22T09:05:00.000Z',
            },
        ],
        generatedAt: '2026-07-22T09:10:00.000Z',
    });
    assert.deepEqual(result.fleet.map((agent) => agent.id), ['berlin', 'gemini', 'orphan', 'professor', 'tokyo']);
    assert.equal(result.fleet.find((agent) => agent.id === 'professor')?.state, 'working');
    assert.equal(result.fleet.find((agent) => agent.id === 'berlin')?.state, 'offline');
    assert.equal(result.fleet.find((agent) => agent.id === 'tokyo')?.state, 'needs_human');
    assert.equal(result.fleet.find((agent) => agent.id === 'gemini')?.state, 'unavailable');
    assert.equal(result.fleet.find((agent) => agent.id === 'orphan')?.attention.reason_code, 'profile_unavailable');
    assert.equal(result.generated_at, '2026-07-22T09:10:00.000Z');
    assert.equal(result.sources.missions, 'deferred_to_ops_012c');
});
test('agent fleet exposes bounded workspace evidence without absolute paths', () => {
    const result = buildAgentFleet({
        profiles: [profile('professor')],
        agents: [runtime('professor', 'running')],
        tasks: [{
                id: 'task-workspace',
                agent: 'professor',
                status: 'PAUSED',
                repository: 'LihSheng/ops-room',
                task_text: 'Paused implementation',
                updated_at: '2026-07-22T09:00:00.000Z',
                workspace: {
                    workspace_id: 'task-professor-1234',
                    mode: 'branch',
                    state: 'active',
                    repository_id: 'LihSheng/ops-room',
                    branch: 'agent/professor/ops-012b',
                    resolved_sha: 'a'.repeat(40),
                    relative_path: 'must-not-escape',
                    absolute_path: '/home/private/workspace',
                },
            }],
    });
    const professor = result.fleet[0];
    assert.equal(professor.state, 'paused');
    assert.deepEqual(professor.current_task.workspace, {
        workspace_id: 'task-professor-1234',
        mode: 'branch',
        state: 'active',
        repository_id: 'LihSheng/ops-room',
        branch: 'agent/professor/ops-012b',
        resolved_sha: 'a'.repeat(40),
        held_for_investigation: false,
        cleanup_requested: false,
    });
    assert.equal('absolute_path' in professor.current_task.workspace, false);
    assert.equal('relative_path' in professor.current_task.workspace, false);
});
test('fleet task observation degrades safely when the task store is unavailable', async () => {
    const result = await getAgentFleet({
        agents: [runtime('professor', 'running')],
        getProfiles: () => [profile('professor')],
        getTasks: async () => { throw new Error('sensitive filesystem detail'); },
        now: () => '2026-07-22T09:15:00.000Z',
    });
    assert.equal(result.fleet[0].state, 'idle');
    assert.equal(result.fleet[0].current_task, null);
    assert.equal(result.sources.tasks, 'unavailable');
    assert.equal(JSON.stringify(result).includes('sensitive filesystem detail'), false);
});
//# sourceMappingURL=agent-fleet.test.js.map