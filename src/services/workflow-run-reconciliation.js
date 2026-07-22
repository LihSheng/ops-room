import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeAtomic } from './review-task-store.js';
import { listWorkflowRuns, readWorkflowRun, validateWorkflowRun, } from './workflow-run-store.js';
import { withWorkspaceLock } from './workspace-locks.js';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,180}$/;
const INTERRUPTION_ERROR = 'workflow_child_interrupted';
function workflowFilename(workflowId) {
    if (!SAFE_ID.test(String(workflowId || '')))
        throw new Error('invalid_workflow_id');
    const digest = createHash('sha256').update(workflowId).digest('hex');
    return `workflow-${digest}.json`;
}
function workflowPath(dir, workflowId) {
    return join(dir, workflowFilename(workflowId));
}
function lockName(workflowId) {
    const digest = createHash('sha256').update(workflowId).digest('hex').slice(0, 32);
    return `workflow-reconcile-${digest}`;
}
function isUnavailableRecord(record) {
    return record?.last_error === 'workflow_record_unavailable'
        || !SAFE_ID.test(String(record?.workflow_id || ''));
}
async function reconcileOne({ dir, workflowId, now }) {
    return withWorkspaceLock({
        dir: join(dir, '.locks'),
        name: lockName(workflowId),
        execute: async () => {
            const run = await readWorkflowRun({ dir, workflowId });
            const interrupted = run.children.filter((child) => child.state === 'active');
            if (interrupted.length === 0) {
                return { changed: false, workflow_id: workflowId, child_ids: [] };
            }
            const at = now();
            const interruptedIds = new Set(interrupted.map((child) => child.child_id));
            const children = run.children.map((child) => {
                if (!interruptedIds.has(child.child_id))
                    return child;
                return {
                    ...child,
                    state: 'needs_human',
                    updated_at: at,
                    last_error: INTERRUPTION_ERROR,
                    history: [
                        ...(child.history || []),
                        {
                            from: 'active',
                            to: 'needs_human',
                            at,
                            reason: INTERRUPTION_ERROR,
                        },
                    ],
                };
            });
            const updated = validateWorkflowRun({
                ...run,
                state: 'needs_human',
                updated_at: at,
                children,
                history: [
                    ...(run.history || []),
                    {
                        event: 'workflow_restart_reconciled',
                        child_ids: [...interruptedIds],
                        reason: INTERRUPTION_ERROR,
                        at,
                    },
                ],
            });
            await writeAtomic(workflowPath(dir, workflowId), updated);
            return {
                changed: true,
                workflow_id: workflowId,
                child_ids: [...interruptedIds],
            };
        },
    });
}
export async function reconcileInterruptedWorkflowRuns({ dir, now = () => new Date().toISOString(), listRuns = listWorkflowRuns, } = {}) {
    const records = await listRuns({ dir, limit: 500 });
    const recovered = [];
    const unavailable = [];
    for (const record of records) {
        if (isUnavailableRecord(record)) {
            unavailable.push(String(record?.workflow_id || 'workflow-unavailable'));
            continue;
        }
        try {
            const result = await reconcileOne({ dir, workflowId: record.workflow_id, now });
            if (result.changed)
                recovered.push(result);
        }
        catch {
            unavailable.push(record.workflow_id);
        }
    }
    return {
        scanned: records.length,
        recovered,
        recovered_workflows: recovered.length,
        recovered_children: recovered.reduce((total, item) => total + item.child_ids.length, 0),
        unavailable,
    };
}
export const WORKFLOW_INTERRUPTION_ERROR = INTERRUPTION_ERROR;
//# sourceMappingURL=workflow-run-reconciliation.js.map