import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MISSION_SCHEMA = 'ops-room.mission.v1';
export const MISSION_VERSION = 1;
export const FEATURE_DEVELOPMENT_MISSION_WORKFLOW = 'feature-development';
export const BERLIN_REVIEW_APPROVAL_POLICY = 'berlin-review-required';

export const MISSION_STAGE_OWNERS = Object.freeze({
  implementation: 'professor',
  test: 'tokyo',
  integration: 'professor',
  review: 'berlin',
});

export const MISSION_PARTICIPANTS = Object.freeze([
  Object.freeze({ agent_id: 'professor', roles: Object.freeze(['implementation', 'integration']) }),
  Object.freeze({ agent_id: 'tokyo', roles: Object.freeze(['test']) }),
  Object.freeze({ agent_id: 'berlin', roles: Object.freeze(['review']) }),
]);

const MISSION_STATES = new Set(['planned', 'active', 'paused', 'completed', 'needs_human', 'cancelled']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const SAFE_REPOSITORY_ID = /^(?:[A-Za-z0-9._-]{1,120}|[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})$/;
const SAFE_BRANCH = /^(?!\/|.*(?:\.\.|\/\.|\.\/|\/\/|@\{|\\))[A-Za-z0-9._\/-]{1,240}(?<![./])$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const SAFE_CAPABILITY = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const SAFE_HASH = /^[0-9a-f]{64}$/;

export type MissionPriority = 'low' | 'normal' | 'high' | 'urgent';
export type MissionState = 'planned' | 'active' | 'paused' | 'completed' | 'needs_human' | 'cancelled';

export interface NormalizedMissionInput {
  title: string;
  objective: string;
  repository_id: string;
  starting_branch: string;
  starting_sha: string;
  workflow_type: typeof FEATURE_DEVELOPMENT_MISSION_WORKFLOW;
  policy: {
    max_iterations: number;
    approval_policy: typeof BERLIN_REVIEW_APPROVAL_POLICY;
  };
  github_issue: number | null;
  reference_documents: string[];
  required_capabilities: string[];
  priority: MissionPriority;
  deadline: string | null;
  supporting_context: string | null;
}

export interface MissionActor {
  actor_id: string;
  actor_display_name: string | null;
}

export interface MissionRecord extends NormalizedMissionInput {
  schema: typeof MISSION_SCHEMA;
  version: typeof MISSION_VERSION;
  mission_id: string;
  state: MissionState;
  participants: Array<{ agent_id: string; roles: string[] }>;
  stage_owners: Record<string, string>;
  workflow_id: string | null;
  created_by: MissionActor;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
  history: Array<Record<string, unknown>>;
  creation_request_hash: string;
}

function nowIso() {
  return new Date().toISOString();
}

function boundedText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  { allowNewlines = false, optional = false }: { allowNewlines?: boolean; optional?: boolean } = {},
): string | null {
  if (value == null && optional) return null;
  const normalized = String(value ?? '').trim();
  if (optional && !normalized) return null;
  if (normalized.length < minimum || normalized.length > maximum || normalized.includes('\u0000')) {
    throw new Error(`invalid_${field}`);
  }
  if (!allowNewlines && /[\r\n]/.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function validateRepositoryId(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!SAFE_REPOSITORY_ID.test(normalized)) throw new Error('invalid_mission_repository_id');
  for (const part of normalized.split('/')) {
    if (part === '..' || part.startsWith('.') || part.endsWith('.')) {
      throw new Error('invalid_mission_repository_id');
    }
  }
  return normalized;
}

function validateBranch(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!SAFE_BRANCH.test(normalized)) throw new Error('invalid_mission_starting_branch');
  return normalized;
}

function validateSha(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SAFE_SHA.test(normalized)) throw new Error('invalid_mission_starting_sha');
  return normalized;
}

function normalizeMaxIterations(value: unknown): number {
  const normalized = Number(value ?? 3);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 20) {
    throw new Error('invalid_mission_max_iterations');
  }
  return normalized;
}

