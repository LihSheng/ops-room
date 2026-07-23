import {
  FEATURE_DEVELOPMENT_OWNERS,
  FEATURE_DEVELOPMENT_STAGES,
} from './workflow-run-store.js';
import { serializeMission } from './mission-store.js';

const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SOURCE_STATES = new Set(['available', 'degraded', 'unavailable', 'not_applicable']);

function bounded(value: unknown, maximum = 240): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function timestamp(value: unknown): number {
  const parsed = value ? new Date(String(value)).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationSeconds(startedAt: unknown, completedAt: unknown): number | null {
  const start = timestamp(startedAt);
  const end = timestamp(completedAt);
  if (!start || !end || end < start) return null;
  return Math.round((end - start) / 1000);
}

function sourceState(value: unknown) {
  const normalized = String(value || 'unavailable');
  return SOURCE_STATES.has(normalized) ? normalized : 'unavailable';
}

function publicWorkspace(record: any) {
  if (!record) return null;
  try {
    const workspaceId = bounded(record.workspace_id, 120);
    const repositoryId = bounded(record.repository_id, 220);
    const mode = bounded(record.mode, 20);
    const state = bounded(record.state, 40);
    const resolvedSha = bounded(record.resolved_sha, 40)?.toLowerCase() || null;
    const branch = record.branch == null ? null : bounded(record.branch, 240);
    if (!workspaceId || !SAFE_ID.test(workspaceId)) throw new Error('invalid_workspace_id');
    if (!repositoryId || !mode || !state) throw new Error('invalid_workspace_evidence');
    if (!['branch', 'detached'].includes(mode)) throw new Error('invalid_workspace_mode');
    if (resolvedSha && !SAFE_SHA.test(resolvedSha)) throw new Error('invalid_workspace_sha');
    return {
      workspace_id: workspaceId,
      mode,
      state,
      repository_id: repositoryId,
      branch,
      resolved_sha: resolvedSha,
      held_for_investigation: state === 'held_for_investigation' || Boolean(record.held_for_investigation),
      cleanup_requested: state === 'cleanup_requested' || Boolean(record.cleanup_requested),
      created_at: bounded(record.created_at, 64),
      updated_at: bounded(record.updated_at, 64),
      unavailable: false,
      last_error: null,
    };
  } catch {
    return {
      workspace_id: bounded(record?.workspace_id, 120) || 'workspace-unavailable',
      mode: null,
      state: 'failed',
      repository_id: null,
      branch: null,
      resolved_sha: null,
      held_for_investigation: false,
      cleanup_requested: false,
      created_at: null,
      updated_at: null,
      unavailable: true,
      last_error: 'workspace_evidence_unavailable',
    };
  }
}

function publicEffect(effect: any) {
  if (!effect) return null;
  try {
    const effectId = bounded(effect.effect_id, 200);
    const effectType = bounded(effect.effect_type, 80);
    const state = bounded(effect.state, 40);
    if (!effectId || !SAFE_ID.test(effectId) || !effectType || !state) {
      throw new Error('invalid_effect_evidence');
    }
    const outputSha = bounded(effect.output_sha, 40)?.toLowerCase() || null;
    if (outputSha && !SAFE_SHA.test(outputSha)) throw new Error('invalid_effect_sha');
    return {
      effect_id: effectId,
      effect_type: effectType,
      state,
      attempt: Number.isInteger(effect.attempt) ? effect.attempt : null,
      claimed_at: bounded(effect.claimed_at, 64),
      completed_at: bounded(effect.completed_at, 64),
      output_sha: outputSha,
      result_code: bounded(effect.result_code, 120),
      unavailable: false,
      last_error: null,
    };
  } catch {
    return {
      effect_id: bounded(effect?.effect_id, 200) || 'effect-unavailable',
      effect_type: null,
      state: 'needs_human',
      attempt: null,
      claimed_at: null,
      completed_at: null,
      output_sha: null,
      result_code: null,
      unavailable: true,
      last_error: 'provider_effect_evidence_unavailable',
    };
  }
}

function publicHistory(child: any) {
  return Array.isArray(child?.history)
    ? child.history.slice(-20).map((entry: any) => ({
        event: bounded(entry?.event, 100) || 'workflow_event',
        reason: bounded(entry?.reason, 120),
        at: bounded(entry?.at, 64),
      }))
    : [];
}

function verificationFor(child: any, effect: any) {
  if (!child) return { status: 'not_started', reason: null };
  if (child.state === 'pending') return { status: 'pending', reason: null };
  if (child.state === 'active') return { status: 'in_progress', reason: null };
  if (child.state === 'needs_human' || child.state === 'failed') {
    return {
      status: 'attention',
      reason: bounded(child.last_error || effect?.result_code, 120) || 'workflow_stage_needs_human',
    };
  }
  if (child.state === 'cancelled') return { status: 'cancelled', reason: null };
  if (child.state !== 'completed') return { status: 'unavailable', reason: 'workflow_stage_state_unavailable' };
  if (!SAFE_SHA.test(String(child.output_sha || ''))) {
    return { status: 'attention', reason: 'workflow_stage_output_sha_unavailable' };
  }
  if (!effect) return { status: 'degraded', reason: 'provider_effect_unavailable' };
  if (effect.unavailable) return { status: 'degraded', reason: effect.last_error };
  if (effect.state !== 'completed') {
    return { status: 'attention', reason: bounded(effect.result_code, 120) || 'provider_effect_incomplete' };
  }
  if (effect.output_sha && String(effect.output_sha).toLowerCase() !== String(child.output_sha).toLowerCase()) {
    return { status: 'attention', reason: 'provider_effect_output_sha_mismatch' };
  }
  return { status: 'verified', reason: null };
}

function selectWorkspace(child: any, workspaces: any[]) {
  if (!child) return null;
  const embedded = child.workspace ? publicWorkspace(child.workspace) : null;
  const candidates = workspaces
    .filter((workspace) => String(workspace?.task_id || '') === child.child_id)
    .sort((left, right) => timestamp(right?.updated_at) - timestamp(left?.updated_at));
  return embedded || publicWorkspace(candidates[0]);
}

function selectEffects(child: any, effects: any[]) {
  if (!child) return { latest: null, count: 0 };
  const matches = effects
    .filter((effect) => String(effect?.child_id || '') === child.child_id)
    .sort((left, right) => timestamp(right?.claimed_at) - timestamp(left?.claimed_at));
  return { latest: publicEffect(matches[0]), count: matches.length };
}

function timelineStage({ iteration, stage, child, workspaces, effects, sourceStates }: any) {
  const ownerAgent = FEATURE_DEVELOPMENT_OWNERS[stage];
  const workspace = selectWorkspace(child, workspaces);
  const effectSelection = selectEffects(child, effects);
  const verification = verificationFor(child, effectSelection.latest);
  const workspaceEvidence = !child
    ? 'not_applicable'
    : workspace
      ? (workspace.unavailable ? 'degraded' : 'available')
      : sourceStates.workspaces === 'unavailable'
        ? 'unavailable'
        : ['pending'].includes(child.state)
          ? 'not_applicable'
          : 'degraded';
  const effectEvidence = !child
    ? 'not_applicable'
    : effectSelection.latest
      ? (effectSelection.latest.unavailable ? 'degraded' : 'available')
      : sourceStates.effects === 'unavailable'
        ? 'unavailable'
        : ['pending'].includes(child.state)
          ? 'not_applicable'
          : 'degraded';

  return {
    key: `${iteration}:${stage}`,
    child_id: child?.child_id || null,
    iteration,
    stage,
    owner_agent: ownerAgent,
    state: child?.state || 'not_created',
    attempt: Number.isInteger(child?.attempt) ? child.attempt : 0,
    retry_count: Number.isInteger(child?.attempt) ? Math.max(0, child.attempt - 1) : 0,
    depends_on: bounded(child?.depends_on, 200),
    input_sha: bounded(child?.input_sha, 40)?.toLowerCase() || null,
    output_sha: bounded(child?.output_sha, 40)?.toLowerCase() || null,
    created_at: bounded(child?.created_at, 64),
    started_at: bounded(child?.started_at, 64),
    completed_at: bounded(child?.completed_at, 64),
    duration_seconds: durationSeconds(child?.started_at, child?.completed_at),
    last_error: bounded(child?.last_error, 120),
    review_decision: bounded(child?.review_decision, 40),
    review_reason: bounded(child?.review_reason, 120),
    workspace,
    provider_effect: effectSelection.latest,
    provider_effect_count: effectSelection.count,
    verification,
    retry_history: publicHistory(child),
    evidence: {
      workspace: workspaceEvidence,
      provider_effect: effectEvidence,
    },
  };
}

export function buildMissionRoom({
  mission,
  workflow = null,
  effects = [],
  workspaces = [],
  sources = {},
  generatedAt = new Date().toISOString(),
}: any) {
  const publicMission = serializeMission(mission, { includeHistory: false });
  const children = Array.isArray(workflow?.children) ? workflow.children : [];
  const byKey = new Map(children.map((child: any) => [`${child.iteration}:${child.stage}`, child]));
  const maximumObservedIteration = Math.max(
    1,
    Number(workflow?.current_iteration || 1),
    ...children.map((child: any) => Number(child.iteration || 1)),
  );
  const sourceStates = {
    mission: sourceState(sources.mission || 'available'),
    workflow: sourceState(sources.workflow || (publicMission.workflow_id ? 'unavailable' : 'not_applicable')),
    workspaces: sourceState(sources.workspaces || (publicMission.workflow_id ? 'unavailable' : 'not_applicable')),
    effects: sourceState(sources.effects || (publicMission.workflow_id ? 'unavailable' : 'not_applicable')),
  };
  const timeline = [];
  for (let iteration = 1; iteration <= maximumObservedIteration; iteration += 1) {
    for (const stage of FEATURE_DEVELOPMENT_STAGES) {
      timeline.push(timelineStage({
        iteration,
        stage,
        child: byKey.get(`${iteration}:${stage}`) || null,
        workspaces,
        effects,
        sourceStates,
      }));
    }
  }
  const attentionStages = timeline.filter((entry) => entry.verification.status === 'attention');
  const degradedStages = timeline.filter((entry) => (
    entry.verification.status === 'degraded'
    || entry.evidence.workspace === 'degraded'
    || entry.evidence.workspace === 'unavailable'
    || entry.evidence.provider_effect === 'degraded'
    || entry.evidence.provider_effect === 'unavailable'
  ));

  return {
    mission: publicMission,
    workflow: workflow
      ? {
          workflow_id: bounded(workflow.workflow_id, 200),
          workflow_type: bounded(workflow.workflow_type, 80),
          repository_id: bounded(workflow.repository_id, 220),
          source_sha: bounded(workflow.source_sha, 40)?.toLowerCase() || null,
          state: bounded(workflow.state, 40),
          current_iteration: Number(workflow.current_iteration || 1),
          policy: workflow.policy || null,
          created_at: bounded(workflow.created_at, 64),
          updated_at: bounded(workflow.updated_at, 64),
          completed_at: bounded(workflow.completed_at, 64),
          last_error: bounded(workflow.last_error, 120),
        }
      : null,
    timeline,
    summary: {
      iterations: maximumObservedIteration,
      created_stages: children.length,
      completed_stages: children.filter((child: any) => child.state === 'completed').length,
      attention_stages: attentionStages.length,
      degraded_stages: degradedStages.length,
      current_stage_key: timeline.find((entry) => ['active', 'pending', 'needs_human', 'failed'].includes(entry.state))?.key || null,
      attention_required: publicMission.state === 'needs_human'
        || workflow?.state === 'needs_human'
        || attentionStages.length > 0,
    },
    sources: sourceStates,
    generated_at: generatedAt,
  };
}
