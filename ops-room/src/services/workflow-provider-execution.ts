import { executeWorkflowChild } from './workflow-child-execution.js';
import { createWorkflowStageRunner } from './workflow-stage-runner.js';

export async function executeWorkflowChildWithProviders({
  effectsDir,
  providerAdapters,
  resolveStageInstruction,
  providerTimeoutMs,
  signal,
  executeChild = executeWorkflowChild,
  ...executionInput
}: any) {
  const runStage = createWorkflowStageRunner({
    effectsDir,
    providerAdapters,
    resolveStageInstruction,
    providerTimeoutMs,
    signal,
  });

  return executeChild({
    ...executionInput,
    runStage,
  });
}
