export type RuntimeStatus = 'running' | 'healthy' | 'restarting' | 'stopped' | 'exited' | 'missing' | 'unknown' | string;

export interface HealthResponse {
  status?: string;
  uptime_seconds?: number;
  version?: string;
  commands?: Record<string, boolean>;
  paths?: Record<string, string>;
}

export interface AgentRuntime {
  status?: RuntimeStatus;
  state?: string;
  started_at?: string | null;
  finished_at?: string | null;
  restart_count?: number;
  health?: RuntimeStatus;
  exit_code?: number;
  oom_killed?: boolean;
}

export interface AgentInstance {
  agent: string;
  display_name?: string;
  service?: string;
  container_name?: string;
  backend?: string;
  image?: string;
  config_path?: string;
  data_dir?: string;
  github_polling_enabled?: boolean;
  runtime?: AgentRuntime;
  links?: { logs?: string; tasks?: string };
}

export interface InstancesResponse {
  instances?: AgentInstance[];
  docker?: { available?: boolean; error?: string | null };
}

export interface OpsTask {
  id?: string;
  task_id?: string;
  file?: string;
  agent?: string;
  status?: string;
  state?: string;
  issue_title?: string;
  issue_number?: number;
  repository?: string;
  received_at?: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  trigger?: string;
  task_type?: string;
  taskType?: string;
  task?: string;
  task_text?: string;
  pr?: number;
  mode?: string;
  error?: string;
  [key: string]: unknown;
}

export interface TasksResponse {
  tasks?: OpsTask[];
}

export interface LogEntry {
  file?: string;
  lines?: string[];
}

export interface LogsResponse {
  logs?: LogEntry[];
}
