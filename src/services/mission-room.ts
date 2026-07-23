import { createHash } from 'node:crypto';

import {
  FEATURE_DEVELOPMENT_OWNERS,
  FEATURE_DEVELOPMENT_STAGES,
} from './workflow-run-store.js';
import { serializeMission } from './mission-store.js';

const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SOURCE_STATES = new Set(['available', 'degraded', 'unavailable', 'not_applicable']);
const ACTIVITY_SEVERITY = new Set(['info', 'success', 'warning', 'attention', 'error']);
const ACTIVITY_CATEGORY = new Set(['mission', 'workflow', 'stage', 'workspace', 'effect', 'review', 'intervention']);

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
        event: bounded(entry?.event, 100) || bounded(entry?.reason, 100) || 'workflow_event',
        reason: bounded(entry?.reason, 120),
        from: bounded(entry?.from, 40),
        to: bounded(entry?.to, 40),
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

function stageKeyForChild(child: any) {
  if (!child || !Number.isInteger(child.iteration) || !FEATURE_DEVELOPMENT_STAGES.includes(child.stage)) return null;
  return `${child.iteration}:${child.stage}`;
}

function childIndex(workflow: any) {
  return new Map((Array.isArray(workflow?.children) ? workflow.children : []).map((child: any) => [child.child_id, child]));
}

function activityEvent(input: any) {
  const at = bounded(input.at, 64);
  const category = ACTIVITY_CATEGORY.has(input.category) ? input.category : 'workflow';
  const severity = ACTIVITY_SEVERITY.has(input.severity) ? input.severity : 'info';
  const stageKey = bounded(input.stage_key, 80);
  const ownerAgent = bounded(input.owner_agent, 120);
  const eventType = bounded(input.event_type, 100) || 'activity.recorded';
  const correlation = [
    eventType,
    stageKey || bounded(input.workflow_id, 200) || bounded(input.mission_id, 200) || bounded(input.source_id, 200) || 'mission',
    at || 'unknown-time',
  ].join('|');
  return {
    event_id: `activity:${createHash('sha256').update(correlation).digest('hex').slice(0, 24)}`,
    event_type: eventType,
    category,
    severity,
    source: bounded(input.source, 40) || 'workflow',
    source_id: bounded(input.source_id, 200),
    title: bounded(input.title, 120) || 'Mission activity recorded',
    detail: bounded(input.detail, 300),
    reason_code: bounded(input.reason_code, 120),
    at,
    mission_id: bounded(input.mission_id, 200),
    workflow_id: bounded(input.workflow_id, 200),
    child_id: bounded(input.child_id, 200),
    stage_key: stageKey,
    iteration: Number.isInteger(input.iteration) ? input.iteration : null,
    stage: bounded(input.stage, 40),
    owner_agent: ownerAgent,
    input_sha: SAFE_SHA.test(String(input.input_sha || '')) ? String(input.input_sha).toLowerCase() : null,
    output_sha: SAFE_SHA.test(String(input.output_sha || '')) ? String(input.output_sha).toLowerCase() : null,
    state: bounded(input.state, 40),
    attempt: Number.isInteger(input.attempt) ? input.attempt : null,
    links: {
      mission: input.mission_id ? `/missions/${encodeURIComponent(String(input.mission_id))}` : null,
      stage: input.mission_id && stageKey
        ? `/missions/${encodeURIComponent(String(input.mission_id))}#stage-${stageKey.replace(':', '-')}`
        : null,
      agent: ownerAgent ? `/agents/${encodeURIComponent(ownerAgent)}` : null,
      workflow: input.mission_id && input.workflow_id
        ? `/missions/${encodeURIComponent(String(input.mission_id))}#workflow-summary`
        : null,
    },
  };
}

