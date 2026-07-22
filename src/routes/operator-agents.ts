import { getAgentDefinition } from '../services/agent-definitions.js';
import { agentLifecycleAllowsDispatch, readAgentLifecycleState } from '../services/agent-lifecycle-store.js';
import { inspectAgentRuntimes } from '../services/runtime-adapter/registry.js';
import { prepareAgentLifecycleTarget } from '../services/runtime-lifecycle/registry.js';
import { scanReviewTasks } from '../services/review-task-store.js';
import { stopAgent, startAgent } from '../services/agent-lifecycle-controller.js';

import type { IncomingMessage, ServerResponse } from 'node:http';

export async function handleOperatorAgentStop(args: {
  agentId: string;
  body: Record<string, unknown>;
  actor: Record<string, unknown>;
  reviewTasksDir: string;
  lifecycleDir: string;
  auditDir: string;
  idempotencyDir: string;
  allowedAgents?: string[] | Set<string>;
  drainTimeoutMs?: number;
  drainPollMs?: number;
  stopTimeoutSeconds?: number;
}) {
  return stopAgent({
    getRuntimeSnapshot: inspectAgentRuntimes,
    prepareTarget: prepareAgentLifecycleTarget,
    scanTasks: scanReviewTasks,
    ...args,
  } as Parameters<typeof stopAgent>[0]);
}

export async function handleOperatorAgentStart(args: {
  agentId: string;
  body: Record<string, unknown>;
  actor: Record<string, unknown>;
  reviewTasksDir: string;
  lifecycleDir: string;
  auditDir: string;
  idempotencyDir: string;
  allowedAgents?: string[] | Set<string>;
  startTimeoutSeconds?: number;
  freshRuntimeSnapshot?: (() => Record<string, unknown> | null) | null;
}) {
  return startAgent({
    getRuntimeSnapshot: inspectAgentRuntimes,
    prepareTarget: prepareAgentLifecycleTarget,
    scanTasks: scanReviewTasks,
    ...args,
  } as Parameters<typeof startAgent>[0]);
}

export async function canDispatchAgentFromLifecycle({ lifecycleDir, agentId }: {
  lifecycleDir: string;
  agentId: string;
}) {
  const state = await readAgentLifecycleState({ dir: lifecycleDir, agentId });
  return agentLifecycleAllowsDispatch(state);
}
