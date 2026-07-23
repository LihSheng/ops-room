import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const API_FILE = new URL('../dashboard/src/api/missions.ts', import.meta.url);
const APP_FILE = new URL('../dashboard/src/App.tsx', import.meta.url);
const BROWSER_FILE = new URL('../dashboard/src/components/MissionRoomBrowser.tsx', import.meta.url);
const CONTENT_FILE = new URL('../dashboard/src/components/MissionRoomContent.tsx', import.meta.url);
const TIMELINE_FILE = new URL('../dashboard/src/components/MissionRoomTimeline.tsx', import.meta.url);
const START_PANEL_FILE = new URL('../dashboard/src/components/MissionStartPanel.tsx', import.meta.url);
const LIST_PAGE_FILE = new URL('../dashboard/src/pages/MissionsPage.tsx', import.meta.url);
const ROOM_PAGE_FILE = new URL('../dashboard/src/pages/MissionRoomPage.tsx', import.meta.url);
const CURRENT_MISSION_FILE = new URL('../dashboard/src/components/CurrentMissionEvidence.tsx', import.meta.url);

test('Mission Room client uses the authenticated additive mission detail contract', async () => {
  const source = await readFile(API_FILE, 'utf8');
  assert.match(source, /getMission: \(missionId: string\)/);
  assert.match(source, /`\/api\/missions\/\$\{encodeURIComponent\(missionId\)\}`/);
  assert.match(source, /credentials: 'same-origin'/);
  assert.match(source, /room_unavailable: boolean/);
});

test('Missions are first-class navigation routes with nested route highlighting', async () => {
  const source = await readFile(APP_FILE, 'utf8');
  assert.match(source, /label: 'Missions', path: '\/missions'/);
  assert.match(source, /<Route path="\/missions" element=\{<MissionsPage \/>\} \/>/);
  assert.match(source, /<Route path="\/missions\/:missionId" element=\{<MissionRoomPage \/>\} \/>/);
  assert.match(source, /pathname\.startsWith\(`\$\{path\}\/`\)/);
  assert.match(source, /\['missions'\], \['mission-room'\]/);
});

test('Agent Fleet retains mission controls but delegates room browsing to first-class navigation', async () => {
  const browser = await readFile(BROWSER_FILE, 'utf8');
  const panel = await readFile(START_PANEL_FILE, 'utf8');
  assert.match(panel, /import \{ MissionRoomBrowser \}/);
  assert.match(panel, /<MissionRoomBrowser \/>/);
  assert.match(browser, /Open Missions/);
  assert.match(browser, /navigate\('\/missions'\)/);
  assert.doesNotMatch(browser, /<Modal|selected|setSelected/);
});

test('Missions list and room pages preserve exact deep links and bounded failure states', async () => {
  const list = await readFile(LIST_PAGE_FILE, 'utf8');
  const room = await readFile(ROOM_PAGE_FILE, 'utf8');
  assert.match(list, /navigate\(`\/missions\/\$\{encodeURIComponent\(mission\.mission_id\)\}`\)/);
  assert.match(list, /Search Missions/);
  assert.match(list, /Some Mission records are unavailable/);
  assert.match(room, /useParams<\{ missionId: string \}>/);
  assert.match(room, /Mission not found/);
  assert.match(room, /Invalid Mission route/);
  assert.match(room, /does not silently redirect elsewhere/);
  assert.doesNotMatch(room, /<Navigate/);
});

test('Agent current-Mission evidence links to the same exact Mission Room URL', async () => {
  const source = await readFile(CURRENT_MISSION_FILE, 'utf8');
  assert.match(source, /navigate\(`\/missions\/\$\{encodeURIComponent\(mission\.mission_id\)\}`\)/);
  assert.match(source, /Open room/);
  assert.match(source, /Open Mission Room/);
});

test('Mission Room presentation remains reusable and exposes bounded timeline evidence', async () => {
  const content = await readFile(CONTENT_FILE, 'utf8');
  const timeline = await readFile(TIMELINE_FILE, 'utf8');
  assert.match(content, /MissionRoomContent/);
  assert.match(content, /No missing state has been inferred/);
  assert.match(timeline, /Deterministic workflow timeline/);
  assert.match(timeline, /Workspace evidence/);
  assert.match(timeline, /Provider-effect evidence/);
  assert.match(timeline, /No external success has been inferred/);
  assert.match(timeline, /review_decision/);
  assert.match(timeline, /retry_history/);
  assert.match(timeline, /Input SHA/);
  assert.match(timeline, /Output SHA/);
  assert.doesNotMatch(`${content}\n${timeline}`, /absolute_path|relative_path|payload_hash|provider_output/);
});
