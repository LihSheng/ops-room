import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeAtomic } from './review-task-store.js';
import { serializeTaskWorkspace } from './task-workspace-binding.js';
import { ensureWorkflowChildWorkspace } from './workflow-child-workspace.js';
import { requestWorkspaceCleanup } from './workspace-manager.js';
import { readWorkspaceRecord, updateWorkspaceRecord } from './workspace-store.js';
import { activateWorkflowChild, completeWorkflowChild, readWorkflowRun, validateWorkflowRun, } from './workflow-run-store.js';
import { withWorkspaceLock } from './workspace-locks.js';
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_REASON = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const EXECUTABLE_RUN_STATES = new Set(['planned', 'active']);
const WORKSPACE_HOLDABLE_STATES = new Set(['active', 'failed', 'cleanup_requested']);
const DEFAULT_EXECUTION_LOCK_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
function workflowDigest(value, length = 32) {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}
function workflowFilename(workflowId) {
    return `workflow-${createHash('sha256').update(workflowId).digest('hex')}.json`;
}
function workflowPath(dir, workflowId) {
    return join(dir, workflowFilename(workflowId));
}
function findChild(run, childId) {
    const child = run.children.find((candidate) => candidate.child_id === childId);
    if (!child)
        throw new Error('workflow_child_not_found');
    return child;
}
function boundedReason(value, fallback = 'workflow_child_needs_human') {
    const normalized = String(value || '').trim().toLowerCase();
    return SAFE_REASON.test(normalized) ? normalized : fallback;
}
function boundedRun(run) {
    return {
        workflow_id: run.workflow_id,
        workflow_type: run.workflow_type,
        repository_id: run.repository_id,
        source_sha: run.source_sha,
        state: run.state,
        current_iteration: run.current_iteration,
        policy: { ...run.policy },
    };
}
function boundedChild(child) {
    return {
        child_id: child.child_id,
        stage: child.stage,
        owner_agent: child.owner_agent,
        iteration: child.iteration,
        attempt: child.attempt,
        state: child.state,
        depends_on: child.depends_on,
        input_sha: child.input_sha,
    };
}
function validateExecutionOutcome(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('workflow_child_execution_result_invalid');
    }
    if (value.outcome === 'needs_human') {
        return {
            outcome: 'needs_human',
            reason: boundedReason(value.reason),
        };
    }
    if (value.outcome !== 'completed') {
        throw new Error('workflow_child_execution_outcome_invalid');
    }
    const outputSha = String(value.output_sha || '').toLowerCase();
    if (!SAFE_SHA.test(outputSha))
        throw new Error('workflow_child_output_sha_invalid');
    return {
        outcome: 'completed',
        output_sha: outputSha,
    };
}
function validateWorkspaceOwnership({ run, child, record }) {
    const workspaceId = child?.workspace?.workspace_id;
    if (!workspaceId)
        throw new Error('workflow_child_workspace_binding_missing');
    if (record.workspace_id !== workspaceId)
        throw new Error('workflow_child_workspace_id_mismatch');
    if (record.task_id !== child.child_id)
        throw new Error('workflow_child_workspace_task_mismatch');
    if (record.owner_agent !== child.owner_agent)
        throw new Error('workflow_child_workspace_owner_mismatch');
    if (record.repository_id !== run.repository_id)
        throw new Error('workflow_child_workspace_repository_mismatch');
    return record;
}
async function markWorkflowChildNeedsHuman({ workflowRunsDir, workflowId, childId, reason, now, }) {
    const run = await readWorkflowRun({ dir: workflowRunsDir, workflowId });
    const index = run.children.findIndex((child) => child.child_id === childId);
    if (index < 0)
        throw new Error('workflow_child_not_found');
    const current = run.children[index];
    const safeReason = boundedReason(reason, 'workflow_child_execution_failed');
    if (current.state === 'needs_human' && current.last_error === safeReason) {
        return { run, child: current, idempotent: true };
    }
    if (current.state === 'completed')
        throw new Error('workflow_child_completion_immutable');
    if (current.state !== 'active') {
        throw new Error(`workflow_child_not_markable_needs_human:${current.state}`);
    }
    const at = now();
    const child = {
        ...current,
        state: 'needs_human',
        updated_at: at,
        last_error: safeReason,
        history: [
            ...(current.history || []),
            { from: current.state, to: 'needs_human', at, reason: safeReason },
        ],
    };
    const children = [...run.children];
    children[index] = child;
    const updated = validateWorkflowRun({
        ...run,
        state: 'needs_human',
        updated_at: at,
        children,
        history: [
            ...(run.history || []),
            { event: 'workflow_child_needs_human', child_id: childId, reason: safeReason, at },
        ],
    });
    await writeAtomic(workflowPath(workflowRunsDir, workflowId), updated);
    return { run: updated, child, idempotent: false };
}
async function applyWorkflowWorkspaceOutcome({ run, child, recordRoot, outcome, reason, readRecord = readWorkspaceRecord, requestCleanup = requestWorkspaceCleanup, updateRecord = updateWorkspaceRecord, now, }) {
    const workspaceId = child?.workspace?.workspace_id;
    if (!workspaceId)
        throw new Error('workflow_child_workspace_binding_missing');
    const record = validateWorkspaceOwnership({
        run,
        child,
        record: await readRecord({ dir: recordRoot, workspaceId }),
    });
    if (outcome === 'completed') {
        if (record.state === 'cleanup_requested' || record.state === 'released') {
            return { action: 'cleanup', workspace: record, idempotent: true };
        }
        if (record.state !== 'active')
            throw new Error('workflow_child_workspace_cleanup_not_safe');
        const workspace = await requestCleanup({ recordRoot, workspaceId, now });
        return { action: 'cleanup', workspace, idempotent: false };
    }
    if (record.state === 'held_for_investigation') {
        return { action: 'hold', workspace: record, idempotent: true };
    }
    if (!WORKSPACE_HOLDABLE_STATES.has(record.state)) {
        throw new Error('workflow_child_workspace_hold_not_safe');
    }
    const workspace = await updateRecord({
        dir: recordRoot,
        workspaceId,
        patch: {
            state: 'held_for_investigation',
            hold_reason: boundedReason(reason, 'workflow_child_needs_human'),
        },
        now,
    });
    return { action: 'hold', workspace, idempotent: false };
}
function terminalResult({ run, child, workspacePolicy, deduplicated = false }) {
    const workspace = workspacePolicy?.workspace
        ? serializeTaskWorkspace(workspacePolicy.workspace)
        : child.workspace || null;
    return {
        run: boundedRun(run),
        child: {
            ...boundedChild(child),
            state: child.state,
            output_sha: child.output_sha || null,
            last_error: child.last_error || null,
            workspace: child.workspace || null,
        },
        workspace_action: workspacePolicy?.action || 'none',
        workspace,
        deduplicated,
    };
}
export async function executeWorkflowChild({ workflowRunsDir, workflowId, childId, cacheRoot, workspaceRoot, recordRoot, lockRoot, remote, maxActiveWorkspaces, minimumFreeBytes, getFreeBytes, runStage, inspectWorkspaceHead, ensureChildWorkspace = ensureWorkflowChildWorkspace, readRun = readWorkflowRun, activateChild = activateWorkflowChild, completeChild = completeWorkflowChild, markNeedsHuman = markWorkflowChildNeedsHuman, applyWorkspaceOutcome = applyWorkflowWorkspaceOutcome, executionLockDir = join(workflowRunsDir, '.locks'), executionLockTimeoutMs = 10_000, executionLockStaleAfterMs = DEFAULT_EXECUTION_LOCK_STALE_AFTER_MS, now = () => new Date().toISOString(), }) {
    if (typeof runStage !== 'function')
        throw new Error('workflow_child_stage_runner_required');
    if (!workflowRunsDir || !workflowId || !childId || !recordRoot || !workspaceRoot) {
        throw new Error('workflow_child_execution_input_invalid');
    }
    return withWorkspaceLock({
        dir: executionLockDir,
        name: `workflow-exec-${workflowDigest(`${workflowId}\n${childId}`)}`,
        timeoutMs: executionLockTimeoutMs,
        staleAfterMs: executionLockStaleAfterMs,
        execute: async () => {
            let run = await readRun({ dir: workflowRunsDir, workflowId });
            let child = findChild(run, childId);
            if (child.state === 'completed' || child.state === 'needs_human') {
                const workspacePolicy = child.workspace?.workspace_id
                    ? await applyWorkspaceOutcome({
                        run,
                        child,
                        recordRoot,
                        outcome: child.state === 'completed' ? 'completed' : 'needs_human',
                        reason: child.last_error || undefined,
                        now,
                    })
                    : null;
                return terminalResult({ run, child, workspacePolicy, deduplicated: true });
            }
            if (!EXECUTABLE_RUN_STATES.has(run.state))
                throw new Error(`workflow_run_not_executable:${run.state}`);
            if (child.state === 'active')
                throw new Error('workflow_child_execution_in_progress');
            if (child.state !== 'pending')
                throw new Error(`workflow_child_not_executable:${child.state}`);
            if (!child.workspace?.workspace_id)
                throw new Error('workflow_child_workspace_binding_missing');
            const binding = await ensureChildWorkspace({
                workflowRunsDir,
                workflowId,
                childId,
                cacheRoot,
                workspaceRoot,
                recordRoot,
                lockRoot,
                remote,
                maxActiveWorkspaces,
                minimumFreeBytes,
                getFreeBytes,
            });
            const activated = await activateChild({ dir: workflowRunsDir, workflowId, childId, now });
            run = activated.run;
            child = activated.child;
            let outcome;
            try {
                outcome = validateExecutionOutcome(await runStage({
                    run: boundedRun(run),
                    child: boundedChild(child),
                    workspace_path: binding.workspace_path,
                    workspace: binding.workspace,
                }));
                if (outcome.outcome === 'completed') {
                    if (child.stage === 'review') {
                        if (outcome.output_sha !== child.input_sha) {
                            throw new Error('workflow_review_output_sha_mismatch');
                        }
                    }
                    else {
                        if (typeof inspectWorkspaceHead !== 'function') {
                            throw new Error('workflow_workspace_head_inspector_required');
                        }
                        const actualSha = String(await inspectWorkspaceHead({
                            cwd: binding.workspace_path,
                            run: boundedRun(run),
                            child: boundedChild(child),
                        }) || '').toLowerCase();
                        if (!SAFE_SHA.test(actualSha))
                            throw new Error('workflow_workspace_head_invalid');
                        if (actualSha !== outcome.output_sha)
                            throw new Error('workflow_child_output_sha_mismatch');
                    }
                }
            }
            catch (error) {
                const reason = boundedReason(error?.message, 'workflow_child_runner_failed');
                const terminal = await markNeedsHuman({
                    workflowRunsDir,
                    workflowId,
                    childId,
                    reason,
                    now,
                });
                const workspacePolicy = await applyWorkspaceOutcome({
                    run: terminal.run,
                    child: terminal.child,
                    recordRoot,
                    outcome: 'needs_human',
                    reason,
                    now,
                });
                return terminalResult({
                    run: terminal.run,
                    child: terminal.child,
                    workspacePolicy,
                });
            }
            if (outcome.outcome === 'needs_human') {
                const terminal = await markNeedsHuman({
                    workflowRunsDir,
                    workflowId,
                    childId,
                    reason: outcome.reason,
                    now,
                });
                const workspacePolicy = await applyWorkspaceOutcome({
                    run: terminal.run,
                    child: terminal.child,
                    recordRoot,
                    outcome: 'needs_human',
                    reason: outcome.reason,
                    now,
                });
                return terminalResult({
                    run: terminal.run,
                    child: terminal.child,
                    workspacePolicy,
                });
            }
            const terminal = await completeChild({
                dir: workflowRunsDir,
                workflowId,
                childId,
                outputSha: outcome.output_sha,
                now,
            });
            const workspacePolicy = await applyWorkspaceOutcome({
                run: terminal.run,
                child: terminal.child,
                recordRoot,
                outcome: 'completed',
                now,
            });
            return terminalResult({
                run: terminal.run,
                child: terminal.child,
                workspacePolicy,
            });
        },
    });
}
//# sourceMappingURL=workflow-child-execution.js.map