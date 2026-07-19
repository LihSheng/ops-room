import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const LIFECYCLE_SCHEMA = 'ops-room.agent-lifecycle.v1';
const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;
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

function normalizeLifecycleState(agentId: string, value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return unavailableAgentLifecycleState(agentId);
  }
  return {
    ...unmanagedAgentLifecycleState(agentId),
    ...value,
    schema: LIFECYCLE_SCHEMA,
    agent_id: validateAgentId(agentId),
  };
}

async function writeAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
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
  const next = normalizeLifecycleState(normalizedId, {
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

    await updateAgentLifecycleState({
      dir,
      agentId,
      now,
      patch: {
        desired_state: state.previous_desired_state || 'unmanaged',
        phase: 'failed',
        last_error: 'interrupted_lifecycle_operation',
        last_operation: state.last_operation
          ? { ...state.last_operation, completed_at: now(), outcome: 'interrupted' }
          : null,
      },
    });
    recovered.push(agentId);
  }
  return recovered;
}
