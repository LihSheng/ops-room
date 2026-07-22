import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { writeAtomic } from './review-task-store.js';
import { listWorkflowEffects } from './workflow-effect-store.js';
import {
  reconcileReviewDecisionFromEffects,
} from './workflow-provider-advancement.js';
import {
  listWorkflowRuns,
  readWorkflowRun,
  validateWorkflowRun,
} from './workflow-run-store.js';
import { requestWorkspaceCleanup } from './workspace-manager.js';
import {
  readWorkspaceRecord,
  updateWorkspaceRecord,
} from './workspace-store.js';
import { withWorkspaceLock } from './workspace-locks.js';

const execFileDefault = promisify(execFileCallback);
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const INTERRUPTED_CHILD_REASON = 'workflow_child_interrupted';
const RECOVERY_CLEANUP_PENDING = 'workflow_recovery_cleanup_pending';
const RETRYABLE_EFFECT_STATES = new Set(['failed', 'needs_human']);
const DEFAULT_RECOVERY_LOCK_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function workflowDigest(value: string, length = 32) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function workflowFilename(workflowId: string) {
  if (!SAFE_ID.test(String(workflowId || ''))) throw new Error('invalid_workflow_id');
  return `workflow-${createHash('sha256').update(workflowId).digest('hex')}.json`;
}

function workflowPath(dir: string, workflowId: string) {
  return join(dir, workflowFilename(workflowId));
}

function childEffectType(child: any) {
  return `provider.${child.owner_agent}.${child.stage}`;
}

function attemptKey(attempt: unknown) {
  const normalized = Number(attempt);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 100) {
    throw new Error('workflow_retry_attempt_invalid');
  }
  return `attempt:${normalized}`;
}

function safeWorkspacePath(workspaceRoot: string, relativePath: unknown) {
  const root = resolve(workspaceRoot);
  const target = resolve(root, String(relativePath || ''));
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('workflow_recovery_workspace_path_invalid');
  }
  return target;
}

function validateWorkspaceOwnership({ run, child, record }: any) {
  const binding = child?.workspace;
  if (!binding?.workspace_id) throw new Error('workflow_child_workspace_binding_missing');
  if (record.workspace_id !== binding.workspace_id) throw new Error('workflow_child_workspace_id_mismatch');
  if (record.task_id !== child.child_id) throw new Error('workflow_child_workspace_task_mismatch');
  if (record.owner_agent !== child.owner_agent) throw new Error('workflow_child_workspace_owner_mismatch');
  if (record.repository_id !== run.repository_id) throw new Error('workflow_child_workspace_repository_mismatch');
  if (record.mode !== binding.mode) throw new Error('workflow_child_workspace_mode_mismatch');
  if ((record.branch || null) !== (binding.branch || null)) throw new Error('workflow_child_workspace_branch_mismatch');
  return record;
}

async function currentAttemptEffect({
  effectsDir,
  workflowId,
  child,
  listEffects = listWorkflowEffects,
}: any) {
  const effects = await listEffects({
    dir: effectsDir,
    workflowId,
    childId: child.child_id,
    limit: 200,
  });
  const matches = effects.filter((effect: any) => (
    effect.effect_type === childEffectType(child)
    && effect.idempotency_key === attemptKey(child.attempt)
  ));
  if (matches.length > 1) throw new Error('workflow_recovery_effect_ambiguous');
  return matches[0] || null;
}

async function exactWorkspaceHead({
  run,
  child,
  recordRoot,
  workspaceRoot,
  inspectWorkspaceHead,
  readRecord = readWorkspaceRecord,
}: any) {
  const record = validateWorkspaceOwnership({
    run,
    child,
    record: await readRecord({ dir: recordRoot, workspaceId: child.workspace.workspace_id }),
  });
  if (!['active', 'held_for_investigation'].includes(record.state)) {
    throw new Error('workflow_recovery_workspace_not_inspectable');
  }
  const cwd = safeWorkspacePath(workspaceRoot, record.relative_path);
  const head = String(await inspectWorkspaceHead({ cwd, run, child, workspace: record }) || '').trim().toLowerCase();
  if (!SAFE_SHA.test(head)) throw new Error('workflow_recovery_workspace_head_invalid');
  return { record, cwd, head };
}

