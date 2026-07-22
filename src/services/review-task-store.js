import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const TASK_SCHEMA = 'ops-room.review-task.v2';
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const ACTIVE_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);
const CONCURRENCY_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);
const DEFAULT_CONCURRENCY = {
    global: parseInt(process.env.OPENAB_REVIEW_MAX_GLOBAL || '5', 10),
    per_repository: parseInt(process.env.OPENAB_REVIEW_MAX_PER_REPO || '3', 10),
    per_pr: parseInt(process.env.OPENAB_REVIEW_MAX_PER_PR || '1', 10),
};
const TRANSITIONS = new Map([
    ['QUEUED', new Set(['CLAIMED', 'SUPERSEDED', 'CANCELLED', 'NEEDS_HUMAN', 'ERROR', 'PAUSED'])],
    ['FIX_QUEUED', new Set(['CLAIMED', 'SUPERSEDED', 'CANCELLED', 'NEEDS_HUMAN', 'ERROR', 'PAUSED'])],
    ['PAUSED', new Set(['QUEUED', 'FIX_QUEUED'])],
    ['CLAIMED', new Set(['RUNNING', 'FIXING', 'SUPERSEDED', 'CANCEL_REQUESTED', 'ERROR', 'QUEUED', 'NEEDS_HUMAN'])],
    ['RUNNING', new Set(['PASSED', 'CHANGES_REQUESTED', 'SUPERSEDED', 'CANCEL_REQUESTED', 'NEEDS_HUMAN', 'ERROR', 'QUEUED'])],
    ['CHANGES_REQUESTED', new Set(['CHANGES_REQUESTED', 'FIX_QUEUED', 'NEEDS_HUMAN', 'CANCELLED'])],
    ['PASSED', new Set(['PASSED'])],
    ['FIX_PUSHED', new Set(['FIX_PUSHED'])],
    ['FIXING', new Set(['FIX_PUSHED', 'SUPERSEDED', 'CANCEL_REQUESTED', 'CANCELLED', 'NEEDS_HUMAN', 'ERROR'])],
    ['CANCEL_REQUESTED', new Set(['CANCELLED', 'SUPERSEDED', 'ERROR'])],
    ['ERROR', new Set(['QUEUED', 'FIX_QUEUED', 'NEEDS_HUMAN'])],
    ['NEEDS_HUMAN', new Set(['QUEUED', 'FIX_QUEUED'])],
    ['SUPERSEDED', new Set(['QUEUED', 'FIX_QUEUED'])],
    ['CANCELLED', new Set(['QUEUED', 'FIX_QUEUED'])],
]);
function safePart(value, fallback = 'unknown') {
    const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized || fallback;
}
function now() {
    return new Date().toISOString();
}
function validateTaskId(id) {
    const value = String(id);
    if (!SAFE_ID.test(value))
        throw new Error(`Invalid task ID: ${id}`);
    return value;
}
function portableFilename(id, extension) {
    const digest = createHash('sha256').update(validateTaskId(id)).digest('hex');
    return `task-${digest}${extension}`;
}
function taskPath(dir, id) {
    return join(dir, portableFilename(id, '.json'));
}
function claimPath(dir, id) {
    return join(dir, portableFilename(id, '.claim'));
}
function legacyPath(dir, id, extension) {
    const value = validateTaskId(id);
    if (process.platform === 'win32' && (value.includes(':')
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)))
        return null;
    return join(dir, `${value}${extension}`);
}
function taskPaths(dir, id) {
    return [taskPath(dir, id), legacyPath(dir, id, '.json')].filter(Boolean);
}
function claimPaths(dir, id) {
    return [claimPath(dir, id), legacyPath(dir, id, '.claim')].filter(Boolean);
}
async function readStoredJson(paths) {
    for (const path of paths) {
        try {
            return { path, value: JSON.parse(await readFile(path, 'utf-8')) };
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
        }
    }
    return null;
}
function deduplicateTaskRecords(records) {
    const tasksById = new Map();
    for (const record of records) {
        const key = String(record.task.id ?? record.name);
        const portable = SAFE_ID.test(String(record.task.id ?? ''))
            && record.name === portableFilename(record.task.id, '.json');
        const existing = tasksById.get(key);
        if (!existing || (portable && !existing.portable)) {
            tasksById.set(key, { task: record.task, portable });
        }
    }
    return [...tasksById.values()].map(({ task }) => task);
}
function retryQueueState(task) {
    return task.kind === 'fix' ? 'FIX_QUEUED' : 'QUEUED';
}
function operatorAction(operation, actor, reason) {
    return {
        operation,
        actor: String(actor || 'unknown').slice(0, 100),
        reason: String(reason || '').slice(0, 500),
        requested_at: now(),
    };
}
async function replaceFileWithRetry(tempPath, path, { renameFn = rename, sleep = delay, maxAttempts = 8, } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await renameFn(tempPath, path);
            return;
        }
        catch (error) {
            const retryable = RETRYABLE_RENAME_CODES.has(error?.code);
            if (!retryable || attempt === maxAttempts)
                throw error;
            const delayMs = Math.min(10 * (2 ** (attempt - 1)), 100);
            await sleep(delayMs);
        }
    }
}
export function buildReviewTaskId({ repository, pr, headSha, agent, mode = 'review', taskType = 'review', commentId = null }) {
    const prefix = taskType === 'chat' ? 'pr-chat' : 'review';
    const parts = [
        prefix,
        safePart(repository),
        Number(pr),
        safePart(headSha, 'missing-sha'),
        safePart(agent),
        safePart(mode, 'review'),
    ];
    if (taskType === 'chat' && commentId) {
        parts.push(safePart(String(commentId), 'chat'));
    }
    return parts.join(':');
}
export function buildFixTaskId({ repository, pr, reviewedSha, parentTaskId, agent }) {
    return [
        'fix',
        safePart(repository),
        Number(pr),
        safePart(reviewedSha, 'missing-sha'),
        safePart(parentTaskId),
        safePart(agent),
    ].join(':');
}
export async function writeAtomic(path, value, options = {}) {
    await mkdir(join(path, '..'), { recursive: true });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    try {
        await replaceFileWithRetry(tempPath, path, options);
    }
    catch (error) {
        await rm(tempPath, { force: true }).catch(() => { });
        throw error;
    }
}
export async function readTask({ dir, id }) {
    return (await readStoredJson(taskPaths(dir, id)))?.value ?? null;
}
export async function scanReviewTasks({ dir }) {
    let names;
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return { scanned: 0, tasks: [], corrupt: [] };
        throw error;
    }
    const records = [];
    const corrupt = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        try {
            const task = JSON.parse(await readFile(join(dir, name), 'utf-8'));
            if (!task || typeof task !== 'object' || Array.isArray(task)) {
                corrupt.push(name.slice(0, -5));
                continue;
            }
            records.push({ name, task });
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                continue;
            if (error instanceof SyntaxError) {
                corrupt.push(name.slice(0, -5));
                continue;
            }
            throw error;
        }
    }
    const tasks = deduplicateTaskRecords(records);
    return { scanned: tasks.length + corrupt.length, tasks, corrupt };
}
export async function listReviewTasks({ dir, limit = 100 }) {
    const { tasks } = await scanReviewTasks({ dir });
    return tasks.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}
