import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const API_FILE = new URL('../dashboard/src/api/missions.ts', import.meta.url);
const PANEL_FILE = new URL('../dashboard/src/components/MissionStartPanel.tsx', import.meta.url);
const FLEET_FILE = new URL('../dashboard/src/pages/AgentFleetPage.tsx', import.meta.url);

test('dashboard mission start client sends session CSRF and exact action confirmation', async () => {
  const source = await readFile(API_FILE, 'utf8');
  assert.match(source, /\/api\/operator\/missions\/\$\{encodeURIComponent\(missionId\)\}\/start/);
  assert.match(source, /'X-Ops-Room-CSRF': csrfToken/);
  assert.match(source, /'X-Ops-Room-Confirmation': `confirm:mission\.start:POST:\$\{path\}`/);
  assert.match(source, /credentials: 'same-origin'/);
});

test('mission start UI remains role gated and explains the no-provider boundary', async () => {
  const source = await readFile(PANEL_FILE, 'utf8');
  assert.match(source, /roles\.includes\('operator'\) \|\| roles\.includes\('administrator'\)/);
  assert.match(source, /auth\.mode === 'session'/);
  assert.match(source, /does not allocate a workspace, dispatch an agent, or invoke a provider/);
  assert.match(source, /provider was invoked/);
  assert.match(source, /pending Professor implementation stage/);
  assert.match(source, /idempotency_key: requestKey/);
});

test('Agent Fleet renders the mission workflow queue', async () => {
  const source = await readFile(FLEET_FILE, 'utf8');
  assert.match(source, /import \{ MissionStartPanel \}/);
  assert.match(source, /<MissionStartPanel \/>/);
});