function normalizeApprovalPolicy(value: unknown): typeof BERLIN_REVIEW_APPROVAL_POLICY {
  const normalized = String(value || BERLIN_REVIEW_APPROVAL_POLICY).trim();
  if (normalized !== BERLIN_REVIEW_APPROVAL_POLICY) {
    throw new Error('unsupported_mission_approval_policy');
  }
  return BERLIN_REVIEW_APPROVAL_POLICY;
}

function normalizePriority(value: unknown): MissionPriority {
  const normalized = String(value || 'normal').trim().toLowerCase();
  if (!PRIORITIES.has(normalized)) throw new Error('invalid_mission_priority');
  return normalized as MissionPriority;
}

function normalizeDeadline(value: unknown): string | null {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).trim();
  if (normalized.length > 64) throw new Error('invalid_mission_deadline');
  const deadline = new Date(normalized);
  if (Number.isNaN(deadline.getTime())) throw new Error('invalid_mission_deadline');
  return deadline.toISOString();
}

function normalizeGitHubIssue(value: unknown): number | null {
  if (value == null || value === '') return null;
  const issue = Number(value);
  if (!Number.isInteger(issue) || issue < 1 || issue > 999_999_999) {
    throw new Error('invalid_mission_github_issue');
  }
  return issue;
}

function normalizeReferenceDocuments(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('invalid_mission_reference_documents');
  const references: string[] = [];
  for (const candidate of value) {
    const reference = boundedText(candidate, 'mission_reference_document', 1, 500) as string;
    if (/^file:/i.test(reference) || reference.startsWith('/') || /^[A-Za-z]:[\\/]/.test(reference)) {
      throw new Error('invalid_mission_reference_document');
    }
    if (!references.includes(reference)) references.push(reference);
  }
  return references;
}

function normalizeCapabilities(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) throw new Error('invalid_mission_required_capabilities');
  const capabilities: string[] = [];
  for (const candidate of value) {
    const capability = String(candidate || '').trim().toLowerCase();
    if (!SAFE_CAPABILITY.test(capability)) throw new Error('invalid_mission_required_capability');
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return capabilities.sort();
}

function normalizeActor(actor: any): MissionActor {
  return {
    actor_id: boundedText(actor?.actor_id, 'mission_actor_id', 1, 180) as string,
    actor_display_name: boundedText(
      actor?.actor_display_name,
      'mission_actor_display_name',
      1,
      200,
      { optional: true },
    ),
  };
}

function safeSlug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48);
  return normalized || 'mission';
}

function missionFilename(missionId: string): string {
  if (!SAFE_ID.test(missionId)) throw new Error('invalid_mission_id');
  return `mission-${createHash('sha256').update(missionId).digest('hex')}.json`;
}

function missionPath(dir: string, missionId: string): string {
  return join(dir, missionFilename(missionId));
}

function requestHash(requestKey: unknown): string {
  const key = String(requestKey || '').trim();
  if (!key || key.length > 300) throw new Error('invalid_mission_request_key');
  return createHash('sha256').update(`ops-room.mission-request.v1:${key}`).digest('hex');
}

function recordComparable(record: MissionRecord) {
  return {
    title: record.title,
    objective: record.objective,
    repository_id: record.repository_id,
    starting_branch: record.starting_branch,
    starting_sha: record.starting_sha,
    workflow_type: record.workflow_type,
    policy: record.policy,
    github_issue: record.github_issue,
    reference_documents: record.reference_documents,
    required_capabilities: record.required_capabilities,
    priority: record.priority,
    deadline: record.deadline,
    supporting_context: record.supporting_context,
    created_by: record.created_by,
    creation_request_hash: record.creation_request_hash,
  };
}

