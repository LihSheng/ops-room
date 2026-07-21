import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EFFECT_SCHEMA = 'ops-room.workflow-effect.v1';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SAFE_EFFECT_TYPE = /^[a-z][a-z0-9._:-]{0,79}$/;
const SAFE_SHA = /^[0-9a-f]{40}$/i;
const TERMINAL_STATES = new Set(['completed', 'failed', 'needs_human']);

function bounded(value: unknown, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function validateId(value: unknown, field: string) {
  const normalized = bounded(value);
  if (!SAFE_ID.test(normalized)) throw new Error(`workflow_effect_${field}_invalid`);
  return normalized;
}

function validateEffectType(value: unknown) {
  const normalized = bounded(value, 80).toLowerCase();
  if (!SAFE_EFFECT_TYPE.test(normalized)) throw new Error('workflow_effect_type_invalid');
  return normalized;
}

function effectDigest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function stablePayloadHash(payload: unknown) {
  const normalized = JSON.stringify(payload ?? null, Object.keys((payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload as object : {}).sort());
  return effectDigest(normalized);
}

function effectIdentity({ workflowId, childId, effectType, idempotencyKey }: any) {
  const workflow_id = validateId(workflowId, 'workflow_id');
  const child_id = validateId(childId, 'child_id');
  const effect_type = validateEffectType(effectType);
  const idempotency_key = validateId(idempotencyKey, 'idempotency_key');
  return {
    workflow_id,
    child_id,
    effect_type,
    idempotency_key,
    effect_id: `effect:${effectDigest(`${workflow_id}\n${child_id}\n${effect_type}\n${idempotency_key}`).slice(0, 40)}`,
  };
}

function effectPath(dir: string, effectId: string) {
  return join(dir, `effect-${effectDigest(effectId)}.json`);
}

async function writeAtomic(path: string, value: unknown) {
  await mkdir(join(path, '..'), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function validateWorkflowEffect(record: any) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('workflow_effect_record_invalid');
  }
  if (record.schema !== EFFECT_SCHEMA) throw new Error('workflow_effect_schema_invalid');
  const identity = effectIdentity({
    workflowId: record.workflow_id,
    childId: record.child_id,
    effectType: record.effect_type,
    idempotencyKey: record.idempotency_key,
  });
  if (record.effect_id !== identity.effect_id) throw new Error('workflow_effect_identity_mismatch');
  if (!['claimed', 'completed', 'failed', 'needs_human'].includes(record.state)) {
    throw new Error('workflow_effect_state_invalid');
  }
  if (!/^[0-9a-f]{64}$/i.test(String(record.payload_hash || ''))) {
    throw new Error('workflow_effect_payload_hash_invalid');
  }
  if (!record.claimed_at || !record.updated_at) throw new Error('workflow_effect_timestamp_missing');
  if (record.output_sha != null && !SAFE_SHA.test(String(record.output_sha))) {
    throw new Error('workflow_effect_output_sha_invalid');
  }
  return { ...record, ...identity };
}

export async function readWorkflowEffect({ dir, effectId }: any) {
  try {
    const record = JSON.parse(await readFile(effectPath(dir, validateId(effectId, 'id')), 'utf-8'));
    return validateWorkflowEffect(record);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function claimWorkflowEffect({
  dir,
  workflowId,
  childId,
  effectType,
  idempotencyKey,
  payload,
  now = () => new Date().toISOString(),
}: any) {
  const identity = effectIdentity({ workflowId, childId, effectType, idempotencyKey });
  const payload_hash = stablePayloadHash(payload);
  const path = effectPath(dir, identity.effect_id);
  const existing = await readWorkflowEffect({ dir, effectId: identity.effect_id });
  if (existing) {
    if (existing.payload_hash !== payload_hash) throw new Error('workflow_effect_payload_conflict');
    return { created: false, effect: existing, execute: existing.state === 'claimed' };
  }

  const at = now();
  const effect = validateWorkflowEffect({
    schema: EFFECT_SCHEMA,
    ...identity,
    payload_hash,
    state: 'claimed',
    claimed_at: at,
    updated_at: at,
    completed_at: null,
    output_sha: null,
    result_code: null,
    attempt: 1,
  });

  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(effect, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
    return { created: true, effect, execute: true };
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = await readWorkflowEffect({ dir, effectId: identity.effect_id });
    if (!raced) throw new Error('workflow_effect_claim_race_unresolved');
    if (raced.payload_hash !== payload_hash) throw new Error('workflow_effect_payload_conflict');
    return { created: false, effect: raced, execute: raced.state === 'claimed' };
  }
}

export async function completeWorkflowEffect({
  dir,
  effectId,
  state = 'completed',
  resultCode = 'ok',
  outputSha = null,
  now = () => new Date().toISOString(),
}: any) {
  if (!TERMINAL_STATES.has(state)) throw new Error('workflow_effect_terminal_state_invalid');
  const current = await readWorkflowEffect({ dir, effectId });
  if (!current) throw new Error('workflow_effect_not_found');
  const normalizedOutputSha = outputSha == null ? null : String(outputSha).toLowerCase();
  if (normalizedOutputSha && !SAFE_SHA.test(normalizedOutputSha)) {
    throw new Error('workflow_effect_output_sha_invalid');
  }
  const result_code = bounded(resultCode, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/.test(result_code)) {
    throw new Error('workflow_effect_result_code_invalid');
  }

  if (TERMINAL_STATES.has(current.state)) {
    if (current.state !== state || current.result_code !== result_code || current.output_sha !== normalizedOutputSha) {
      throw new Error('workflow_effect_terminal_conflict');
    }
    return { updated: false, effect: current };
  }
  if (current.state !== 'claimed') throw new Error('workflow_effect_not_claimed');

  const at = now();
  const effect = validateWorkflowEffect({
    ...current,
    state,
    result_code,
    output_sha: normalizedOutputSha,
    completed_at: at,
    updated_at: at,
  });
  await writeAtomic(effectPath(dir, current.effect_id), effect);
  return { updated: true, effect };
}

export async function listWorkflowEffects({ dir, workflowId = null, childId = null, limit = 200 }: any) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const effects = [];
  for (const name of names.filter((entry) => entry.startsWith('effect-') && entry.endsWith('.json'))) {
    try {
      const effect = validateWorkflowEffect(JSON.parse(await readFile(join(dir, name), 'utf-8')));
      if (workflowId && effect.workflow_id !== workflowId) continue;
      if (childId && effect.child_id !== childId) continue;
      effects.push(effect);
    } catch (error) {
      continue;
    }
  }
  return effects
    .sort((a, b) => String(b.claimed_at).localeCompare(String(a.claimed_at)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 200, 1000)));
}
