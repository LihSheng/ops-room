import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), 'utf-8');
}

test('mission dashboard client uses the existing session and CSRF operator boundary', async () => {
  const api = await source('../dashboard/src/api/missions.ts');

  assert.match(api, /\/api\/operator\/missions/);
  assert.match(api, /method:\s*'POST'/);
  assert.match(api, /credentials:\s*'same-origin'/);
  assert.match(api, /'X-Ops-Room-CSRF':\s*csrfToken/);
  assert.match(api, /'Content-Type':\s*'application\/json'/);
  assert.doesNotMatch(api, /Authorization/);
});

test('mission creation form preserves the bounded OPS-012C contract', async () => {
  const component = await source('../dashboard/src/components/MissionCreationModal.tsx');

  assert.match(component, /workflow_type:\s*'feature-development'/);
  assert.match(component, /approval_policy:\s*'berlin-review-required'/);
  assert.match(component, /SHA_PATTERN\s*=\s*\/\^\[0-9a-f\]\{40\}\$\/i/);
  assert.match(component, /maxIterations[^]*?min=\{1\}[^]*?max=\{20\}/);
  assert.match(component, /reason:\s*form\.reason\.trim\(\)/);
  assert.match(component, /idempotency_key:\s*requestKey/);
  assert.match(component, /does not start a workflow/i);
  assert.match(component, /Local file paths are rejected/i);
});

test('mission creation is hidden behind human Operator or Administrator authority', async () => {
  const fleetPage = await source('../dashboard/src/pages/AgentFleetPage.tsx');

  assert.match(fleetPage, /auth\.mode === 'session'/);
  assert.match(fleetPage, /roles\.includes\('operator'\)/);
  assert.match(fleetPage, /roles\.includes\('administrator'\)/);
  assert.match(fleetPage, /disabled=\{!canCreateMission\}/);
  assert.match(fleetPage, /Legacy dashboard-token mode remains read-only/);
  assert.match(fleetPage, /csrfToken=\{auth\.session\?\.csrf_token \|\| null\}/);
});