async function persistRun({ workflowRunsDir, workflowId, record }: any) {
  const validated = validateWorkflowRun(record);
  await writeAtomic(workflowPath(workflowRunsDir, workflowId), validated);
  return validated;
}

async function ensureRecoveredWorkspaceCleanup({
  run,
  child,
  recordRoot,
  requestCleanup = requestWorkspaceCleanup,
  readRecord = readWorkspaceRecord,
  now,
}: any) {
  const record = validateWorkspaceOwnership({
    run,
    child,
    record: await readRecord({ dir: recordRoot, workspaceId: child.workspace.workspace_id }),
  });
  if (record.state === 'cleanup_requested' || record.state === 'released') {
    return { workspace: record, idempotent: true };
  }
  if (record.state !== 'active' && record.state !== 'failed') {
    throw new Error('workflow_recovery_workspace_cleanup_not_safe');
  }
  const workspace = await requestCleanup({
    recordRoot,
    workspaceId: record.workspace_id,
    now,
  });
  return { workspace, idempotent: false };
}

async function finalizeRecoveryCleanup({
  workflowRunsDir,
  workflowId,
  run,
  child,
  recordRoot,
  requestCleanup,
  readRecord,
  now,
}: any) {
  const cleanup = await ensureRecoveredWorkspaceCleanup({
    run,
    child,
    recordRoot,
    requestCleanup,
    readRecord,
    now,
  });
  const at = now();
  const index = run.children.findIndex((candidate: any) => candidate.child_id === child.child_id);
  if (index < 0) throw new Error('workflow_child_not_found');
  const finalizedChild = {
    ...run.children[index],
    recovery_cleanup_pending: false,
    updated_at: at,
    history: [
      ...(run.children[index].history || []),
      {
        event: 'workflow_recovery_cleanup_reconciled',
        workspace_id: child.workspace.workspace_id,
        at,
      },
    ],
  };
  const children = [...run.children];
  children[index] = finalizedChild;
  const updated = await persistRun({
    workflowRunsDir,
    workflowId,
    record: {
      ...run,
      state: 'active',
      last_error: null,
      completed_at: null,
      updated_at: at,
      children,
      history: [
        ...(run.history || []),
        {
          event: 'workflow_recovery_cleanup_reconciled',
          child_id: child.child_id,
          workspace_id: child.workspace.workspace_id,
          at,
        },
      ],
    },
  });
  return { run: updated, child: finalizedChild, cleanup };
}

