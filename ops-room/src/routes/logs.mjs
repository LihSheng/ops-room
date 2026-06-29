import { readLogFiles } from '../services/logs.mjs';

export async function handleLogsList(searchParams) {
  return readLogFiles({
    agent: searchParams.get('agent') || '',
    taskId: searchParams.get('task_id') || '',
    limit: searchParams.get('limit') || '200',
  });
}
