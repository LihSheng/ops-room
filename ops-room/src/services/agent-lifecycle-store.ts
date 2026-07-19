import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const LIFECYCLE_SCHEMA = 'ops-room.agent-lifecycle.v1';
const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9._:-]{1,100}$/;
const DESIRED_STATES = new Set(['unmanaged', 'stopped']);
const LIFECYCLE_PHASES = new Set(['unmanaged', 'draining', 'stopping', 'stopped', 'failed']);
const OPERATION_OUTCOMES = new Set(['in_progress', 'accepted', 'rejected', 'failed', 'interrupted']);
const INTERRUPTED_PHASES = new Set(['draining', 'stopping']);
const BLOCKED_DISPATCH_PHASES = new Set(['draining', 'stopping', 'stopped']);

function validateAgentId(agentId: string) {
  const value = String(agentId || '').trim();
  if (!SAFE_AGENT_ID.test(value)) throw new Error(`Invalid agent ID: ${agentId}`);
  return value;
}

function statePath(dir: string, agentId: string) {
  return join(dir, `agent-${validateAgentId(agentId)}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function boundedString(value: unknown, maximum: number) {
  if (value == null) return null;
  return String(value).slice(0, maximum);
}

export function unmanagedAgentLifecycleState(agentId: string) {
  return {
    schema: LIFECYCLE_SCHEMA,
    agent_id: validateAgentId(agentId),
    desired_state: 'unmanaged',
    phase: 'unmanaged',
    previous_desired_state: null,
    last_operation: null,
    last_error: null,
    updated_at: null,
  };
}

function unavailableAgentLifecycleState(agentId: string) {
  return {
    ...unmanagedAgentLifecycleState(agentId),
    desired_state: 'stopped',
    phase: 'failed',
    last_error: 'lifecycle_state_unavailable',
  };
}

function normalizeLastOperation(value: any) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid lifecycle operation');
  if (value.operation !== 'agent.stop') throw new Error('Invalid lifecycle operation');
  if (!OPERATION_OUTCOMES.has(value.outcome)) throw new Error('Invalid lifecycle operation outcome');
  return {
    operation: 'agent.stop',
    actor_id: boundedString(value.actor_id, 100),
    reason: boundedString(value.reason, 500),
    requested_at: boundedString(value.requested_at, 64),
    completed_at: boundedString(value.completed_at, 64),
    outcome: value.outcome,
  };
}

function normalizeLifecycleState(agentId: string, value: any) {
  const normalizedId = validateAgentId(agentId);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid lifecycle state');
  }
  if (value.schema !== LIFECYCLE_SCHEMA || value.agent_id !== normalizedId) {
    throw new Error('Invalid lifecycle state identity');
  }
  if (!DESIRED_STATES.has(value.desired_state) || !LIFECYCLE_PHASES.has(value.phase)) {
    throw new Error('Invalid lifecycle state value');
  }
  if (value.previous_desired_state != null && !DESIRED_STATES.has(value.previous_desired_state)) {
    throw new Error('Invalid previous desired state');
  }
  if (value.last_error != null && !SAFE_ERROR_CODE.test(String(value.last_error))) {
    throw new Error('Invalid lifecycle error code');
  }
  return {
    schema: LIFECYCLE_SCHEMA,
    agent_id: normalizedId,
    desired_state: value.desired_state,
    phase: value.phase,
    previous_desired_state: value.previous_desired_state || null,
    last_operation: normalizeLastOperation(value.last_operation),
    last_error: value.last_error == null ? null : String(value.last_error),
    updated_at: boundedString(value.updated_at, 64),
  };
}

function buildLifecycleState(agentId: string, value: any) {
  const normalizedId = validateAgentId(agentId);
  return normalizeLifecycleState(normalizedId, {
    schema: LIFECYCLE_SCHEMA,
    agent_id: normalizedId,
    ...value,
  });
}

async function writeAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o640 });
  await rename(tempPath, path);
}

export async function readAgentLifecycleState({ dir, agentId }: { dir: string; agentId: string }) {
  const normalizedId = validateAgentId(agentId);
  try {
    return normalizeLifecycleState(normalizedId, JSON.parse(await readFile(statePath(dir, normalizedId), 'utf-8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return unmanagedAgentLifecycleState(normalizedId);
    return unavailableAgentLifecycleState(normalizedId);
  }
}

export function readAgentLifecycleStateSync({ dir, agentId }: { dir: string; agentId: string }) {
  const normalizedId = validateAgentId(agentId);
  try {
    return normalizeLifecycleState(normalizedId, JSON.parse(readFileSync(statePath(dir, normalizedId), 'utf-8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return unmanagedAgentLifecycleState(normalizedId);
    return unavailableAgentLifecycleState(normalizedId);
  }
}

export async function updateAgentLifecycleState({
  dir,
  agentId,
  patch,
  now = nowIso,
}: {
  dir: string;
  agentId: string;
  patch: Record<string, unknown>;
  now?: () => string;
}) {
  const normalizedId = validateAgentId(agentId);
  const current = await readAgentLifecycleState({ dir, agentId: normalizedId });
  if (current.last_error === 'lifecycle_state_unavailable') {
    throw new Error('Lifecycle state is unavailable');
  }
  const next = buildLifecycleState(normalizedId, {
    ...current,
    ...patch,
    updated_at: now(),
  });
  await writeAtomic(statePath(dir, normalizedId), next);
  return next;
}

export function agentLifecycleAllowsDispatch(state: any) {
  if (!state || state.last_error === 'lifecycle_state_unavailable') return false;
  if (state.desired_state === 'stopped') return false;
  return !BLOCKED_DISPATCH_PHASES.has(state.phase);
}

export async function recoverInterruptedAgentLifecycleStates({
  dir,
  now = nowIso,
}: {
  dir: string;
  now?: () => string;
}) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const recovered: string[] = [];
  for (const name of names.filter((entry) => /^agent-[A-Za-z0-9._-]+\.json$/.test(entry))) {
    const agentId = name.slice('agent-'.length, -'.json'.length);
    const state = await readAgentLifecycleState({ dir, agentId });
    if (!INTERRUPTED_PHASES.has(state.phase)) continue;

    const completedAt = now();
    await updateAgentLifecycleState({
      dir,
      agentId,
      now,
      patch: {
        desired_state: state.previous_desired_state || 'unmanaged',
        phase: 'failed',
        previous_desired_state: null,
        last_error: 'interrupted_lifecycle_operation',
        last_operation: state.last_operation
          ? { ...state.last_operation, completed_at: completedAt, outcome: 'interrupted' }
          : null,
      },
    });
    recovered.push(agentId);
  }
  return recovered;
}