async function reconcileOneWorkflow({
  workflowRunsDir,
  workflowId,
  effectsDir,
  workspaceRoot,
  recordRoot,
  inspectWorkspaceHead,
  requestCleanup,
  readRun,
  listEffects,
  readRecord,
  now,
}: any) {
  return withWorkspaceLock({
    dir: join(workflowRunsDir, '.advancement-locks'),
    name: `workflow-advance-${workflowDigest(workflowId)}`,
    staleAfterMs: DEFAULT_RECOVERY_LOCK_STALE_AFTER_MS,
    execute: async () => {
      let run = await readRun({ dir: workflowRunsDir, workflowId });
      const pendingCleanup = run.children.filter((child: any) => (
        child.state === 'completed' && child.recovery_cleanup_pending === true
      ));
      if (pendingCleanup.length > 1) throw new Error('workflow_recovery_cleanup_ambiguous');
      if (pendingCleanup.length === 1) {
        const finalized = await finalizeRecoveryCleanup({
          workflowRunsDir,
          workflowId,
          run,
          child: pendingCleanup[0],
          recordRoot,
          requestCleanup,
          readRecord,
          now,
        });
        return {
          changed: true,
          recovered_child: null,
          cleanup_reconciled: finalized.child.child_id,
          review_child: finalized.child.stage === 'review' ? finalized.child : null,
        };
      }

      const interrupted = run.children.filter((child: any) => (
        child.state === 'needs_human' && child.last_error === INTERRUPTED_CHILD_REASON
      ));
      if (interrupted.length === 0) {
        return { changed: false, recovered_child: null, cleanup_reconciled: null, review_child: null };
      }
      if (interrupted.length > 1) throw new Error('workflow_recovery_interrupted_children_ambiguous');

      const child = interrupted[0];
      const effect = await currentAttemptEffect({
        effectsDir,
        workflowId,
        child,
        listEffects,
      });
      if (!effect || effect.state !== 'completed') {
        return {
          changed: false,
          recovered_child: null,
          cleanup_reconciled: null,
          review_child: null,
          reason: 'workflow_recovery_completed_effect_unavailable',
        };
      }
      const outputSha = String(effect.output_sha || '').toLowerCase();
      if (!SAFE_SHA.test(outputSha)) throw new Error('workflow_recovery_effect_output_sha_invalid');
      if (child.stage === 'review') {
        if (effect.result_code !== 'review.approved' && !String(effect.result_code || '').startsWith('review.changes_requested:')) {
          throw new Error('workflow_recovery_review_decision_unavailable');
        }
        if (outputSha !== child.input_sha) throw new Error('workflow_review_output_sha_mismatch');
      } else if (effect.result_code !== 'ok') {
        throw new Error('workflow_recovery_effect_result_invalid');
      }

      const workspace = await exactWorkspaceHead({
        run,
        child,
        recordRoot,
        workspaceRoot,
        inspectWorkspaceHead,
        readRecord,
      });
      if (workspace.record.state !== 'active') {
        throw new Error('workflow_recovery_workspace_not_active');
      }
      if (workspace.head !== outputSha) throw new Error('workflow_recovery_workspace_head_mismatch');

      const at = now();
      const index = run.children.findIndex((candidate: any) => candidate.child_id === child.child_id);
      const recoveredChild = {
        ...child,
        state: 'completed',
        output_sha: outputSha,
        completed_at: at,
        updated_at: at,
        last_error: null,
        recovery_cleanup_pending: true,
        recovered_effect_id: effect.effect_id,
        history: [
          ...(child.history || []),
          {
            from: 'needs_human',
            to: 'completed',
            reason: 'workflow_child_recovered_from_completed_effect',
            effect_id: effect.effect_id,
            at,
          },
        ],
      };
      const children = [...run.children];
      children[index] = recoveredChild;
      run = await persistRun({
        workflowRunsDir,
        workflowId,
        record: {
          ...run,
          state: 'needs_human',
          last_error: RECOVERY_CLEANUP_PENDING,
          completed_at: null,
          updated_at: at,
          children,
          history: [
            ...(run.history || []),
            {
              event: 'workflow_child_recovered_from_completed_effect',
              child_id: child.child_id,
              effect_id: effect.effect_id,
              at,
            },
          ],
        },
      });

      const finalized = await finalizeRecoveryCleanup({
        workflowRunsDir,
        workflowId,
        run,
        child: recoveredChild,
        recordRoot,
        requestCleanup,
        readRecord,
        now,
      });
      return {
        changed: true,
        recovered_child: finalized.child.child_id,
        cleanup_reconciled: finalized.child.child_id,
        review_child: finalized.child.stage === 'review' ? finalized.child : null,
      };
    },
  });
}

export async function inspectGitWorkspaceHead({
  cwd,
  execFile = execFileDefault,
}: any) {
  try {
    const result = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    const head = String(result?.stdout || '').trim().toLowerCase();
    if (!SAFE_SHA.test(head)) throw new Error('workflow_recovery_workspace_head_invalid');
    return head;
  } catch (error: any) {
    if (error?.message === 'workflow_recovery_workspace_head_invalid') throw error;
    throw new Error('workflow_recovery_workspace_head_unavailable');
  }
}

