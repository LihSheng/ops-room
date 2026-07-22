#!/usr/bin/env node
// Thin entrypoint — validates durable configuration and restart recovery before composing the HTTP server.
import { initializeAgentProfileRegistry } from '../services/agent-profile/registry.js';
import { initializeSkillRegistry } from '../services/skill-registry/registry.js';
import { initializeMemorySpaceRegistry } from '../services/memory-space-registry/registry.js';
import { TASK_WORKSPACE_ROOT, WORKFLOW_EFFECTS_DIR, WORKFLOW_RUNS_DIR, WORKSPACE_RECORDS_DIR, } from '../services/runtime-paths.js';
import { reconcileInterruptedWorkflowEffects } from '../services/workflow-effect-store.js';
import { reconcileProviderBackedWorkflowRuns } from '../services/workflow-provider-recovery.js';
import { reconcileInterruptedWorkflowRuns } from '../services/workflow-run-reconciliation.js';
await initializeAgentProfileRegistry();
await initializeSkillRegistry();
await initializeMemorySpaceRegistry();
const effectRecovery = await reconcileInterruptedWorkflowEffects({ dir: WORKFLOW_EFFECTS_DIR });
if (effectRecovery.recovered_effects > 0) {
    console.warn(`[workflow-effect-reconciler] recovered ${effectRecovery.recovered_effects} interrupted external effect claim(s)`);
}
if (effectRecovery.unavailable.length > 0) {
    console.warn(`[workflow-effect-reconciler] ${effectRecovery.unavailable.length} effect record(s) require investigation`);
}
const workflowRecovery = await reconcileInterruptedWorkflowRuns({ dir: WORKFLOW_RUNS_DIR });
if (workflowRecovery.recovered_workflows > 0) {
    console.warn(`[workflow-reconciler] recovered ${workflowRecovery.recovered_children} interrupted child task(s) across ${workflowRecovery.recovered_workflows} workflow(s)`);
}
if (workflowRecovery.unavailable.length > 0) {
    console.warn(`[workflow-reconciler] ${workflowRecovery.unavailable.length} workflow record(s) require investigation`);
}
const providerRecovery = await reconcileProviderBackedWorkflowRuns({
    workflowRunsDir: WORKFLOW_RUNS_DIR,
    effectsDir: WORKFLOW_EFFECTS_DIR,
    workspaceRoot: TASK_WORKSPACE_ROOT,
    recordRoot: WORKSPACE_RECORDS_DIR,
});
if (providerRecovery.recovered_children > 0) {
    console.warn(`[workflow-provider-reconciler] recovered ${providerRecovery.recovered_children} child task(s) from completed provider effects`);
}
if (providerRecovery.cleanup_reconciled > 0) {
    console.warn(`[workflow-provider-reconciler] reconciled ${providerRecovery.cleanup_reconciled} recovered workspace cleanup request(s)`);
}
if (providerRecovery.review_decisions_reconciled > 0) {
    console.warn(`[workflow-provider-reconciler] reconciled ${providerRecovery.review_decisions_reconciled} Berlin review decision(s)`);
}
if (providerRecovery.unavailable.length > 0) {
    console.warn(`[workflow-provider-reconciler] ${providerRecovery.unavailable.length} workflow recovery record(s) require investigation`);
}
await import('./http.js');
//# sourceMappingURL=webhook.js.map