import { getAgentList } from './agent-registry.js';
import { listAgentProfiles } from './agent-profile/registry.js';
import { toPublicAgentProfile } from './agent-profile/public-profile.js';
import { readTasksDir } from './task-store.js';
export const AGENT_FLEET_STATES = Object.freeze([
    'offline',
    'idle',
    'working',
    'waiting',
    'paused',
    'needs_human',
    'unavailable',
]);
const WORKING_TASK_STATES = new Set([
    'CLAIMED',
    'RUNNING',
    'IN_PROGRESS',
    'REVIEWING',
    'FIXING',
    'CANCELLING',
]);
const WAITING_TASK_STATES = new Set(['PENDING', 'QUEUED', 'FIX_QUEUED']);
const PAUSED_TASK_STATES = new Set(['PAUSED']);
const ATTENTION_TASK_STATES = new Set([
    'ERROR',
    'FAILED',
    'CHANGES_REQUESTED',
    'NEEDS_HUMAN',
    'BLOCKED',
    'STALE',
]);
const CURRENT_TASK_STATES = new Set([
    ...WORKING_TASK_STATES,
    ...WAITING_TASK_STATES,
    ...PAUSED_TASK_STATES,
    ...ATTENTION_TASK_STATES,
]);
const OFFLINE_RUNTIME_STATES = new Set(['dead', 'exited', 'missing', 'stopped']);
const AVAILABLE_RUNTIME_STATES = new Set(['healthy', 'running']);
function bounded(value, maximum = 200) {
    if (value == null)
        return null;
    const normalized = String(value).trim();
    return normalized ? normalized.slice(0, maximum) : null;
}
function normalizeTaskState(task) {
    return String(task?.status || task?.state || 'UNKNOWN').toUpperCase();
}
function taskId(task) {
    return bounded(task?.task_id || task?.id || task?.file, 180) || 'task-unavailable';
}
function taskTitle(task) {
    return bounded(task?.issue_title || task?.task_text || task?.task || taskId(task), 240) || 'Untitled task';
}
function taskTimestamp(task) {
    return bounded(task?.updated_at || task?.received_at || task?.created_at || task?.completed_at, 64);
}
function timestampValue(value) {
    if (!value)
        return 0;
    const parsed = new Date(String(value)).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}