export async function reconcileProviderBackedWorkflowRuns({
  workflowRunsDir,
  effectsDir,
  workspaceRoot,
  recordRoot,
  inspectWorkspaceHead = inspectGitWorkspaceHead,
  requestCleanup = requestWorkspaceCleanup,
  readRun = readWorkflowRun,
  listRuns = listWorkflowRuns,
  listEffects = listWorkflowEffects,
  readRecord = readWorkspaceRecord,
  reconcileReviewDecision = reconcileReviewDecisionFromEffects,
  now = () => new Date().toISOString(),
}: any) {
  if (!workflowRunsDir || !effectsDir || !workspaceRoot || !recordRoot) {
    throw new Error('workflow_provider_recovery_input_invalid');
  }
  const records = await listRuns({ dir: workflowRunsDir, limit: 500 });
  const recovered: string[] = [];
  const cleanupReconciled: string[] = [];
  const reviewDecisions: string[] = [];
  const unavailable: string[] = [];

  for (const record of records) {
    if (!SAFE_ID.test(String(record?.workflow_id || '')) || record?.last_error === 'workflow_record_unavailable') {
      unavailable.push(String(record?.workflow_id || 'workflow-unavailable'));
      continue;
    }
    try {
      const result = await reconcileOneWorkflow({
        workflowRunsDir,
        workflowId: record.workflow_id,
        effectsDir,
        workspaceRoot,
        recordRoot,
        inspectWorkspaceHead,
        requestCleanup,
        readRun,
        listEffects,
        readRecord,
        now,
      });
      if (result.recovered_child) recovered.push(result.recovered_child);
      if (result.cleanup_reconciled) cleanupReconciled.push(result.cleanup_reconciled);

      const decision = await reconcileReviewDecision({
        workflowRunsDir,
        workflowId: record.workflow_id,
        effectsDir,
        now,
      });
      if (decision?.reconciled) reviewDecisions.push(decision.child.child_id);
    } catch {
      unavailable.push(record.workflow_id);
    }
  }

  return {
    scanned_workflows: records.length,
    recovered_children: recovered.length,
    recovered,
    cleanup_reconciled: cleanupReconciled.length,
    cleanup_children: cleanupReconciled,
    review_decisions_reconciled: reviewDecisions.length,
    review_decisions: reviewDecisions,
    unavailable,
  };
}

export async function retryWorkflowChildAfterInvestigation({
  workflowRunsDir,
  workflowId,
  childId,
  expectedAttempt,
  effectsDir,
  workspaceRoot,
  recordRoot,
  inspectWorkspaceHead = inspectGitWorkspaceHead,
  readRun = readWorkflowRun,
  listEffects = listWorkflowEffects,
  readRecord = readWorkspaceRecord,
  updateRecord = updateWorkspaceRecord,
  now = () => new Date().toISOString(),
}: any) {
  const normalizedExpectedAttempt = Number(expectedAttempt);
  attemptKey(normalizedExpectedAttempt);
  return withWorkspaceLock({
    dir: join(workflowRunsDir, '.advancement-locks'),
    name: `workflow-advance-${workflowDigest(workflowId)}`,
    staleAfterMs: DEFAULT_RECOVERY_LOCK_STALE_AFTER_MS,
    execute: async () => {
      const run = await readRun({ dir: workflowRunsDir, workflowId });
      const index = run.children.findIndex((child: any) => child.child_id === childId);
      if (index < 0) throw new Error('workflow_child_not_found');
      const child = run.children[index];

      if (
        run.state === 'active'
        && child.state === 'pending'
        && child.attempt === normalizedExpectedAttempt + 1
      ) {
        return { run, child, idempotent: true };
      }
      if (run.state !== 'needs_human') throw new Error('workflow_retry_run_not_needs_human');
      if (child.state !== 'needs_human') throw new Error('workflow_retry_child_not_needs_human');
      if (child.attempt !== normalizedExpectedAttempt) throw new Error('workflow_retry_attempt_conflict');

      const effect = await currentAttemptEffect({ effectsDir, workflowId, child, listEffects });
      if (!effect) throw new Error('workflow_retry_effect_unavailable');
      if (!RETRYABLE_EFFECT_STATES.has(effect.state)) {
        throw new Error(effect.state === 'completed'
          ? 'workflow_retry_completed_effect_forbidden'
          : 'workflow_retry_effect_not_terminal');
      }

      const workspace = await exactWorkspaceHead({
        run,
        child,
        recordRoot,
        workspaceRoot,
        inspectWorkspaceHead,
        readRecord,
      });
      if (workspace.head !== child.input_sha) throw new Error('workflow_retry_workspace_head_changed');
      if (workspace.record.state === 'held_for_investigation') {
        await updateRecord({
          dir: recordRoot,
          workspaceId: workspace.record.workspace_id,
          patch: {
            state: 'active',
            hold_reason: null,
            last_error: null,
          },
          now,
        });
      }

      const at = now();
      const retriedChild = {
        ...child,
        state: 'pending',
        attempt: child.attempt + 1,
        started_at: null,
        completed_at: null,
        output_sha: null,
        updated_at: at,
        last_error: null,
        recovery_cleanup_pending: false,
        recovered_effect_id: null,
        history: [
          ...(child.history || []),
          {
            from: 'needs_human',
            to: 'pending',
            reason: 'workflow_child_retry_after_investigation',
            previous_effect_id: effect.effect_id,
            attempt: child.attempt + 1,
            at,
          },
        ],
      };
      const children = [...run.children];
      children[index] = retriedChild;
      const updated = await persistRun({
        workflowRunsDir,
        workflowId,
        record: {
          ...run,
          state: 'active',
          last_error: null,
          completed_at: null,
          updated_at: at,
          children,
          history: [
            ...(run.history || []),
            {
              event: 'workflow_child_retry_after_investigation',
              child_id: child.child_id,
              previous_effect_id: effect.effect_id,
              attempt: child.attempt + 1,
              at,
            },
          ],
        },
      });
      return { run: updated, child: retriedChild, idempotent: false, previous_effect: effect };
    },
  });
}

