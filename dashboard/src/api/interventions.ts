import { agentFleetApi, type AgentFleetItem } from './agent-fleet';
import {
  missionsApi,
  type MissionActivityEvent,
  type MissionDetailResponse,
  type MissionRecord,
} from './missions';

export type InterventionSeverity = 'warning' | 'attention' | 'error';
export type InterventionCategory = 'task' | 'mission' | 'workflow' | 'stage' | 'review' | 'workspace' | 'effect' | 'agent' | 'evidence';
export type RetryAssessment = 'safe' | 'blocked' | 'unsafe' | 'unknown' | 'not_applicable';
export type ExternalEffectAssessment = 'not_applicable' | 'none_recorded' | 'possible' | 'completed' | 'failed' | 'unknown';
export type InterventionSourceState = 'available' | 'degraded' | 'unavailable' | 'not_applicable';

export interface InterventionEvidence {
  source: string;
  summary: string;
  identifier: string | null;
  at: string | null;
}

export interface InterventionItem {
  intervention_id: string;
  category: InterventionCategory;
  severity: InterventionSeverity;
  problem_code: string;
  title: string;
  what_happened: string;
  occurred_at: string | null;
  mission_id: string | null;
  mission_title: string | null;
  workflow_id: string | null;
  stage_key: string | null;
  agent_id: string | null;
  task_id: string | null;
  workspace_id: string | null;
  repository_id: string | null;
  external_effect: {
    assessment: ExternalEffectAssessment;
    may_have_occurred: boolean | null;
    explanation: string;
  };
  retry: {
    assessment: RetryAssessment;
    reason: string;
  };
  blocked_reason: string | null;
  recommended_response: string;
  evidence: InterventionEvidence[];
  links: {
    mission: string | null;
    stage: string | null;
    agent: string | null;
    tasks: string | null;
    workflow: string | null;
  };
}

export interface InterventionInboxResponse {
  interventions: InterventionItem[];
  summary: {
    total: number;
    errors: number;
    blocked: number;
    unknown_retry: number;
    possible_external_effect: number;
    by_category: Record<string, number>;
  };
  sources: {
    missions: InterventionSourceState;
    mission_rooms: InterventionSourceState;
    review_tasks: InterventionSourceState;
    review_effects: InterventionSourceState;
    agents: InterventionSourceState;
  };
  generated_at: string;
}

interface ReviewTask {
  id?: string;
  task_id?: string;
  state?: string;
  kind?: string;
  repository?: string;
  pr?: number;
  reviewed_sha?: string;
  agent?: string;
  mode?: string;
  task_type?: string;
  task_text?: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  error?: string;
  history?: Array<{ from?: string | null; to?: string | null; at?: string; reason?: string }>;
}

interface ReviewEffect {
  id?: string;
  task_id?: string;
  kind?: string;
  state?: string;
  created_at?: string;
  completed_at?: string;
}