function newestTimestamp(values) {
    return values
        .map((value) => ({ value: bounded(value, 64), timestamp: timestampValue(value) }))
        .filter((entry) => entry.value && entry.timestamp > 0)
        .sort((left, right) => right.timestamp - left.timestamp)[0]?.value || null;
}
function workspaceSummary(task) {
    const workspace = task?.workspace;
    const workspaceId = bounded(workspace?.workspace_id || task?.workspace_id, 180);
    if (!workspaceId)
        return null;
    const resolvedSha = bounded(workspace?.resolved_sha, 40);
    return {
        workspace_id: workspaceId,
        mode: bounded(workspace?.mode, 20),
        state: bounded(workspace?.state, 40),
        repository_id: bounded(workspace?.repository_id || task?.repository, 220),
        branch: bounded(workspace?.branch, 240),
        resolved_sha: resolvedSha && /^[0-9a-f]{40}$/i.test(resolvedSha) ? resolvedSha.toLowerCase() : null,
        held_for_investigation: Boolean(workspace?.held_for_investigation),
        cleanup_requested: Boolean(workspace?.cleanup_requested),
    };
}
function taskSummary(task) {
    if (!task)
        return null;
    return {
        task_id: taskId(task),
        title: taskTitle(task),
        status: normalizeTaskState(task),
        repository: bounded(task?.repository, 220),
        task_type: bounded(task?.task_type || task?.taskType || task?.kind || task?.trigger, 80),
        updated_at: taskTimestamp(task),
        workspace: workspaceSummary(task),
    };
}
function selectCurrentTask(tasks) {
    return tasks
        .slice()
        .sort((left, right) => timestampValue(taskTimestamp(right)) - timestampValue(taskTimestamp(left)))
        .find((task) => CURRENT_TASK_STATES.has(normalizeTaskState(task))) || null;
}
function attentionFor({ profile, runtimeAgent, currentTask }) {
    if (!profile) {
        return {
            required: true,
            reason_code: 'profile_unavailable',
            summary: 'Runtime identity has no validated Git-backed profile policy.',
        };
    }
    if (!profile.enabled) {
        return {
            required: true,
            reason_code: 'profile_disabled',
            summary: 'The validated profile is disabled.',
        };
    }
    const taskState = normalizeTaskState(currentTask);
    if (currentTask && ATTENTION_TASK_STATES.has(taskState)) {
        return {
            required: true,
            reason_code: `task_${taskState.toLowerCase()}`,
            summary: `Current work is in ${taskState.toLowerCase().replaceAll('_', ' ')} state.`,
        };
    }
    if (runtimeAgent?.lifecycle_error) {
        return {
            required: true,
            reason_code: bounded(runtimeAgent.lifecycle_error, 100) || 'lifecycle_error',
            summary: 'Lifecycle evidence reports an unresolved error.',
        };
    }
    if (runtimeAgent?.convergence_status === 'mismatch') {
        return {
            required: true,
            reason_code: bounded(runtimeAgent.convergence_reason_code, 100) || 'lifecycle_mismatch',
            summary: 'Desired and observed runtime state do not match.',
        };
    }
    if (String(runtimeAgent?.runtime?.health || '').toLowerCase() === 'unhealthy') {
        return {
            required: true,
            reason_code: 'runtime_unhealthy',
            summary: 'Runtime health is unhealthy.',
        };
    }
    if (!runtimeAgent || String(runtimeAgent.observed_state || runtimeAgent.runtime?.status || 'unknown').toLowerCase() === 'unknown') {
        return {
            required: true,
            reason_code: 'runtime_unavailable',
            summary: 'Runtime state could not be observed.',
        };
    }
    return { required: false, reason_code: null, summary: null };
}
function fleetState({ profile, runtimeAgent, currentTask, attention }) {
    if (!profile || !profile.enabled)
        return 'unavailable';
    const attentionReason = String(attention?.reason_code || '');
    if (attention?.required) {
        if (attentionReason === 'runtime_unavailable')
            return 'unavailable';
        return 'needs_human';
    }
    const taskState = normalizeTaskState(currentTask);
    if (currentTask && PAUSED_TASK_STATES.has(taskState))
        return 'paused';
    if (currentTask && WORKING_TASK_STATES.has(taskState))
        return 'working';
    if (currentTask && WAITING_TASK_STATES.has(taskState))
        return 'waiting';
    if (runtimeAgent?.convergence_status === 'transitioning')
        return 'waiting';
    const runtimeStatus = String(runtimeAgent?.observed_state || runtimeAgent?.runtime?.status || 'unknown').toLowerCase();
    if (AVAILABLE_RUNTIME_STATES.has(runtimeStatus))
        return 'idle';
    if (OFFLINE_RUNTIME_STATES.has(runtimeStatus))
        return 'offline';
    return 'unavailable';
}
export function buildAgentFleet({ agents = [], profiles = [], tasks = [], tasksAvailable = true, generatedAt = new Date().toISOString() } = {}) {
    const publicProfiles = profiles.map((profile) => toPublicAgentProfile(profile));
    const profileById = new Map(publicProfiles.map((profile) => [profile.id, profile]));
    const runtimeById = new Map(agents.map((agent) => [agent.key || agent.agent, agent]));
    const allIds = new Set([...profileById.keys(), ...runtimeById.keys()].filter(Boolean));
    const fleet = [...allIds]
        .sort((left, right) => String(left).localeCompare(String(right)))
        .map((id) => {
        const profile = profileById.get(id) || null;
        const runtimeAgent = runtimeById.get(id) || null;
        const agentTasks = tasks.filter((task) => String(task?.agent || '').toLowerCase() === String(id).toLowerCase());
        const currentTask = selectCurrentTask(agentTasks);
        const latestTask = agentTasks
            .slice()
            .sort((left, right) => timestampValue(taskTimestamp(right)) - timestampValue(taskTimestamp(left)))[0] || null;
        const attention = attentionFor({ profile, runtimeAgent, currentTask });
        const state = fleetState({ profile, runtimeAgent, currentTask, attention });
        const runtimeStatus = bounded(runtimeAgent?.observed_state || runtimeAgent?.runtime?.status, 40);
        return {
            id,
            display_name: profile?.display_name || runtimeAgent?.display_name || id,
            role: runtimeAgent?.role || null,
            description: runtimeAgent?.description || null,
            responsibility: profile?.mission || null,
            state,
            attention,
            profile: {
                available: Boolean(profile),
                enabled: profile?.enabled ?? false,
                profile_version: profile?.profile_version || null,
                runtime_backend: profile?.runtime?.backend || runtimeAgent?.backend || null,
            },
            runtime: {
                available: Boolean(runtimeAgent && runtimeStatus && runtimeStatus !== 'unknown'),
                status: runtimeStatus || 'unknown',
                health: bounded(runtimeAgent?.runtime?.health, 40),
                desired_state: bounded(runtimeAgent?.desired_state, 40),
                lifecycle_state: bounded(runtimeAgent?.lifecycle_state, 40),
                convergence_status: bounded(runtimeAgent?.convergence_status, 40),
                restart_count: Number(runtimeAgent?.runtime?.restart_count || 0),
            },
            current_task: taskSummary(currentTask),
            current_mission: null,
            repositories: profile?.repositories || [],
            last_activity_at: newestTimestamp([
                taskTimestamp(latestTask),
                runtimeAgent?.lifecycle_updated_at,
                runtimeAgent?.runtime?.started_at,
                runtimeAgent?.runtime?.finished_at,
            ]),
            links: {
                detail: `/agents/${encodeURIComponent(id)}`,
                logs: runtimeAgent?.links?.logs || `/api/logs?agent=${encodeURIComponent(id)}`,
                tasks: runtimeAgent?.links?.tasks || '/api/tasks',
            },
        };
    });
    return {
        fleet,
        count: fleet.length,
        generated_at: generatedAt,
        sources: {
            profiles: 'available',
            runtime: agents.length > 0 ? 'available' : 'unavailable',
            tasks: tasksAvailable ? 'available' : 'unavailable',
            missions: 'deferred_to_ops_012c',
        },
    };
}
export async function getAgentFleet({ agents, getAgents = getAgentList, getProfiles = listAgentProfiles, getTasks = readTasksDir, now = () => new Date().toISOString(), } = {}) {
    const resolvedAgents = agents || await getAgents();
    let tasks = [];
    let tasksAvailable = true;
    try {
        tasks = await getTasks();
    }
    catch {
        tasksAvailable = false;
    }
    return buildAgentFleet({
        agents: resolvedAgents,
        profiles: getProfiles(),
        tasks,
        tasksAvailable,
        generatedAt: now(),
    });
}
//# sourceMappingURL=agent-fleet.js.map