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
import { handleOperatorInvestigationAction } from '../services/operator-investigation-actions.js';
import { parseBody, sendJSON } from './helpers.js';

export function matchOperatorInvestigationRoute(pathname: string) {
  const effectMatch = pathname.match(
    /^\/api\/operator\/workflows\/([^/]+)\/children\/([^/]+)\/effects\/([^/]+)\/resolve$/,
  );
  const workspaceMatch = pathname.match(
    /^\/api\/operator\/workflows\/([^/]+)\/children\/([^/]+)\/workspaces\/([^/]+)\/(hold|release|cleanup)$/,
  );
  const match = effectMatch || workspaceMatch;
  if (!match) return null;
  try {
    if (effectMatch) {
      return {
        workflowId: decodeURIComponent(match[1]),
        childId: decodeURIComponent(match[2]),
        effectId: decodeURIComponent(match[3]),
        workspaceId: '',
        action: 'effect.resolve',
      };
    }
    return {
      workflowId: decodeURIComponent(match[1]),
      childId: decodeURIComponent(match[2]),
      effectId: '',
      workspaceId: decodeURIComponent(match[3]),
      action: `workspace.${match[4]}`,
    };
  } catch {
    return null;
  }
}

const operatorInvestigationRoute: RouteEntry = {
  method: 'POST',
  match: matchOperatorInvestigationRoute,
  handler: async (req, res, params) => {
    const authorization = await authorizeOperatorRequest({ req, permission: 'workflow.recover' });
    if (!authorization.ok) {
      sendJSON(res, authorization.status, {
        error: authorization.error,
        error_code: authorization.error_code,
      });
      return;
    }

    try {
      const body = await parseBody(req);
      const result = await handleOperatorInvestigationAction({
        action: params.action,
        workflowId: params.workflowId,
        childId: params.childId,
        effectId: params.effectId || null,
        workspaceId: params.workspaceId || null,
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
        error: 'Investigation action failed',
        error_code: 'operator_investigation_failed',
      });
    }
  },
};

registerRouteExtension(operatorInvestigationRoute);
