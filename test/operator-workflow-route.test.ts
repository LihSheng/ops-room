import assert from 'node:assert/strict';
import test from 'node:test';

import { matchOperatorWorkflowRoute } from '../src/routes/operator-workflows.js';

test('matches and decodes encoded workflow and child identifiers', () => {
  assert.deepEqual(
    matchOperatorWorkflowRoute(
      '/api/operator/workflows/workflow%3Arepo%3A1/children/workflow%3Arepo%3Achild%3A1%3Areview/decision',
    ),
    {
      workflowId: 'workflow:repo:1',
      childId: 'workflow:repo:child:1:review',
      action: 'decision',
    },
  );
});

test('rejects malformed encoded route identifiers', () => {
  assert.equal(
    matchOperatorWorkflowRoute('/api/operator/workflows/%E0%A4%A/children/child/retry'),
    null,
  );
});