export async function createOrClaimTask({ dir, input, trigger = 'unknown', policy = {}, parentTaskId = null, kind = 'review' }) {
    await mkdir(dir, { recursive: true });
    const id = kind === 'fix'
        ? buildFixTaskId({ ...input, parentTaskId, agent: input.agent })
        : buildReviewTaskId({ ...input, taskType: input.taskType || input.task_type || 'review', commentId: input.commentId || input.comment_id || null });
    const path = taskPath(dir, id);
    const existing = await readTask({ dir, id });
    if (existing)
        return { created: false, task: existing };
    try {
        const handle = await open(path, 'wx');
        const createdAt = now();
        const task = {
            schema: TASK_SCHEMA,
            id,
            kind,
            repository: input.repository,
            pr: Number(input.pr),
            reviewed_sha: input.headSha || input.reviewedSha,
            agent: input.agent,
            mode: input.mode || 'review',
            trigger,
            parent_task_id: parentTaskId,
            policy,
            review_result: input.review_result || null,
            head_ref: input.headRef || null,
            task_type: input.taskType || input.task_type || 'review',
            comment_id: input.commentId || input.comment_id || null,
            commenter: input.commenter || null,
            task_text: input.task || null,
            state: 'QUEUED',
            attempt: 0,
            created_at: createdAt,
            updated_at: createdAt,
            history: [{ from: null, to: 'QUEUED', at: createdAt, reason: 'created' }],
        };
        try {
            await handle.writeFile(`${JSON.stringify(task, null, 2)}\n`, 'utf-8');
        }
        finally {
            await handle.close();
        }
        return { created: true, task };
    }
    catch (error) {
        if (error?.code !== 'EEXIST')
            throw error;
        const task = await readTask({ dir, id });
        if (!task)
            throw new Error(`Task appeared concurrently but cannot be read: ${id}`);
        return { created: false, task };
    }
}
export async function transitionTask({ dir, id, to, reason, patch = {}, leaseEpoch }) {
    const current = await readTask({ dir, id });
    if (!current)
        throw new Error(`Task not found: ${id}`);
    if (!TRANSITIONS.get(current.state)?.has(to)) {
        throw new Error(`Invalid task transition: ${current.state} -> ${to}`);
    }
    // Lease epoch fencing: if the task already has a lease, require exact epoch
    // equality for all state transitions. This prevents a stale worker from
    // mutating state after its lease has been superseded by a newer claim.
    if (leaseEpoch !== undefined && current.lease?.lease_epoch !== undefined) {
        if (leaseEpoch !== current.lease.lease_epoch) {
            throw new Error(`Lease epoch mismatch: presented ${leaseEpoch}, current ${current.lease.lease_epoch}`);
        }
    }
    const updatedAt = now();
    const updated = {
        ...current,
        ...patch,
        state: to,
        updated_at: updatedAt,
        history: [...(current.history || []), { from: current.state, to, at: updatedAt, reason }],
    };
    await writeAtomic(taskPath(dir, id), updated);
    return updated;
}
export async function requestCancellation({ dir, id, actor = 'unknown', reason = 'requested' }) {
    const current = await readTask({ dir, id });
    if (!current)
        throw new Error(`Task not found: ${id}`);
    const to = current.state === 'QUEUED' || current.state === 'FIX_QUEUED' ? 'CANCELLED' : 'CANCEL_REQUESTED';
    return transitionTask({
        dir,
        id,
        to,
        reason: to === 'CANCELLED' ? 'queued_cancellation_requested' : 'cancellation_requested',
        patch: {
            cancellation: { actor, reason, requested_at: now() },
            last_operator_action: operatorAction('cancel', actor, reason),
        },
    });
}
export async function claimTask({ dir, id, instanceId, leaseId, leaseEpoch = 1 }) {
    const path = claimPath(dir, id);
    const claim = {
        task_id: id,
        instance_id: instanceId,
        lease_id: leaseId,
        lease_epoch: leaseEpoch,
        claimed_at: now(),
        heartbeat_at: now(),
    };
    const existing = await readStoredJson(claimPaths(dir, id));
    if (existing)
        return { claimed: false, claim: existing.value };
    try {
        const handle = await open(path, 'wx');
        try {
            await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, 'utf-8');
        }
        finally {
            await handle.close();
        }
        return { claimed: true, claim };
    }
    catch (error) {
        if (error?.code !== 'EEXIST')
            throw error;
        return { claimed: false, claim: JSON.parse(await readFile(path, 'utf-8')) };
    }
}
export async function renewClaim({ dir, id, leaseId, leaseEpoch, now: heartbeatAt = now() }) {
    const path = claimPath(dir, id);
    const stored = await readStoredJson(claimPaths(dir, id));
    if (!stored)
        throw new Error(`Claim not found: ${id}`);
    const current = stored.value;
    // Validate lease ownership: only the current holder can renew.
    if (leaseId !== undefined && current.lease_id !== leaseId) {
        throw new Error(`Lease ID mismatch: presented ${leaseId}, current ${current.lease_id}`);
    }
    if (leaseEpoch !== undefined && current.lease_epoch !== leaseEpoch) {
        throw new Error(`Lease epoch mismatch: presented ${leaseEpoch}, current ${current.lease_epoch}`);
    }
    const renewed = { ...current, heartbeat_at: heartbeatAt };
    await writeAtomic(path, renewed);
    return renewed;
}
export function isClaimStale(claim, { now: currentTime = now(), staleMinutes = 30 } = {}) {
    if (!claim?.heartbeat_at)
        return true;
    // Fast path: if the claiming process is dead, the claim is stale immediately.
    // instance_id is "ops-room-{PID}" — extract PID and check if it still exists.
    if (claim?.instance_id) {
        const pid = parseInt(claim.instance_id.split('-').pop(), 10);
        if (Number.isFinite(pid) && pid > 0) {
            try {
                process.kill(pid, 0); // signal 0 just checks existence, doesn't kill
            }
            catch (error) {
                if (error?.code === 'ESRCH')
                    return true; // process doesn't exist
                // EPERM or similar — process exists but we can't signal it. Not stale.
            }
        }
    }
    // Fallback: clock-based staleness check for cases where PID check is inconclusive.
    const heartbeatMs = Date.parse(claim.heartbeat_at);
    const currentMs = Date.parse(currentTime);
    if (!Number.isFinite(heartbeatMs) || !Number.isFinite(currentMs))
        return true;
    return currentMs - heartbeatMs > staleMinutes * 60_000;
}
export async function releaseClaim({ dir, id }) {
    await rm(claimPath(dir, id), { force: true });
    const legacy = legacyPath(dir, id, '.claim');
    if (legacy)
        await rm(legacy, { force: true });
}
export async function countActiveTasks({ dir, repository, pr }) {
    const { tasks } = await scanReviewTasks({ dir });
    let global = 0;
    let repoCount = 0;
    let prCount = 0;
    for (const task of tasks) {
        if (!CONCURRENCY_STATES.has(task.state))
            continue;
        global += 1;
        if (repository && task.repository === repository) {
            repoCount += 1;
            if (pr !== undefined && task.pr === Number(pr))
                prCount += 1;
        }
    }
    return { global, repository: repoCount, pr: prCount };
}
export function checkConcurrency({ counts, limits = {} }) {
    const global = limits.global ?? DEFAULT_CONCURRENCY.global;
    const perRepo = limits.per_repository ?? DEFAULT_CONCURRENCY.per_repository;
    const perPr = limits.per_pr ?? DEFAULT_CONCURRENCY.per_pr;
    if (counts.global >= global)
        return { allowed: false, reason: 'global_concurrency_limit' };
    if (counts.repository >= perRepo)
        return { allowed: false, reason: 'repository_concurrency_limit' };
    if (counts.pr >= perPr)
        return { allowed: false, reason: 'pr_concurrency_limit' };
    return { allowed: true };
}
export async function recoverStaleTask({ dir, id, now: currentTime = now(), staleMinutes = 30, retryLimit = 3 }) {
    const task = await readTask({ dir, id });
    if (!task)
        throw new Error(`Task not found: ${id}`);
    const taskId = task.id || id;
    if (!['CLAIMED', 'RUNNING', 'FIXING'].includes(task.state))
        return { recovered: false, reason: 'not_active' };
    const claim = (await readStoredJson(claimPaths(dir, taskId)))?.value ?? null;
    if (claim && !isClaimStale(claim, { now: currentTime, staleMinutes })) {
        return { recovered: false, reason: 'heartbeat_fresh' };
    }
    await releaseClaim({ dir, id: taskId });
    const attempt = (task.attempt || 0) + 1;
    const retryBudget = task.policy?.retry_budget ?? retryLimit;
    if (attempt > retryBudget) {
        await transitionTask({
            dir, id: taskId, to: 'NEEDS_HUMAN',
            reason: 'retry_budget_exhausted',
            patch: { attempt, completed_at: currentTime, error: 'Retry budget exhausted after stale lease recovery' },
        });
        return { recovered: true, retry_allowed: false };
    }
    const nextEpoch = (task.lease?.lease_epoch || 0) + 1;
    const retried = await transitionTask({
        dir, id: taskId, to: retryQueueState(task),
        reason: 'stale_lease_requeued',
        patch: { attempt, lease: { lease_epoch: nextEpoch }, heartbeat_at: null },
    });
    return { recovered: true, retry_allowed: true, re_dispatched: true, attempt, task: retried };
}
export async function retryTask({ dir, id, actor = 'unknown', reason = 'requested' }) {
    const task = await readTask({ dir, id });
    if (!task)
        throw new Error(`Task not found: ${id}`);
    const retryableStates = new Set(['ERROR', 'NEEDS_HUMAN', 'SUPERSEDED', 'CANCELLED']);
    if (!retryableStates.has(task.state)) {
        throw new Error(`Cannot retry task in state: ${task.state}`);
    }
    const attempt = (task.attempt || 0) + 1;
    const configuredBudget = Number(task.policy?.retry_budget);
    if (Number.isFinite(configuredBudget) && attempt > configuredBudget) {
        throw new Error(`Retry budget exhausted: attempt ${attempt} exceeds ${configuredBudget}`);
    }
    await releaseClaim({ dir, id });
    return transitionTask({
        dir,
        id,
        to: retryQueueState(task),
        reason: 'operator_retry',
        patch: {
            attempt,
            lease: null,
            heartbeat_at: null,
            error: null,
            cancellation: null,
            completed_at: null,
            last_operator_action: operatorAction('retry', actor, reason),
        },
    });
}
export async function pauseTask({ dir, id, actor = 'unknown', reason = 'requested' }) {
    const task = await readTask({ dir, id });
    if (!task)
        throw new Error(`Task not found: ${id}`);
    const pausableStates = new Set(['QUEUED', 'FIX_QUEUED']);
    if (!pausableStates.has(task.state)) {
        throw new Error(`Cannot pause task in state: ${task.state}`);
    }
    return transitionTask({
        dir,
        id,
        to: 'PAUSED',
        reason: 'operator_paused',
        patch: {
            paused_at: now(),
            pause_reason: reason,
            last_operator_action: operatorAction('pause', actor, reason),
        },
    });
}
export async function resumeTask({ dir, id, actor = 'unknown', reason = 'requested' }) {
    const task = await readTask({ dir, id });
    if (!task)
        throw new Error(`Task not found: ${id}`);
    if (task.state !== 'PAUSED') {
        throw new Error(`Cannot resume task in state: ${task.state}`);
    }
    return transitionTask({
        dir,
        id,
        to: retryQueueState(task),
        reason: 'operator_resumed',
        patch: {
            paused_at: null,
            pause_reason: null,
            last_operator_action: operatorAction('resume', actor, reason),
        },
    });
}
export function isTerminalState(state) {
    return !TRANSITIONS.has(state) && state !== 'PAUSED';
}
//# sourceMappingURL=review-task-store.js.map