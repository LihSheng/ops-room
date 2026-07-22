import { executeWorkflowChild } from './workflow-child-execution.js';
import { createProfileWorkflowProviderAdapters } from './workflow-provider-adapters.js';
import { createWorkflowStageRunner } from './workflow-stage-runner.js';
export async function executeWorkflowChildWithProviders({ effectsDir, providerAdapters = createProfileWorkflowProviderAdapters(), resolveStageInstruction, providerTimeoutMs, providerTerminationGraceMs, signal, executeChild = executeWorkflowChild, ...executionInput }) {
    const runStage = createWorkflowStageRunner({
        effectsDir,
        providerAdapters,
        resolveStageInstruction,
        providerTimeoutMs,
        providerTerminationGraceMs,
        signal,
    });
    return executeChild({
        ...executionInput,
        runStage,
    });
}
//# sourceMappingURL=workflow-provider-execution.js.map