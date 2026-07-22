export type RuntimeTarget = {
  kind: 'docker-container' | 'unknown';
  name: string;
};

export type PreparedRuntime = {
  agent_id: string;
  adapter_id: string;
  backend: string;
  service: string;
  image: string | null;
  config_path: string;
  data_dir: string;
  desired_state: string;
  target: RuntimeTarget;
};

export type RuntimeStatus = {
  status: string;
  state: string;
  health: string;
  started_at?: string | null;
  finished_at?: string | null;
  restart_count?: number;
  exit_code?: number | null;
  oom_killed?: boolean;
};

export type RuntimeAdapterInspection = {
  adapter_id: string;
  available: boolean;
  error: string | null;
  fetched_at: number;
  runtimes: Record<string, RuntimeStatus>;
};

export type RuntimeInspectionInstance = {
  agent: string;
  adapter_id: string;
  definition: any;
  prepared: PreparedRuntime;
  runtime: RuntimeStatus;
};

export type RuntimeInspectionSnapshot = {
  instances: RuntimeInspectionInstance[];
  adapters: Array<{
    adapter_id: string;
    available: boolean;
    error: string | null;
    fetched_at: number;
  }>;
};

export interface AgentRuntimeAdapter {
  id: string;
  supports(agentDefinition: any): boolean;
  prepare(agentDefinition: any): PreparedRuntime;
  inspect(preparedRuntimes: PreparedRuntime[]): RuntimeAdapterInspection;
}

export function unknownRuntimeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    status: 'unknown',
    state: 'unknown',
    health: 'unknown',
    ...overrides,
  };
}
