import { registerRouteExtension, type RouteEntry } from '../lib/router.js';
import {
  AUDIT_DIR,
  IDEMPOTENCY_DIR,
  TASK_WORKSPACE_ROOT,
  WORKFLOW_EFFECTS_DIR,
  WORKFLOW_RUNS_DIR,
  WORKSPACE_RECORDS_DIR,
} from '../services/runtime-paths.js';
import { authorizeOperatorRequest } from '../services/operator-request-auth.js';
import {
  handleOperatorWorkflowAction,
  type OperatorWorkflowAction,
} from '../services/operator-workflow-actions.js';
import { parseBody, sendJSON } from './helpers.js';

export function matchOperatorWorkflowRoute(pathname: string) {
  const match = pathname.match(
    /^\/api\/operator\/workflows\/([^/]+)\/children\/([^/]+)\/(retry|resume|decision)$/,
  );
  if (!match) return null;
  try {
    return {
      workflowId: decodeURIComponent(match[1]),
      childId: decodeURIComponent(match[2]),
      action: match[3],
    };
  } catch {
    return null;
  }
}

const operatorWorkflowRoute: RouteEntry = {
  method: 'POST',
  match: matchOperatorWorkflowRoute,
  handler: async (req, res, params) => {
    const action = params.action as OperatorWorkflowAction;
    const permission = action === 'decision' ? 'workflow.approve' : 'workflow.recover';
    const authorization = await authorizeOperatorRequest({ req, permission });
    if (!authorization.ok) {
      sendJSON(res, authorization.status, {
        error: authorization.error,
        error_code: authorization.error_code,
      });
      return;
    }

    try {
      const body = await parseBody(req);
      const result = await handleOperatorWorkflowAction({
        action,
        workflowId: params.workflowId,
        childId: params.childId,
        body,
        actor: authorization.actor,
        workflowRunsDir: WORKFLOW_RUNS_DIR,
        effectsDir: WORKFLOW_EFFECTS_DIR,
        workspaceRoot: TASK_WORKSPACE_ROOT,
        recordRoot: WORKSPACE_RECORDS_DIR,
        auditDir: AUDIT_DIR,
        idempotencyDir: IDEMPOTENCY_DIR,
      });
      sendJSON(res, result.status, result.body);
    } catch {
      sendJSON(res, 500, {
        error: 'Workflow action failed',
        error_code: 'workflow_action_failed',
      });
    }
  },
};

registerRouteExtension(operatorWorkflowRoute);