function stageTransitionMetadata(to: string | null, reason: string | null) {
  if (to === 'completed') return { event_type: 'stage.completed', title: 'Stage completed', severity: 'success', category: 'stage' };
  if (to === 'active') return { event_type: 'stage.activated', title: 'Stage activated', severity: 'info', category: 'stage' };
  if (to === 'pending' && reason === 'child_retry_requested') return { event_type: 'stage.retried', title: 'Stage retry requested', severity: 'warning', category: 'stage' };
  if (to === 'pending') return { event_type: 'stage.created', title: 'Stage created', severity: 'info', category: 'stage' };
  if (to === 'failed') return { event_type: 'stage.failed', title: 'Stage failed', severity: 'error', category: 'intervention' };
  if (to === 'needs_human') return { event_type: 'stage.needs_human', title: 'Stage needs human intervention', severity: 'attention', category: 'intervention' };
  if (to === 'cancelled') return { event_type: 'stage.cancelled', title: 'Stage cancelled', severity: 'warning', category: 'stage' };
  return { event_type: 'stage.updated', title: 'Stage updated', severity: 'info', category: 'stage' };
}

function workflowHistoryMetadata(eventName: string) {
  if (eventName === 'workflow_created') return { event_type: 'workflow.created', title: 'Workflow created', severity: 'info' };
  if (eventName.includes('completed')) return { event_type: eventName.includes('child') ? 'stage.completed' : 'workflow.completed', title: eventName.includes('child') ? 'Stage completed' : 'Workflow completed', severity: 'success' };
  if (eventName.includes('activated')) return { event_type: 'stage.activated', title: 'Stage activated', severity: 'info' };
  if (eventName.includes('created') && eventName.includes('child')) return { event_type: 'stage.created', title: 'Stage created', severity: 'info' };
  if (eventName.includes('retried')) return { event_type: 'stage.retried', title: 'Stage retry requested', severity: 'warning' };
  if (eventName.includes('failed')) return { event_type: 'stage.failed', title: 'Stage failed', severity: 'error' };
  if (eventName.includes('needs_human')) return { event_type: 'workflow.needs_human', title: 'Workflow needs human intervention', severity: 'attention' };
  return { event_type: `workflow.${eventName.replace(/^workflow_/, '').replaceAll('_', '.')}`, title: eventName.replaceAll('_', ' '), severity: 'info' };
}

