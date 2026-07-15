import { readdir } from 'node:fs/promises';

import { countActiveTasks, readTask, recoverStaleTask } from './review-task-store.mjs';

const ACTIVE_STATES = new Set(['CLAIMED', 'RUNNING', 'FIXING']);

export async function reconcileReviewTasks({ dir, now, staleMinutes = 30, retryLimit = 3 }) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { scanned: 0, recovered: [], re_dispatched: [] };
    throw error;
  }
  const ids = names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  const recovered = [];
  const reDispatched = [];
  const corrupt = [];
  const counts = await countActiveTasks({ dir });
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
    if (result.recovered) {
      recovered.push(id);
      if (result.re_dispatched) reDispatched.push(id);
    }
  }
  return { scanned: ids.length, recovered, re_dispatched: reDispatched, corrupt };
}
