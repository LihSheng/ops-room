import assert from 'node:assert/strict';
import test from 'node:test';

import { requiresDashboardReadAuth } from '../src/routes/helpers.js';

function request(url: string, method = 'GET') {
  return { url, method, headers: {} };
}

test('mission list, detail, and Mission Room reads require dashboard authentication', () => {
  assert.equal(requiresDashboardReadAuth(request('/api/missions')), true);
  assert.equal(requiresDashboardReadAuth(request('/api/missions?limit=100')), true);
  assert.equal(requiresDashboardReadAuth(request('/api/missions/mission:example:1234567890abcdef12345678')), true);
  assert.equal(requiresDashboardReadAuth(request('/api/missions/mission:example:1234567890abcdef12345678/room')), true);
});

test('mission mutations remain outside the dashboard read matcher', () => {
  assert.equal(requiresDashboardReadAuth(request('/api/operator/missions', 'POST')), false);
  assert.equal(requiresDashboardReadAuth(request('/api/operator/missions/mission:example:123/start', 'POST')), false);
});