export async function resumePendingWorkflowAfterInvestigation({
  workflowRunsDir,
  workflowId,
  childId,
  expectedAttempt,
  effectsDir,
  workspaceRoot,
  recordRoot,
  inspectWorkspaceHead = inspectGitWorkspaceHead,
  readRun = readWorkflowRun,
  listEffects = listWorkflowEffects,
  readRecord = readWorkspaceRecord,
  now = () => new Date().toISOString(),
}: any) {
  const normalizedExpectedAttempt = Number(expectedAttempt);
  attemptKey(normalizedExpectedAttempt);
  return withWorkspaceLock({
    dir: join(workflowRunsDir, '.advancement-locks'),
    name: `workflow-advance-${workflowDigest(workflowId)}`,
    staleAfterMs: DEFAULT_RECOVERY_LOCK_STALE_AFTER_MS,
    execute: async () => {
      const run = await readRun({ dir: workflowRunsDir, workflowId });
      const index = run.children.findIndex((child: any) => child.child_id === childId);
      if (index < 0) throw new Error('workflow_child_not_found');
      const child = run.children[index];
      if (
        run.state === 'active'
        && child.state === 'pending'
        && child.attempt === normalizedExpectedAttempt
      ) {
        return { run, child, idempotent: true };
      }
      if (run.state !== 'needs_human') throw new Error('workflow_resume_run_not_needs_human');
      if (child.state !== 'pending') throw new Error('workflow_resume_child_not_pending');
      if (child.attempt !== normalizedExpectedAttempt) throw new Error('workflow_resume_attempt_conflict');

      const effect = await currentAttemptEffect({ effectsDir, workflowId, child, listEffects });
      if (effect) throw new Error('workflow_resume_provider_effect_exists');

      if (child.workspace?.workspace_id) {
        const workspace = await exactWorkspaceHead({
          run,
          child,
          recordRoot,
          workspaceRoot,
          inspectWorkspaceHead,
          readRecord,
        });
        if (workspace.record.state !== 'active') throw new Error('workflow_resume_workspace_not_active');
        if (workspace.head !== child.input_sha) throw new Error('workflow_resume_workspace_head_changed');
      }

      const at = now();
      const updated = await persistRun({
        workflowRunsDir,
        workflowId,
        record: {
          ...run,
          state: 'active',
          last_error: null,
          completed_at: null,
          updated_at: at,
          history: [
            ...(run.history || []),
            {
              event: 'workflow_resumed_after_investigation',
              child_id: child.child_id,
              attempt: child.attempt,
              at,
            },
          ],
        },
      });
      return { run: updated, child: updated.children[index], idempotent: false };
    },
  });
}

export {
  INTERRUPTED_CHILD_REASON,
  RECOVERY_CLEANUP_PENDING,
};
