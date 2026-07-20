#!/usr/bin/env node

// Thin entrypoint — validates durable configuration and restart recovery before composing the HTTP server.
import { initializeAgentProfileRegistry } from '../services/agent-profile/registry.js';
import { initializeSkillRegistry } from '../services/skill-registry/registry.js';
import { initializeMemorySpaceRegistry } from '../services/memory-space-registry/registry.js';
import { WORKFLOW_RUNS_DIR } from '../services/runtime-paths.js';
import { reconcileInterruptedWorkflowRuns } from '../services/workflow-run-reconciliation.js';

await initializeAgentProfileRegistry();
await initializeSkillRegistry();
await initializeMemorySpaceRegistry();

const workflowRecovery = await reconcileInterruptedWorkflowRuns({ dir: WORKFLOW_RUNS_DIR });
if (workflowRecovery.recovered_workflows > 0) {
  console.warn(
    `[workflow-reconciler] recovered ${workflowRecovery.recovered_children} interrupted child task(s) across ${workflowRecovery.recovered_workflows} workflow(s)`,
  );
}
if (workflowRecovery.unavailable.length > 0) {
  console.warn(`[workflow-reconciler] ${workflowRecovery.unavailable.length} workflow record(s) require investigation`);
}

await import('./http.js');
