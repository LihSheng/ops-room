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
    return { claimed: true, effect };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return { claimed: false, effect: await readEffect(dir, id) };
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
