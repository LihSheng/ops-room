#!/usr/bin/env node

// Thin entrypoint — validates durable configuration and restart recovery before composing the HTTP server.
import { initializeAgentProfileRegistry } from '../services/agent-profile/registry.js';
import { initializeSkillRegistry } from '../services/skill-registry/registry.js';
import { initializeMemorySpaceRegistry } from '../services/memory-space-registry/registry.js';
import { WORKFLOW_EFFECTS_DIR, WORKFLOW_RUNS_DIR } from '../services/runtime-paths.js';
import { reconcileInterruptedWorkflowEffects } from '../services/workflow-effect-store.js';
import { reconcileInterruptedWorkflowRuns } from '../services/workflow-run-reconciliation.js';

await initializeAgentProfileRegistry();
await initializeSkillRegistry();
await initializeMemorySpaceRegistry();

const effectRecovery = await reconcileInterruptedWorkflowEffects({ dir: WORKFLOW_EFFECTS_DIR });
if (effectRecovery.recovered_effects > 0) {
  console.warn(
    `[workflow-effect-reconciler] recovered ${effectRecovery.recovered_effects} interrupted external effect claim(s)`,
  );
}
if (effectRecovery.unavailable.length > 0) {
  console.warn(`[workflow-effect-reconciler] ${effectRecovery.unavailable.length} effect record(s) require investigation`);
}

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
