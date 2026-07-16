import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function effectId({ taskId, kind, fingerprint }) {
  return createHash('sha256').update(`${taskId}\u0000${kind}\u0000${fingerprint}`).digest('hex');
}

function effectPath(dir, id) {
  return join(dir, 'effects', `${id}.json`);
}

async function readEffect(dir, id) {
  try { return JSON.parse(await readFile(effectPath(dir, id), 'utf-8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function claimEffect({ dir, taskId, kind, fingerprint }) {
  const id = effectId({ taskId, kind, fingerprint });
  const path = effectPath(dir, id);
  await mkdir(join(dir, 'effects'), { recursive: true });
  const effect = { id, task_id: taskId, kind, fingerprint, state: 'CLAIMED', created_at: new Date().toISOString() };
  try {
    const handle = await open(path, 'wx');
    try { await handle.writeFile(`${JSON.stringify(effect, null, 2)}\n`); } finally { await handle.close(); }
    return { claimed: true, state: 'CLAIMED', effect };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readEffect(dir, id);
    return { claimed: false, state: existing?.state || 'CLAIMED', effect: existing };
  }
}

export async function completeEffect({ dir, effectId: id, result = {} }) {
  const current = await readEffect(dir, id);
  if (!current) throw new Error(`Effect not found: ${id}`);
  const effect = { ...current, state: 'COMPLETED', completed_at: new Date().toISOString(), result };
  const { writeAtomic } = await import('./review-task-store.mjs');
  await writeAtomic(effectPath(dir, id), effect);
  return effect;
}

export async function listEffects({ dir, taskId, kind, state }) {
  const { readdir } = await import('node:fs/promises');
  const effectsDir = join(dir, 'effects');
  let names;
  try { names = await readdir(effectsDir); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const effects = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const effect = JSON.parse(await readFile(join(effectsDir, name), 'utf-8'));
      if (taskId && effect.task_id !== taskId) continue;
      if (kind && effect.kind !== kind) continue;
      if (state && effect.state !== state) continue;
      effects.push(effect);
    } catch { /* skip corrupt */ }
  }
  return effects.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function resolveAmbiguousEffect({ dir, effectId: id, resolution, notes = '' }) {
  const current = await readEffect(dir, id);
  if (!current) throw new Error(`Effect not found: ${id}`);
  if (current.state !== 'CLAIMED') throw new Error(`Can only resolve CLAIMED effects, not ${current.state}`);
  const resolvedState = resolution === 'complete' ? 'COMPLETED' : resolution === 'abandon' ? 'ABANDONED' : resolution;
  const effect = {
    ...current,
    state: resolvedState,
    resolved_at: new Date().toISOString(),
    resolution_notes: notes || `Operator resolved as ${resolvedState}`,
  };
  const { writeAtomic } = await import('./review-task-store.mjs');
  await writeAtomic(effectPath(dir, id), effect);
  return effect;
}