export function normalizeMissionInput(input: any): NormalizedMissionInput {
  const workflowType = String(input?.workflow_type || input?.workflowType || FEATURE_DEVELOPMENT_MISSION_WORKFLOW).trim();
  if (workflowType !== FEATURE_DEVELOPMENT_MISSION_WORKFLOW) throw new Error('unsupported_mission_workflow_type');

  return {
    title: boundedText(input?.title, 'mission_title', 1, 160) as string,
    objective: boundedText(input?.objective, 'mission_objective', 1, 5_000, { allowNewlines: true }) as string,
    repository_id: validateRepositoryId(input?.repository_id || input?.repository),
    starting_branch: validateBranch(input?.starting_branch || input?.startingBranch),
    starting_sha: validateSha(input?.starting_sha || input?.startingSha),
    workflow_type: FEATURE_DEVELOPMENT_MISSION_WORKFLOW,
    policy: {
      max_iterations: normalizeMaxIterations(input?.max_iterations ?? input?.policy?.max_iterations),
      approval_policy: normalizeApprovalPolicy(input?.approval_policy ?? input?.policy?.approval_policy),
    },
    github_issue: normalizeGitHubIssue(input?.github_issue ?? input?.githubIssue),
    reference_documents: normalizeReferenceDocuments(input?.reference_documents ?? input?.referenceDocuments),
    required_capabilities: normalizeCapabilities(input?.required_capabilities ?? input?.requiredCapabilities),
    priority: normalizePriority(input?.priority),
    deadline: normalizeDeadline(input?.deadline),
    supporting_context: boundedText(
      input?.supporting_context ?? input?.supportingContext,
      'mission_supporting_context',
      1,
      5_000,
      { allowNewlines: true, optional: true },
    ),
  };
}

export function buildMissionId({
  repository,
  title,
  requestKey,
}: {
  repository: unknown;
  title: unknown;
  requestKey: unknown;
}): string {
  const repositoryId = validateRepositoryId(repository);
  const normalizedTitle = boundedText(title, 'mission_title', 1, 160) as string;
  const digest = createHash('sha256')
    .update(`${repositoryId}\n${normalizedTitle}\n${String(requestKey || '').trim()}`)
    .digest('hex')
    .slice(0, 24);
  requestHash(requestKey);
  return `mission:${safeSlug(normalizedTitle)}:${digest}`;
}

export function validateMissionRecord(record: any): MissionRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid_mission_record');
  if (record.schema !== MISSION_SCHEMA || record.version !== MISSION_VERSION) throw new Error('unsupported_mission_record');
  if (!SAFE_ID.test(String(record.mission_id || ''))) throw new Error('invalid_mission_id');

  const normalized = normalizeMissionInput(record);
  if (!MISSION_STATES.has(String(record.state || ''))) throw new Error('invalid_mission_state');
  if (!Array.isArray(record.participants) || JSON.stringify(record.participants) !== JSON.stringify(MISSION_PARTICIPANTS)) {
    throw new Error('invalid_mission_participants');
  }
  if (JSON.stringify(record.stage_owners) !== JSON.stringify(MISSION_STAGE_OWNERS)) {
    throw new Error('invalid_mission_stage_owners');
  }
  if (record.workflow_id !== null && !SAFE_ID.test(String(record.workflow_id || ''))) {
    throw new Error('invalid_mission_workflow_id');
  }
  const createdBy = normalizeActor(record.created_by);
  const createdAt = normalizeDeadline(record.created_at);
  const updatedAt = normalizeDeadline(record.updated_at);
  if (!createdAt || !updatedAt) throw new Error('invalid_mission_timestamp');
  const completedAt = normalizeDeadline(record.completed_at);
  if (record.state === 'completed' && !completedAt) throw new Error('mission_completion_evidence_required');
  if (record.state !== 'completed' && completedAt) throw new Error('mission_completion_evidence_unexpected');
  if (!Array.isArray(record.history)) throw new Error('invalid_mission_history');
  if (!SAFE_HASH.test(String(record.creation_request_hash || ''))) throw new Error('invalid_mission_request_hash');
  const lastError = boundedText(record.last_error, 'mission_last_error', 1, 500, { optional: true });

  return {
    ...normalized,
    schema: MISSION_SCHEMA,
    version: MISSION_VERSION,
    mission_id: String(record.mission_id),
    state: String(record.state) as MissionState,
    participants: MISSION_PARTICIPANTS.map((participant) => ({
      agent_id: participant.agent_id,
      roles: [...participant.roles],
    })),
    stage_owners: { ...MISSION_STAGE_OWNERS },
    workflow_id: record.workflow_id === null ? null : String(record.workflow_id),
    created_by: createdBy,
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: completedAt,
    last_error: lastError,
    history: record.history.map((event: any) => ({ ...event })),
    creation_request_hash: String(record.creation_request_hash),
  };
}

