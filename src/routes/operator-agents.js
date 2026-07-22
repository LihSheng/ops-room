import { getAgentDefinition } from '../services/agent-definitions.js';
import { agentLifecycleAllowsDispatch, readAgentLifecycleState } from '../services/agent-lifecycle-store.js';
import { inspectAgentRuntimes } from '../services/runtime-adapter/registry.js';
import { prepareAgentLifecycleTarget } from '../services/runtime-lifecycle/registry.js';
import { scanReviewTasks } from '../services/review-task-store.js';
import { stopAgent, startAgent } from '../services/agent-lifecycle-controller.js';
export async function handleOperatorAgentStop(args) {
    return stopAgent({
        getRuntimeSnapshot: inspectAgentRuntimes,
        prepareTarget: prepareAgentLifecycleTarget,
        scanTasks: scanReviewTasks,
        ...args,
    });
}
export async function handleOperatorAgentStart(args) {
    return startAgent({
        getRuntimeSnapshot: inspectAgentRuntimes,
        prepareTarget: prepareAgentLifecycleTarget,
        scanTasks: scanReviewTasks,
        ...args,
    });
}
export async function canDispatchAgentFromLifecycle({ lifecycleDir, agentId }) {
    const state = await readAgentLifecycleState({ dir: lifecycleDir, agentId });
    return agentLifecycleAllowsDispatch(state);
}
//# sourceMappingURL=operator-agents.js.map