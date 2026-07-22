import type { HealthResponse, InstancesResponse, LogsResponse, TasksResponse } from './types';

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const opsApi = {
  health: () => getJson<HealthResponse>('/api/health'),
  instances: () => getJson<InstancesResponse>('/api/openab/instances'),
  tasks: () => getJson<TasksResponse>('/api/tasks'),
  logs: (agent: string, href?: string) =>
    getJson<LogsResponse>(href || `/api/logs?agent=${encodeURIComponent(agent)}`),
};
