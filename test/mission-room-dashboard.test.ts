import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const API_FILE = new URL('../dashboard/src/api/missions.ts', import.meta.url);
const BROWSER_FILE = new URL('../dashboard/src/components/MissionRoomBrowser.tsx', import.meta.url);
const TIMELINE_FILE = new URL('../dashboard/src/components/MissionRoomTimeline.tsx', import.meta.url);
const START_PANEL_FILE = new URL('../dashboard/src/components/MissionStartPanel.tsx', import.meta.url);

test('Mission Room client uses the authenticated additive mission detail contract', async () => {
  const source = await readFile(API_FILE, 'utf8');
  assert.match(source, /getMission: \(missionId: string\)/);
  assert.match(source, /`\/api\/missions\/\$\{encodeURIComponent\(missionId\)\}`/);
  assert.match(source, /credentials: 'same-origin'/);
  assert.match(source, /room_unavailable: boolean/);
});

test('Mission Room browser is reachable from the mission workflow queue', async () => {
  const browser = await readFile(BROWSER_FILE, 'utf8');
  const panel = await readFile(START_PANEL_FILE, 'utf8');
  assert.match(panel, /import \{ MissionRoomBrowser \}/);
  assert.match(panel, /<MissionRoomBrowser \/>/);
  assert.match(browser, /Open room/);
  assert.match(browser, /Professor → Tokyo → Professor → Berlin/);
  assert.match(browser, /do not dispatch agents, invoke providers, mutate Git, or replay uncertain effects/);
});

test('Mission Room timeline exposes bounded stage, workspace, effect, review, and retry evidence', async () => {
  const source = await readFile(TIMELINE_FILE, 'utf8');
  assert.match(source, /Deterministic workflow timeline/);
  assert.match(source, /Workspace evidence/);
  assert.match(source, /Provider-effect evidence/);
  assert.match(source, /No external success has been inferred/);
  assert.match(source, /review_decision/);
  assert.match(source, /retry_history/);
  assert.match(source, /Input SHA/);
  assert.match(source, /Output SHA/);
  assert.doesNotMatch(source, /absolute_path|relative_path|payload_hash|provider_output/);
});