function bounded(value: unknown, maximum = 300): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function timestamp(value: unknown): number {
  const parsed = value ? new Date(String(value)).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableId(...parts: unknown[]) {
  const input = parts.map((part) => String(part ?? '')).join('|');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `intervention:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function safePath(value: string | null) {
  return value && value.startsWith('/') ? value : null;
}

function lastReason(task: ReviewTask) {
  return bounded(task.history?.slice().reverse().find((entry) => entry.reason)?.reason, 160)
    || bounded(task.error, 160)
    || `task_${String(task.state || 'unknown').toLowerCase()}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function eventCategory(event: MissionActivityEvent): InterventionCategory {
  if (event.category === 'review') return 'review';
  if (event.category === 'workspace') return 'workspace';
  if (event.category === 'effect') return 'effect';
  if (event.category === 'stage') return 'stage';
  if (event.category === 'workflow') return 'workflow';
  if (event.category === 'mission') return 'mission';
  return 'evidence';
}

function isInterventionEvent(event: MissionActivityEvent) {
  return event.category === 'intervention'
    || event.severity === 'attention'
    || event.severity === 'error'
    || (event.category === 'review' && event.state === 'changes_requested');
}

function missionEventAssessment(event: MissionActivityEvent, mission: MissionRecord): InterventionItem {
  const reason = bounded(event.reason_code, 160) || event.event_type;
  const isReviewChanges = event.category === 'review' && event.state === 'changes_requested';
  const interrupted = String(reason).includes('interrupted');
  const effectFailed = event.source === 'provider_effect' && ['failed', 'needs_human'].includes(String(event.state));
  const investigation = event.source === 'workspace' && (String(event.state) === 'held_for_investigation' || String(reason).includes('investigation'));

  let retry: InterventionItem['retry'] = {
    assessment: 'unknown',
    reason: 'Durable evidence does not prove that repeating the stage is safe.',
  };
  let externalEffect: InterventionItem['external_effect'] = {
    assessment: 'unknown',
    may_have_occurred: null,
    explanation: 'The available evidence does not establish whether an external effect occurred.',
  };
  let recommended = 'Inspect the linked Mission and stage evidence before choosing an operator action.';
  let blockedReason: string | null = 'Retry remains blocked until the evidence is reviewed.';

  if (isReviewChanges) {
    retry = { assessment: 'not_applicable', reason: 'Berlin produced a review decision rather than a recoverable execution failure.' };
    externalEffect = { assessment: 'not_applicable', may_have_occurred: false, explanation: 'This item is a durable review decision.' };
    recommended = 'Review Berlin’s bounded reason and decide whether to approve another implementation iteration.';
    blockedReason = null;
  } else if (interrupted) {
    retry = { assessment: 'blocked', reason: 'An interrupted claimed provider effect may have executed before restart.' };
    externalEffect = { assessment: 'possible', may_have_occurred: true, explanation: 'The durable effect record was interrupted and cannot prove non-execution.' };
    recommended = 'Investigate the provider effect and workspace before resolving or retrying it.';
    blockedReason = 'Uncertain external effects must not be replayed automatically.';
  } else if (effectFailed) {
    retry = { assessment: 'blocked', reason: 'The provider-effect record requires explicit investigation before retry.' };
    externalEffect = {
      assessment: String(event.state) === 'failed' ? 'failed' : 'possible',
      may_have_occurred: true,
      explanation: 'A durable provider-effect record exists and is not a verified successful completion.',
    };
    recommended = 'Inspect the effect result, output SHA, and workspace HEAD before deciding on recovery.';
    blockedReason = 'A provider effect exists without a verified safe replay boundary.';
  } else if (investigation) {
    retry = { assessment: 'blocked', reason: 'The workspace is held for investigation.' };
    externalEffect = { assessment: 'unknown', may_have_occurred: null, explanation: 'Workspace evidence alone cannot establish external-effect state.' };
    recommended = 'Inspect bounded workspace and SHA evidence, then release or retain the investigation hold.';
    blockedReason = 'Investigation hold prevents unattended continuation.';
  }

  return {
    intervention_id: stableId('mission', mission.mission_id, event.event_type, event.source_id, event.at),
    category: eventCategory(event),
    severity: event.severity === 'error' ? 'error' : event.severity === 'attention' ? 'attention' : 'warning',
    problem_code: reason,
    title: event.title,
    what_happened: event.detail || event.title,
    occurred_at: event.at,
    mission_id: mission.mission_id,
    mission_title: mission.title,
    workflow_id: event.workflow_id,
    stage_key: event.stage_key,
    agent_id: event.owner_agent,
    task_id: null,
    workspace_id: event.source === 'workspace' ? event.source_id : null,
    repository_id: mission.repository_id,
    external_effect: externalEffect,
    retry,
    blocked_reason: blockedReason,
    recommended_response: recommended,
    evidence: [
      { source: event.source, summary: event.detail || event.title, identifier: event.source_id, at: event.at },
      ...(event.input_sha ? [{ source: 'workflow_child', summary: `Input SHA ${event.input_sha}`, identifier: event.child_id, at: event.at }] : []),
      ...(event.output_sha ? [{ source: 'workflow_child', summary: `Output SHA ${event.output_sha}`, identifier: event.child_id, at: event.at }] : []),
    ],
    links: {
      mission: safePath(event.links.mission) || `/missions/${encodeURIComponent(mission.mission_id)}`,
      stage: safePath(event.links.stage),
      agent: safePath(event.links.agent),
      tasks: null,
      workflow: safePath(event.links.workflow),
    },
  };
}

function taskAssessment(task: ReviewTask, effects: ReviewEffect[]): InterventionItem {
  const taskId = bounded(task.id || task.task_id, 200) || 'task-unavailable';
  const state = String(task.state || 'UNKNOWN').toUpperCase();
  const reason = lastReason(task);
  const claimed = effects.filter((effect) => String(effect.state).toUpperCase() === 'CLAIMED');
  const completed = effects.filter((effect) => String(effect.state).toUpperCase() === 'COMPLETED');
  const isChanges = state === 'CHANGES_REQUESTED';
  const hasAmbiguousEffect = claimed.length > 0;

  const externalEffect: InterventionItem['external_effect'] = hasAmbiguousEffect
    ? { assessment: 'possible', may_have_occurred: true, explanation: 'At least one durable effect remains CLAIMED and unresolved.' }
    : completed.length > 0
      ? { assessment: 'completed', may_have_occurred: true, explanation: 'A completed durable external-effect record exists.' }
      : { assessment: 'none_recorded', may_have_occurred: false, explanation: 'No durable external-effect record was found for this task.' };

  let retry: InterventionItem['retry'];
  let recommended: string;
  let blockedReason: string | null;
  if (isChanges) {
    retry = { assessment: 'not_applicable', reason: 'Changes requested is a review outcome, not a failed execution retry.' };
    recommended = 'Review the findings and decide whether to authorize a fix or another implementation iteration.';
    blockedReason = null;
  } else if (hasAmbiguousEffect) {
    retry = { assessment: 'blocked', reason: 'A CLAIMED effect may already have executed.' };
    recommended = 'Resolve the ambiguous effect before retrying or resuming the task.';
    blockedReason = 'Uncertain external effect requires human resolution.';
  } else if (state === 'CANCEL_REQUESTED') {
    retry = { assessment: 'blocked', reason: 'Cancellation has not yet been acknowledged by the worker.' };
    recommended = 'Wait for durable cancellation acknowledgement or investigate the worker lease.';
    blockedReason = 'Task is still within the cancellation handshake.';
  } else {
    retry = { assessment: 'unknown', reason: 'Task failure evidence does not prove the provider or Git effect boundary.' };
    recommended = 'Inspect task history and effect evidence before retrying from the browser.';
    blockedReason = 'Retry safety cannot be established from the current durable evidence.';
  }

  return {
    intervention_id: stableId('task', taskId, state, reason),
    category: isChanges ? 'review' : 'task',
    severity: state === 'ERROR' ? 'error' : 'attention',
    problem_code: reason,
    title: isChanges ? 'Review changes requested' : `Task requires human attention: ${state.toLowerCase().replaceAll('_', ' ')}`,
    what_happened: bounded(task.error, 300) || bounded(task.task_text, 300) || `Task entered ${state.toLowerCase().replaceAll('_', ' ')} state.`,
    occurred_at: bounded(task.updated_at || task.completed_at || task.created_at, 64),
    mission_id: null,
    mission_title: null,
    workflow_id: null,
    stage_key: null,
    agent_id: bounded(task.agent, 100),
    task_id: taskId,
    workspace_id: null,
    repository_id: bounded(task.repository, 220),
    external_effect: externalEffect,
    retry,
    blocked_reason: blockedReason,
    recommended_response: recommended,
    evidence: [
      { source: 'review_task', summary: `State ${state}`, identifier: taskId, at: bounded(task.updated_at, 64) },
      ...claimed.slice(0, 3).map((effect) => ({ source: 'review_effect', summary: `Unresolved ${effect.kind || 'effect'} claim`, identifier: bounded(effect.id, 200), at: bounded(effect.created_at, 64) })),
      ...completed.slice(0, 3).map((effect) => ({ source: 'review_effect', summary: `Completed ${effect.kind || 'effect'}`, identifier: bounded(effect.id, 200), at: bounded(effect.completed_at || effect.created_at, 64) })),
    ],
    links: {
      mission: null,
      stage: null,
      agent: task.agent ? `/agents/${encodeURIComponent(task.agent)}` : null,
      tasks: '/tasks',
      workflow: null,
    },
  };
}

function agentAssessment(agent: AgentFleetItem): InterventionItem {
  const reason = agent.attention.reason_code || `agent_${agent.state}`;
  return {
    intervention_id: stableId('agent', agent.id, reason),
    category: 'agent',
    severity: agent.runtime.health === 'unhealthy' || agent.runtime.convergence_status === 'mismatch' ? 'error' : 'attention',
    problem_code: reason,
    title: `${agent.display_name} requires operator attention`,
    what_happened: agent.attention.summary || `Agent entered ${agent.state.replaceAll('_', ' ')} state.`,
    occurred_at: agent.last_activity_at,
    mission_id: agent.current_mission?.mission_id || null,
    mission_title: agent.current_mission?.title || null,
    workflow_id: agent.current_mission?.workflow_id || null,
    stage_key: agent.current_mission?.stage && agent.current_mission.iteration
      ? `${agent.current_mission.iteration}:${agent.current_mission.stage}`
      : null,
    agent_id: agent.id,
    task_id: agent.current_task?.task_id || null,
    workspace_id: agent.current_task?.workspace?.workspace_id || null,
    repository_id: agent.current_mission?.repository_id || agent.current_task?.repository || null,
    external_effect: {
      assessment: 'not_applicable',
      may_have_occurred: null,
      explanation: 'Agent availability evidence does not establish an external provider or Git effect.',
    },
    retry: {
      assessment: 'not_applicable',
      reason: 'Agent runtime and lifecycle recovery is not a task retry decision.',
    },
    blocked_reason: 'Dispatch should not continue while the agent attention condition remains unresolved.',
    recommended_response: agent.runtime.convergence_status === 'mismatch'
      ? 'Inspect desired and observed lifecycle state before resuming dispatch.'
      : 'Open Agent Detail and inspect runtime, profile, current task, and Mission evidence.',
    evidence: [
      { source: 'agent_fleet', summary: agent.attention.summary || reason, identifier: agent.id, at: agent.last_activity_at },
      ...(agent.current_task ? [{ source: 'task', summary: `${agent.current_task.status}: ${agent.current_task.title}`, identifier: agent.current_task.task_id, at: agent.current_task.updated_at }] : []),
    ],
    links: {
      mission: agent.current_mission ? `/missions/${encodeURIComponent(agent.current_mission.mission_id)}` : null,
      stage: agent.current_mission?.stage && agent.current_mission.iteration
        ? `/missions/${encodeURIComponent(agent.current_mission.mission_id)}#stage-${agent.current_mission.iteration}-${agent.current_mission.stage}`
        : null,
      agent: `/agents/${encodeURIComponent(agent.id)}`,
      tasks: agent.current_task ? '/tasks' : null,
      workflow: agent.current_mission?.workflow_id ? '/workflows' : null,
    },
  };
}

function deduplicate(items: InterventionItem[]) {
  const byId = new Map<string, InterventionItem>();
  for (const item of items) {
    const existing = byId.get(item.intervention_id);
    if (!existing || item.evidence.length > existing.evidence.length) byId.set(item.intervention_id, item);
  }
  const severityRank = { error: 3, attention: 2, warning: 1 } as const;
  return [...byId.values()].sort((left, right) => (
    severityRank[right.severity] - severityRank[left.severity]
    || timestamp(right.occurred_at) - timestamp(left.occurred_at)
    || left.intervention_id.localeCompare(right.intervention_id)
  ));
}

export async function buildInterventionInbox(): Promise<InterventionInboxResponse> {
  const generatedAt = new Date().toISOString();
  const sources: InterventionInboxResponse['sources'] = {
    missions: 'available',
    mission_rooms: 'available',
    review_tasks: 'available',
    review_effects: 'available',
    agents: 'available',
  };
  const items: InterventionItem[] = [];

  let missions: MissionRecord[] = [];
  try {
    missions = (await missionsApi.listMissions()).missions.filter((mission) => !mission.unavailable);
  } catch {
    sources.missions = 'unavailable';
    sources.mission_rooms = 'unavailable';
  }

  if (missions.length > 0) {
    const details = await Promise.allSettled(missions.map((mission) => missionsApi.getMission(mission.mission_id)));
    let roomFailures = 0;
    details.forEach((result, index) => {
      if (result.status === 'rejected') {
        roomFailures += 1;
        return;
      }
      const detail: MissionDetailResponse = result.value;
      if (!detail.room) {
        roomFailures += 1;
        return;
      }
      for (const event of detail.room.activity.filter(isInterventionEvent)) {
        items.push(missionEventAssessment(event, detail.mission || missions[index]));
      }
    });
    if (roomFailures > 0) sources.mission_rooms = roomFailures === missions.length ? 'unavailable' : 'degraded';
  }

  let reviewTasks: ReviewTask[] = [];
  try {
    reviewTasks = (await getJson<{ tasks: ReviewTask[] }>('/api/review-tasks?limit=100')).tasks || [];
  } catch {
    sources.review_tasks = 'unavailable';
    sources.review_effects = 'unavailable';
  }

  const attentionTasks = reviewTasks.filter((task) => ['NEEDS_HUMAN', 'ERROR', 'CHANGES_REQUESTED', 'CANCEL_REQUESTED'].includes(String(task.state || '').toUpperCase()));
  if (attentionTasks.length > 0) {
    const effectResults = await Promise.allSettled(attentionTasks.map(async (task) => {
      const id = String(task.id || task.task_id || '');
      if (!id) return [] as ReviewEffect[];
      const [claimed, completed] = await Promise.all([
        getJson<{ effects: ReviewEffect[] }>(`/api/review-tasks/${encodeURIComponent(id)}/effects?state=CLAIMED`),
        getJson<{ effects: ReviewEffect[] }>(`/api/review-tasks/${encodeURIComponent(id)}/effects?state=COMPLETED`),
      ]);
      return [...(claimed.effects || []), ...(completed.effects || [])];
    }));
    effectResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        sources.review_effects = sources.review_effects === 'available' ? 'degraded' : sources.review_effects;
        items.push(taskAssessment(attentionTasks[index], []));
      } else {
        items.push(taskAssessment(attentionTasks[index], result.value));
      }
    });
  }

  try {
    const fleet = await agentFleetApi.list();
    for (const agent of fleet.fleet.filter((entry) => entry.attention.required || ['needs_human', 'unavailable'].includes(entry.state))) {
      items.push(agentAssessment(agent));
    }
    if (Object.values(fleet.sources).some((state) => state === 'unavailable')) sources.agents = 'degraded';
  } catch {
    sources.agents = 'unavailable';
  }

  const interventions = deduplicate(items);
  const byCategory: Record<string, number> = {};
  for (const item of interventions) byCategory[item.category] = (byCategory[item.category] || 0) + 1;

  return {
    interventions,
    summary: {
      total: interventions.length,
      errors: interventions.filter((item) => item.severity === 'error').length,
      blocked: interventions.filter((item) => item.retry.assessment === 'blocked').length,
      unknown_retry: interventions.filter((item) => item.retry.assessment === 'unknown').length,
      possible_external_effect: interventions.filter((item) => item.external_effect.assessment === 'possible').length,
      by_category: byCategory,
    },
    sources,
    generated_at: generatedAt,
  };
}

export const interventionsApi = {
  list: buildInterventionInbox,
};
