import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './review-task-store.js';
export const WORKFLOW_RUN_SCHEMA = 'ops-room.workflow-run.v1';
export const WORKFLOW_RUN_VERSION = 1;
export const FEATURE_DEVELOPMENT_WORKFLOW = 'feature-development';
export const FEATURE_DEVELOPMENT_STAGES = Object.freeze([
    'implementation',
    'test',
    'integration',
    'review',
]);
export const FEATURE_DEVELOPMENT_OWNERS = Object.freeze({
    implementation: 'professor',
    test: 'tokyo',
    integration: 'professor',
    review: 'berlin',
});
const WORKFLOW_STATES = new Set(['planned', 'active', 'blocked', 'completed', 'needs_human', 'cancelled']);
const CHILD_STATES = new Set(['pending', 'active', 'completed', 'failed', 'cancelled', 'needs_human']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const SAFE_REPOSITORY_ID = /^(?:[A-Za-z0-9._-]{1,120}|[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const mutationTails = new Map();
function nowIso() {
    return new Date().toISOString();
}
function safePart(value, fallback = 'unknown') {
    const normalized = String(value ?? '')
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || fallback;
}
function validateId(value, field) {
    const normalized = String(value || '');
    if (!SAFE_ID.test(normalized))
        throw new Error(`invalid_${field}`);
    return normalized;
}
function validateRepositoryId(value) {
    const normalized = String(value || '');
    if (!SAFE_REPOSITORY_ID.test(normalized))
        throw new Error('invalid_workflow_repository_id');
    for (const part of normalized.split('/')) {
        if (part === '..' || part.startsWith('.') || part.endsWith('.')) {
            throw new Error('invalid_workflow_repository_id');
        }
    }
    return normalized;
}
function validateSha(value, field) {
    const normalized = String(value || '').toLowerCase();
    if (!SAFE_SHA.test(normalized))
        throw new Error(`invalid_${field}`);
    return normalized;
}
function validatePolicy(policy = {}) {
    const maxIterations = Number(policy.max_iterations ?? 3);
    const maxConcurrency = Number(policy.max_concurrency ?? 1);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 20) {
        throw new Error('invalid_workflow_max_iterations');
    }
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) {
        throw new Error('invalid_workflow_max_concurrency');
    }
    return {
        max_iterations: maxIterations,
        max_concurrency: maxConcurrency,
    };
}
function workflowFilename(workflowId) {
    const digest = createHash('sha256').update(validateId(workflowId, 'workflow_id')).digest('hex');
    return `workflow-${digest}.json`;
}
function workflowPath(dir, workflowId) {
    return join(dir, workflowFilename(workflowId));
}
function expectedDependencyId(workflowId, iteration, stage) {
    if (stage === 'implementation') {
        return iteration === 1 ? null : buildWorkflowChildId({ workflowId, iteration: iteration - 1, stage: 'review' });
    }
    const stageIndex = FEATURE_DEVELOPMENT_STAGES.indexOf(stage);
    return buildWorkflowChildId({ workflowId, iteration, stage: FEATURE_DEVELOPMENT_STAGES[stageIndex - 1] });
}
function childPublicShape(child) {
    return {
        child_id: child.child_id,
        stage: child.stage,
        owner_agent: child.owner_agent,
        iteration: child.iteration,
        attempt: child.attempt,
        state: child.state,
        depends_on: child.depends_on,
        input_sha: child.input_sha,
        output_sha: child.output_sha || null,
        created_at: child.created_at,
        updated_at: child.updated_at,
        started_at: child.started_at || null,
        completed_at: child.completed_at || null,
        last_error: child.last_error || null,
    };
}
async function withWorkflowMutation(workflowId, operation) {
    const previous = mutationTails.get(workflowId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    mutationTails.set(workflowId, tail);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (mutationTails.get(workflowId) === tail)
            mutationTails.delete(workflowId);
    }
}
function appendHistory(record, event, at) {
    return [...(record.history || []), { ...event, at }];
}
function validateChildBasics(record, child) {
    validateId(child.child_id, 'workflow_child_id');
    if (!FEATURE_DEVELOPMENT_STAGES.includes(child.stage))
        throw new Error('invalid_workflow_child_stage');
    if (child.owner_agent !== FEATURE_DEVELOPMENT_OWNERS[child.stage]) {
        throw new Error('workflow_child_owner_mismatch');
    }
    if (!Number.isInteger(child.iteration) || child.iteration < 1 || child.iteration > record.policy.max_iterations) {
        throw new Error('invalid_workflow_child_iteration');
    }
    if (!Number.isInteger(child.attempt) || child.attempt < 0 || child.attempt > 100) {
        throw new Error('invalid_workflow_child_attempt');
    }
    if (!CHILD_STATES.has(child.state))
        throw new Error('invalid_workflow_child_state');
    validateSha(child.input_sha, 'workflow_child_input_sha');
    const expectedId = buildWorkflowChildId({
        workflowId: record.workflow_id,
        iteration: child.iteration,
        stage: child.stage,
    });
    if (child.child_id !== expectedId)
        throw new Error('workflow_child_id_mismatch');
    const expectedDependency = expectedDependencyId(record.workflow_id, child.iteration, child.stage);
    if ((child.depends_on || null) !== expectedDependency)
        throw new Error('workflow_child_dependency_mismatch');
    if (child.state === 'completed') {
        validateSha(child.output_sha, 'workflow_child_output_sha');
        if (!child.completed_at)
            throw new Error('workflow_child_completion_evidence_required');
    }
    else if (child.output_sha || child.completed_at) {
        throw new Error('workflow_child_completion_evidence_unexpected');
    }
    return child;
}
export function buildWorkflowRunId({ repository, requestKey }) {
    const repositoryId = validateRepositoryId(repository);
    const key = String(requestKey || '').trim();
    if (!key || key.length > 500)
        throw new Error('invalid_workflow_request_key');
    const digest = createHash('sha256').update(`${repositoryId}\n${key}`).digest('hex').slice(0, 24);
    return `workflow:${safePart(repositoryId)}:${digest}`;
}
export function buildWorkflowChildId({ workflowId, iteration, stage }) {
    validateId(workflowId, 'workflow_id');
    if (!Number.isInteger(iteration) || iteration < 1 || iteration > 20) {
        throw new Error('invalid_workflow_child_iteration');
    }
    if (!FEATURE_DEVELOPMENT_STAGES.includes(stage))
        throw new Error('invalid_workflow_child_stage');
    return `${workflowId}:${iteration}:${stage}`;
}
export function validateWorkflowRun(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record))
        throw new Error('invalid_workflow_run');
    if (record.schema !== WORKFLOW_RUN_SCHEMA || record.version !== WORKFLOW_RUN_VERSION) {
        throw new Error('unsupported_workflow_run');
    }
    validateId(record.workflow_id, 'workflow_id');
    if (record.workflow_type !== FEATURE_DEVELOPMENT_WORKFLOW)
        throw new Error('unsupported_workflow_type');
    validateRepositoryId(record.repository_id);
    if (!String(record.request_key || '').trim() || String(record.request_key).length > 500) {
        throw new Error('invalid_workflow_request_key');
    }
    validateSha(record.source_sha, 'workflow_source_sha');
    if (!WORKFLOW_STATES.has(record.state))
        throw new Error('invalid_workflow_state');
    record.policy = validatePolicy(record.policy);
    if (!Number.isInteger(record.current_iteration) || record.current_iteration < 1 || record.current_iteration > record.policy.max_iterations) {
        throw new Error('invalid_workflow_current_iteration');
    }
    if (!Array.isArray(record.children))
        throw new Error('invalid_workflow_children');
    if (!Array.isArray(record.history))
        throw new Error('invalid_workflow_history');
    const byId = new Map();
    const byStageIteration = new Map();
    for (const child of record.children) {
        validateChildBasics(record, child);
        if (byId.has(child.child_id))
            throw new Error('duplicate_workflow_child_id');
        const stageKey = `${child.iteration}:${child.stage}`;
        if (byStageIteration.has(stageKey))
            throw new Error('duplicate_workflow_child_stage');
        byId.set(child.child_id, child);
        byStageIteration.set(stageKey, child);
    }
    for (const child of record.children) {
        if (!child.depends_on) {
            if (child.stage !== 'implementation' || child.iteration !== 1 || child.input_sha !== record.source_sha) {
                throw new Error('workflow_child_root_input_mismatch');
            }
            continue;
        }
        const dependency = byId.get(child.depends_on);
        if (!dependency)
            throw new Error('workflow_child_dependency_unavailable');
        if (dependency.state !== 'completed' || !dependency.output_sha) {
            throw new Error('workflow_child_dependency_incomplete');
        }
        if (child.input_sha !== dependency.output_sha)
            throw new Error('workflow_child_input_mismatch');
    }
    return record;
}
export async function readWorkflowRun({ dir, workflowId }) {
    const raw = await readFile(workflowPath(dir, workflowId), 'utf8');
    return validateWorkflowRun(JSON.parse(raw));
}
export async function listWorkflowRuns({ dir, limit = 100 }) {
    await mkdir(dir, { recursive: true });
    const names = (await readdir(dir)).filter((name) => name.startsWith('workflow-') && name.endsWith('.json')).sort();
    const records = [];
    for (const name of names) {
        try {
            records.push(validateWorkflowRun(JSON.parse(await readFile(join(dir, name), 'utf8'))));
        }
        catch {
            records.push({
                schema: WORKFLOW_RUN_SCHEMA,
                version: WORKFLOW_RUN_VERSION,
                workflow_id: name.replace(/\.json$/, ''),
                workflow_type: FEATURE_DEVELOPMENT_WORKFLOW,
                state: 'needs_human',
                last_error: 'workflow_record_unavailable',
            });
        }
    }
    return records
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
}
export async function createOrLoadWorkflowRun({ dir, input, policy = {}, now = nowIso }) {
    await mkdir(dir, { recursive: true });
    const repositoryId = validateRepositoryId(input.repository_id || input.repository);
    const requestKey = String(input.request_key || input.requestKey || '').trim();
    const sourceSha = validateSha(input.source_sha || input.sourceSha, 'workflow_source_sha');
    const workflowId = buildWorkflowRunId({ repository: repositoryId, requestKey });
    const target = workflowPath(dir, workflowId);
    const expectedPolicy = validatePolicy(policy);
    try {
        const existing = await readWorkflowRun({ dir, workflowId });
        if (existing.repository_id !== repositoryId
            || existing.request_key !== requestKey
            || existing.source_sha !== sourceSha
            || JSON.stringify(existing.policy) !== JSON.stringify(expectedPolicy)) {
            throw new Error('workflow_run_conflict');
        }
        return { created: false, run: existing };
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const createdAt = now();
    const run = validateWorkflowRun({
        schema: WORKFLOW_RUN_SCHEMA,
        version: WORKFLOW_RUN_VERSION,
        workflow_id: workflowId,
        workflow_type: FEATURE_DEVELOPMENT_WORKFLOW,
        repository_id: repositoryId,
        request_key: requestKey,
        source_sha: sourceSha,
        state: 'planned',
        policy: expectedPolicy,
        current_iteration: 1,
        children: [],
        created_at: createdAt,
        updated_at: createdAt,
        history: [{ event: 'workflow_created', at: createdAt }],
    });
    try {
        const handle = await open(target, 'wx', 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(run, null, 2)}\n`, 'utf8');
        }
        finally {
            await handle.close();
        }
        return { created: true, run };
    }
    catch (error) {
        if (error?.code !== 'EEXIST')
            throw error;
        const existing = await readWorkflowRun({ dir, workflowId });
        if (existing.repository_id !== repositoryId
            || existing.request_key !== requestKey
            || existing.source_sha !== sourceSha
            || JSON.stringify(existing.policy) !== JSON.stringify(expectedPolicy)) {
            throw new Error('workflow_run_conflict');
        }
        return { created: false, run: existing };
    }
}
export async function ensureWorkflowChild({ dir, workflowId, iteration, stage, inputSha, now = nowIso }) {
    return withWorkflowMutation(workflowId, async () => {
        const run = await readWorkflowRun({ dir, workflowId });
        if (['completed', 'cancelled', 'needs_human'].includes(run.state)) {
            throw new Error('workflow_run_not_mutable');
        }
        if (!Number.isInteger(iteration) || iteration < 1 || iteration > run.policy.max_iterations) {
            throw new Error('workflow_iteration_limit_exceeded');
        }
        if (!FEATURE_DEVELOPMENT_STAGES.includes(stage))
            throw new Error('invalid_workflow_child_stage');
        const normalizedInputSha = validateSha(inputSha, 'workflow_child_input_sha');
        const childId = buildWorkflowChildId({ workflowId, iteration, stage });
        const dependencyId = expectedDependencyId(workflowId, iteration, stage);
        const ownerAgent = FEATURE_DEVELOPMENT_OWNERS[stage];
        const existing = run.children.find((child) => child.child_id === childId);
        if (existing) {
            if (existing.stage !== stage
                || existing.iteration !== iteration
                || existing.owner_agent !== ownerAgent
                || existing.depends_on !== dependencyId
                || existing.input_sha !== normalizedInputSha) {
                throw new Error('workflow_child_conflict');
            }
            return { created: false, run, child: existing };
        }
        if (!dependencyId) {
            if (normalizedInputSha !== run.source_sha)
                throw new Error('workflow_child_root_input_mismatch');
        }
        else {
            const dependency = run.children.find((child) => child.child_id === dependencyId);
            if (!dependency || dependency.state !== 'completed' || !dependency.output_sha) {
                throw new Error('workflow_child_dependency_incomplete');
            }
            if (dependency.output_sha !== normalizedInputSha)
                throw new Error('workflow_child_input_mismatch');
        }
        const createdAt = now();
        const child = {
            child_id: childId,
            stage,
            owner_agent: ownerAgent,
            iteration,
            attempt: 0,
            state: 'pending',
            depends_on: dependencyId,
            input_sha: normalizedInputSha,
            output_sha: null,
            created_at: createdAt,
            updated_at: createdAt,
            started_at: null,
            completed_at: null,
            last_error: null,
            history: [{ from: null, to: 'pending', at: createdAt, reason: 'child_created' }],
        };
        const updated = validateWorkflowRun({
            ...run,
            state: run.state === 'planned' ? 'active' : run.state,
            current_iteration: Math.max(run.current_iteration, iteration),
            updated_at: createdAt,
            children: [...run.children, child],
            history: appendHistory(run, { event: 'workflow_child_created', child_id: childId }, createdAt),
        });
        await writeAtomic(workflowPath(dir, workflowId), updated);
        return { created: true, run: updated, child };
    });
}
export async function activateWorkflowChild({ dir, workflowId, childId, now = nowIso }) {
    return withWorkflowMutation(workflowId, async () => {
        const run = await readWorkflowRun({ dir, workflowId });
        const index = run.children.findIndex((child) => child.child_id === childId);
        if (index < 0)
            throw new Error('workflow_child_not_found');
        const current = run.children[index];
        if (current.state === 'active')
            return { run, child: current };
        if (current.state !== 'pending')
            throw new Error(`workflow_child_not_activatable:${current.state}`);
        const activeCount = run.children.filter((child) => child.state === 'active').length;
        if (activeCount >= run.policy.max_concurrency)
            throw new Error('workflow_concurrency_limit');
        if (current.depends_on) {
            const dependency = run.children.find((child) => child.child_id === current.depends_on);
            if (!dependency || dependency.state !== 'completed' || dependency.output_sha !== current.input_sha) {
                throw new Error('workflow_child_dependency_incomplete');
            }
        }
        const at = now();
        const child = {
            ...current,
            state: 'active',
            started_at: current.started_at || at,
            updated_at: at,
            history: [...(current.history || []), { from: current.state, to: 'active', at, reason: 'child_activated' }],
        };
        const children = [...run.children];
        children[index] = child;
        const updated = validateWorkflowRun({
            ...run,
            state: 'active',
            updated_at: at,
            children,
            history: appendHistory(run, { event: 'workflow_child_activated', child_id: childId }, at),
        });
        await writeAtomic(workflowPath(dir, workflowId), updated);
        return { run: updated, child };
    });
}
export async function completeWorkflowChild({ dir, workflowId, childId, outputSha, now = nowIso }) {
    return withWorkflowMutation(workflowId, async () => {
        const run = await readWorkflowRun({ dir, workflowId });
        const index = run.children.findIndex((child) => child.child_id === childId);
        if (index < 0)
            throw new Error('workflow_child_not_found');
        const current = run.children[index];
        const normalizedOutputSha = validateSha(outputSha, 'workflow_child_output_sha');
        if (current.state === 'completed') {
            if (current.output_sha !== normalizedOutputSha)
                throw new Error('workflow_child_completion_conflict');
            return { run, child: current };
        }
        if (current.state !== 'active')
            throw new Error(`workflow_child_not_completable:${current.state}`);
        const at = now();
        const child = {
            ...current,
            state: 'completed',
            output_sha: normalizedOutputSha,
            completed_at: at,
            updated_at: at,
            last_error: null,
            history: [...(current.history || []), { from: current.state, to: 'completed', at, reason: 'child_completed' }],
        };
        const children = [...run.children];
        children[index] = child;
        const updated = validateWorkflowRun({
            ...run,
            updated_at: at,
            children,
            history: appendHistory(run, { event: 'workflow_child_completed', child_id: childId }, at),
        });
        await writeAtomic(workflowPath(dir, workflowId), updated);
        return { run: updated, child };
    });
}
export async function failWorkflowChild({ dir, workflowId, childId, error, now = nowIso }) {
    return withWorkflowMutation(workflowId, async () => {
        const run = await readWorkflowRun({ dir, workflowId });
        const index = run.children.findIndex((child) => child.child_id === childId);
        if (index < 0)
            throw new Error('workflow_child_not_found');
        const current = run.children[index];
        const boundedError = String(error || 'workflow_child_failed').slice(0, 300);
        if (current.state === 'failed' && current.last_error === boundedError)
            return { run, child: current };
        if (current.state !== 'active')
            throw new Error(`workflow_child_not_failable:${current.state}`);
        const at = now();
        const child = {
            ...current,
            state: 'failed',
            updated_at: at,
            last_error: boundedError,
            history: [...(current.history || []), { from: current.state, to: 'failed', at, reason: boundedError }],
        };
        const children = [...run.children];
        children[index] = child;
        const updated = validateWorkflowRun({
            ...run,
            state: 'blocked',
            updated_at: at,
            children,
            history: appendHistory(run, { event: 'workflow_child_failed', child_id: childId }, at),
        });
        await writeAtomic(workflowPath(dir, workflowId), updated);
        return { run: updated, child };
    });
}
export async function retryWorkflowChild({ dir, workflowId, childId, now = nowIso }) {
    return withWorkflowMutation(workflowId, async () => {
        const run = await readWorkflowRun({ dir, workflowId });
        const index = run.children.findIndex((child) => child.child_id === childId);
        if (index < 0)
            throw new Error('workflow_child_not_found');
        const current = run.children[index];
        if (current.state !== 'failed')
            throw new Error(`workflow_child_not_retryable:${current.state}`);
        const at = now();
        const child = {
            ...current,
            state: 'pending',
            attempt: current.attempt + 1,
            started_at: null,
            updated_at: at,
            last_error: null,
            history: [...(current.history || []), { from: current.state, to: 'pending', at, reason: 'child_retry_requested' }],
        };
        const children = [...run.children];
        children[index] = child;
        const updated = validateWorkflowRun({
            ...run,
            state: 'active',
            updated_at: at,
            children,
            history: appendHistory(run, { event: 'workflow_child_retried', child_id: childId, attempt: child.attempt }, at),
        });
        await writeAtomic(workflowPath(dir, workflowId), updated);
        return { run: updated, child };
    });
}
export function serializeWorkflowRun(record) {
    const run = validateWorkflowRun(record);
    return {
        workflow_id: run.workflow_id,
        workflow_type: run.workflow_type,
        repository_id: run.repository_id,
        request_key: run.request_key,
        source_sha: run.source_sha,
        state: run.state,
        policy: { ...run.policy },
        current_iteration: run.current_iteration,
        child_count: run.children.length,
        children: run.children.map(childPublicShape),
        created_at: run.created_at,
        updated_at: run.updated_at,
    };
}
//# sourceMappingURL=workflow-run-store.js.map