export function serializeMission(record: any, { includeHistory = true } = {}) {
  const mission = validateMissionRecord(record);
  return {
    schema: mission.schema,
    version: mission.version,
    mission_id: mission.mission_id,
    title: mission.title,
    objective: mission.objective,
    repository_id: mission.repository_id,
    starting_branch: mission.starting_branch,
    starting_sha: mission.starting_sha,
    workflow_type: mission.workflow_type,
    policy: mission.policy,
    state: mission.state,
    participants: mission.participants,
    stage_owners: mission.stage_owners,
    workflow_id: mission.workflow_id,
    github_issue: mission.github_issue,
    reference_documents: mission.reference_documents,
    required_capabilities: mission.required_capabilities,
    priority: mission.priority,
    deadline: mission.deadline,
    supporting_context: mission.supporting_context,
    created_by: mission.created_by,
    created_at: mission.created_at,
    updated_at: mission.updated_at,
    completed_at: mission.completed_at,
    last_error: mission.last_error,
    ...(includeHistory ? { history: mission.history } : {}),
  };
}

export async function readMission({ dir, missionId }: { dir: string; missionId: string }) {
  const raw = await readFile(missionPath(dir, missionId), 'utf8');
  return validateMissionRecord(JSON.parse(raw));
}

export async function listMissions({ dir, limit = 100 }: { dir: string; limit?: number }) {
  await mkdir(dir, { recursive: true });
  const names = (await readdir(dir))
    .filter((name) => name.startsWith('mission-') && name.endsWith('.json'))
    .sort();
  const records: any[] = [];
  for (const name of names) {
    try {
      records.push(validateMissionRecord(JSON.parse(await readFile(join(dir, name), 'utf8'))));
    } catch {
      records.push({
        unavailable: true,
        mission_id: `mission-unavailable:${createHash('sha256').update(name).digest('hex').slice(0, 16)}`,
        state: 'needs_human',
        title: 'Mission record unavailable',
        repository_id: null,
        priority: null,
        created_at: null,
        updated_at: null,
        last_error: 'mission_record_unavailable',
      });
    }
  }
  return records
    .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
}

export async function createMission({
  dir,
  input,
  actor,
  requestKey,
  now = nowIso,
}: {
  dir: string;
  input: any;
  actor: any;
  requestKey: string;
  now?: () => string;
}) {
  await mkdir(dir, { recursive: true });
  const normalized = normalizeMissionInput(input);
  const normalizedActor = normalizeActor(actor);
  const missionId = buildMissionId({
    repository: normalized.repository_id,
    title: normalized.title,
    requestKey,
  });
  const target = missionPath(dir, missionId);
  const at = now();
  const record = validateMissionRecord({
    schema: MISSION_SCHEMA,
    version: MISSION_VERSION,
    mission_id: missionId,
    ...normalized,
    state: 'planned',
    participants: MISSION_PARTICIPANTS,
    stage_owners: MISSION_STAGE_OWNERS,
    workflow_id: null,
    created_by: normalizedActor,
    created_at: at,
    updated_at: at,
    completed_at: null,
    last_error: null,
    history: [{ event: 'mission_created', actor_id: normalizedActor.actor_id, at }],
    creation_request_hash: requestHash(requestKey),
  });

  try {
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return { created: true, mission: record };
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readMission({ dir, missionId });
    if (JSON.stringify(recordComparable(existing)) !== JSON.stringify(recordComparable(record))) {
      throw new Error('mission_record_conflict');
    }
    return { created: false, mission: existing };
  }
}
