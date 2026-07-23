import { registerRouteExtension, type RouteEntry } from '../lib/router.js';
import { authorizeDashboardReadRequest } from '../services/dashboard-request-auth.js';
import { handleActivityEventIndex } from '../services/activity-event-index.js';
import {
  MISSIONS_DIR,
  WORKFLOW_EFFECTS_DIR,
  WORKFLOW_RUNS_DIR,
  WORKSPACE_RECORDS_DIR,
} from '../services/runtime-paths.js';
import { sendJSON } from './helpers.js';

export function matchActivityEventsRoute(pathname: string) {
  return pathname === '/api/activity-events' ? {} : null;
}

const activityEventsRoute: RouteEntry = {
  method: 'GET',
  match: matchActivityEventsRoute,
  handler: async (req, res, _params, url) => {
    const authorization = await authorizeDashboardReadRequest({ req });
    if (!authorization.ok) {
      sendJSON(res, authorization.status, {
        error: authorization.error,
        error_code: authorization.error_code,
      });
      return;
    }
    const result = await handleActivityEventIndex(url.searchParams, {
      missionsDir: MISSIONS_DIR,
      workflowRunsDir: WORKFLOW_RUNS_DIR,
      workflowEffectsDir: WORKFLOW_EFFECTS_DIR,
      workspaceRecordsDir: WORKSPACE_RECORDS_DIR,
    });
    sendJSON(res, result.status, result.body);
  },
};

registerRouteExtension(activityEventsRoute);