function buildActivity({ mission, workflow, effects, workspaces }: any) {
  const events: any[] = [];
  const children = childIndex(workflow);
  const missionId = mission?.mission_id || null;
  const workflowId = workflow?.workflow_id || mission?.workflow_id || null;

  for (const entry of Array.isArray(mission?.history) ? mission.history.slice(-100) : []) {
    const eventName = bounded(entry?.event, 100) || 'mission_updated';
    const attention = eventName.includes('needs_human') || entry?.to === 'needs_human';
    const completed = eventName.includes('completed') || entry?.to === 'completed';
    events.push(activityEvent({
      event_type: `mission.${eventName.replace(/^mission_/, '').replaceAll('_', '.')}`,
      category: attention ? 'intervention' : 'mission',
      severity: attention ? 'attention' : completed ? 'success' : 'info',
      source: 'mission',
      source_id: missionId,
      title: eventName.replaceAll('_', ' '),
      detail: entry?.actor_id ? `Actor ${bounded(entry.actor_id, 120)}` : null,
      reason_code: entry?.reason,
      at: entry?.at,
      mission_id: missionId,
      workflow_id: workflowId,
      state: entry?.to || mission?.state,
    }));
  }

  for (const entry of Array.isArray(workflow?.history) ? workflow.history.slice(-200) : []) {
    const eventName = bounded(entry?.event, 100) || 'workflow_updated';
    const child = entry?.child_id ? children.get(entry.child_id) : null;
    const metadata = workflowHistoryMetadata(eventName);
    events.push(activityEvent({
      ...metadata,
      category: metadata.event_type.startsWith('stage.')
        ? (metadata.severity === 'error' || metadata.severity === 'attention' ? 'intervention' : 'stage')
        : 'workflow',
      source: 'workflow',
      source_id: workflowId,
      detail: bounded(entry?.reason || entry?.decision, 300),
      reason_code: entry?.reason,
      at: entry?.at,
      mission_id: missionId,
      workflow_id: workflowId,
      child_id: child?.child_id || entry?.child_id,
      stage_key: stageKeyForChild(child),
      iteration: child?.iteration,
      stage: child?.stage,
      owner_agent: child?.owner_agent,
      input_sha: child?.input_sha,
      output_sha: child?.output_sha,
      state: child?.state || workflow?.state,
      attempt: entry?.attempt ?? child?.attempt,
    }));
  }

  for (const child of Array.isArray(workflow?.children) ? workflow.children : []) {
    for (const entry of Array.isArray(child.history) ? child.history.slice(-100) : []) {
      const metadata = stageTransitionMetadata(bounded(entry?.to, 40), bounded(entry?.reason, 120));
      events.push(activityEvent({
        ...metadata,
        source: 'workflow_child',
        source_id: child.child_id,
        detail: entry?.from || entry?.to ? `${bounded(entry?.from, 40) || 'new'} → ${bounded(entry?.to, 40) || child.state}` : null,
        reason_code: entry?.reason,
        at: entry?.at,
        mission_id: missionId,
        workflow_id: workflowId,
        child_id: child.child_id,
        stage_key: stageKeyForChild(child),
        iteration: child.iteration,
        stage: child.stage,
        owner_agent: child.owner_agent,
        input_sha: child.input_sha,
        output_sha: child.output_sha,
        state: entry?.to || child.state,
        attempt: child.attempt,
      }));
    }

    if (child.review_decision) {
      const changes = child.review_decision === 'changes_requested';
      events.push(activityEvent({
        event_type: `review.${String(child.review_decision).replaceAll('_', '.')}`,
        category: changes ? 'intervention' : 'review',
        severity: changes ? 'attention' : child.review_decision === 'approved' ? 'success' : 'warning',
        source: 'workflow_child',
        source_id: child.child_id,
        title: changes ? 'Berlin requested changes' : `Berlin review ${String(child.review_decision).replaceAll('_', ' ')}`,
        detail: child.review_reason,
        reason_code: child.review_reason,
        at: child.completed_at || child.updated_at,
        mission_id: missionId,
        workflow_id: workflowId,
        child_id: child.child_id,
        stage_key: stageKeyForChild(child),
        iteration: child.iteration,
        stage: child.stage,
        owner_agent: child.owner_agent,
        input_sha: child.input_sha,
        output_sha: child.output_sha,
        state: child.state,
        attempt: child.attempt,
      }));
    }
  }

  for (const record of Array.isArray(workspaces) ? workspaces : []) {
    const child = children.get(record?.task_id);
    if (!child) continue;
    const workspace = publicWorkspace(record);
    if (!workspace || workspace.unavailable) continue;
    events.push(activityEvent({
      event_type: 'workspace.created',
      category: 'workspace',
      severity: 'info',
      source: 'workspace',
      source_id: workspace.workspace_id,
      title: 'Workspace allocated',
      detail: `${workspace.mode} workspace for ${child.owner_agent}`,
      at: workspace.created_at,
      mission_id: missionId,
      workflow_id: workflowId,
      child_id: child.child_id,
      stage_key: stageKeyForChild(child),
      iteration: child.iteration,
      stage: child.stage,
      owner_agent: child.owner_agent,
      input_sha: child.input_sha,
      output_sha: workspace.resolved_sha,
      state: 'allocated',
      attempt: child.attempt,
    }));
    events.push(activityEvent({
      event_type: workspace.held_for_investigation ? 'workspace.investigation_hold' : `workspace.${String(workspace.state).replaceAll('_', '.')}`,
      category: workspace.held_for_investigation ? 'intervention' : 'workspace',
      severity: workspace.held_for_investigation ? 'attention' : workspace.state === 'failed' ? 'error' : workspace.state === 'released' ? 'success' : 'info',
      source: 'workspace',
      source_id: workspace.workspace_id,
      title: workspace.held_for_investigation ? 'Workspace held for investigation' : `Workspace ${String(workspace.state).replaceAll('_', ' ')}`,
      at: workspace.updated_at,
      mission_id: missionId,
      workflow_id: workflowId,
      child_id: child.child_id,
      stage_key: stageKeyForChild(child),
      iteration: child.iteration,
      stage: child.stage,
      owner_agent: child.owner_agent,
      input_sha: child.input_sha,
      output_sha: workspace.resolved_sha,
      state: workspace.state,
      attempt: child.attempt,
    }));
  }

  for (const rawEffect of Array.isArray(effects) ? effects : []) {
    const effect = publicEffect(rawEffect);
    const child = children.get(rawEffect?.child_id);
    if (!effect || effect.unavailable || !child) continue;
    events.push(activityEvent({
      event_type: 'effect.claimed',
      category: 'effect',
      severity: 'info',
      source: 'provider_effect',
      source_id: effect.effect_id,
      title: 'Provider effect claimed',
      detail: effect.effect_type,
      at: effect.claimed_at,
      mission_id: missionId,
      workflow_id: workflowId,
      child_id: child.child_id,
      stage_key: stageKeyForChild(child),
      iteration: child.iteration,
      stage: child.stage,
      owner_agent: child.owner_agent,
      input_sha: child.input_sha,
      state: 'claimed',
      attempt: effect.attempt,
    }));
    if (effect.completed_at) {
      const attention = effect.state === 'failed' || effect.state === 'needs_human';
      events.push(activityEvent({
        event_type: `effect.${String(effect.state).replaceAll('_', '.')}`,
        category: attention ? 'intervention' : 'effect',
        severity: effect.state === 'completed' ? 'success' : effect.state === 'failed' ? 'error' : 'attention',
        source: 'provider_effect',
        source_id: effect.effect_id,
        title: effect.state === 'completed' ? 'Provider effect completed' : effect.state === 'failed' ? 'Provider effect failed' : 'Provider effect needs human intervention',
        detail: effect.effect_type,
        reason_code: effect.result_code,
        at: effect.completed_at,
        mission_id: missionId,
        workflow_id: workflowId,
        child_id: child.child_id,
        stage_key: stageKeyForChild(child),
        iteration: child.iteration,
        stage: child.stage,
        owner_agent: child.owner_agent,
        input_sha: child.input_sha,
        output_sha: effect.output_sha,
        state: effect.state,
        attempt: effect.attempt,
      }));
    }
  }

  if (workflow && ['blocked', 'needs_human'].includes(workflow.state)) {
    events.push(activityEvent({
      event_type: `workflow.${String(workflow.state).replaceAll('_', '.')}`,
      category: 'intervention',
      severity: workflow.state === 'needs_human' ? 'attention' : 'warning',
      source: 'workflow',
      source_id: workflowId,
      title: workflow.state === 'needs_human' ? 'Workflow needs human intervention' : 'Workflow is blocked',
      detail: workflow.last_error,
      reason_code: workflow.last_error,
      at: workflow.updated_at,
      mission_id: missionId,
      workflow_id: workflowId,
      state: workflow.state,
    }));
  }

  const deduplicated = new Map<string, any>();
  for (const event of events) {
    if (!event.at) continue;
    const key = [event.event_type, event.stage_key || event.source_id || event.workflow_id || event.mission_id, event.at].join('|');
    const existing = deduplicated.get(key);
    const score = Number(Boolean(event.detail)) + Number(Boolean(event.reason_code)) + Number(Boolean(event.output_sha)) + Number(event.source === 'workflow_child');
    const existingScore = existing
      ? Number(Boolean(existing.detail)) + Number(Boolean(existing.reason_code)) + Number(Boolean(existing.output_sha)) + Number(existing.source === 'workflow_child')
      : -1;
    if (!existing || score > existingScore) deduplicated.set(key, event);
  }

  const activity = [...deduplicated.values()]
    .sort((left, right) => timestamp(right.at) - timestamp(left.at) || String(left.event_id).localeCompare(String(right.event_id)))
    .slice(0, 200);
  return {
    activity,
    summary: {
      total: activity.length,
      attention: activity.filter((event) => ['attention', 'error'].includes(event.severity)).length,
      reviews: activity.filter((event) => event.category === 'review' || event.event_type.startsWith('review.')).length,
      retries: activity.filter((event) => event.event_type === 'stage.retried').length,
      effects: activity.filter((event) => event.source === 'provider_effect').length,
      latest_at: activity[0]?.at || null,
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
  const activityResult = buildActivity({ mission, workflow, effects, workspaces });

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
    activity: activityResult.activity,
    activity_summary: activityResult.summary,
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
