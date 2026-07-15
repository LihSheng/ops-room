import { readdir } from 'node:fs/promises';

import { readTask, recoverStaleTask } from './review-task-store.mjs';

const ACTIVE_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);

export async function reconcileReviewTasks({ dir, now, staleMinutes = 30, retryLimit = 2 }) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { scanned: 0, recovered: [] };
    throw error;
  }
  const ids = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  const recovered = [];
  const corrupt = [];
  for (const id of ids) {
    let task;
    try {
      task = await readTask({ dir, id });
    } catch (error) {
      if (error instanceof SyntaxError) { corrupt.push(id); continue; }
      throw error;
    }
    if (!task || !ACTIVE_STATES.has(task.state)) continue;
    const result = await recoverStaleTask({ dir, id, now, staleMinutes, retryLimit });
    if (result.recovered) recovered.push(id);
  }
  return { scanned: ids.length, recovered, corrupt };
}
