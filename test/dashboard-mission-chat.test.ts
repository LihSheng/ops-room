import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOM_FILE = new URL('../dashboard/src/components/MissionRoomContent.tsx', import.meta.url);
const PANEL_FILE = new URL('../dashboard/src/components/MissionParticipantChatPanel.tsx', import.meta.url);
const API_FILE = new URL('../dashboard/src/api/mission-chat.ts', import.meta.url);

test('Mission Room hosts a first-class participant chat panel', async () => {
  const room = await readFile(ROOM_FILE, 'utf-8');
  assert.match(room, /import \{ MissionParticipantChatPanel \}/);
  assert.match(room, /<MissionParticipantChatPanel room=\{room\} \/>/);
  assert.match(room, /<WorkflowControlPanel room=\{room\} \/>/);
  assert.match(room, /<InvestigationControlPanel room=\{room\} \/>/);
});

test('participant chat UI preserves Mission and role boundaries', async () => {
  const panel = await readFile(PANEL_FILE, 'utf-8');
  assert.match(panel, /roles\.includes\('operator'\) \|\| roles\.includes\('administrator'\)/);
  assert.match(panel, /agent\.chat/);
  assert.match(panel, /Mission context, not Mission authority/);
  assert.match(panel, /cannot change tasks, Workflow stages, workspaces, SHAs, provider effects/);
  assert.match(panel, /Only enabled agents declared in this Mission are available/);
  assert.match(panel, /preferredParticipant/);
  assert.match(panel, /targetAgentId/);
  assert.match(panel, /The same participant, message, and request identity are retained/);
  assert.match(panel, /The interrupted or failed turn was not replayed automatically/);
  assert.match(panel, /Terminal Mission transcript/);
  assert.match(panel, /\['mission-participant-chat', missionId\]/);
  assert.match(panel, /\['mission-room', missionId\]/);
  assert.match(panel, /\['interventions'\]/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|localStorage|sessionStorage/);
});

test('disabled Mission participants are visible and unavailable for new turns', async () => {
  const panel = await readFile(PANEL_FILE, 'utf-8');
  assert.match(panel, /useAgentFleet/);
  assert.match(panel, /knownDisabledParticipants/);
  assert.match(panel, /agent\.profile\.available && !agent\.profile\.enabled/);
  assert.match(panel, /disabled,/);
  assert.match(panel, /Disabled participants are read only/);
  assert.match(panel, /Selected participant is disabled/);
  assert.match(panel, /targetKnownDisabled/);
});

test('typed client binds encoded Mission routes, target participant, CSRF, and idempotency', async () => {
  const api = await readFile(API_FILE, 'utf-8');
  assert.match(api, /\/api\/operator\/missions\/\$\{encodeURIComponent\(missionId\)\}\/participant-chat/);
  assert.match(api, /\/api\/operator\/mission-chat-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/messages/);
  assert.match(api, /\/api\/operator\/mission-chat-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/close/);
  assert.match(api, /target_agent_id: targetAgentId/);
  assert.match(api, /'X-Ops-Room-CSRF': csrfToken/);
  assert.match(api, /idempotency_key: idempotencyKey/);
  assert.match(api, /credentials: 'same-origin'/);
  assert.match(api, /browser-mission-chat:/);
});

test('Mission chat browser source excludes server-owned sensitive evidence', async () => {
  const source = `${await readFile(PANEL_FILE, 'utf-8')}\n${await readFile(API_FILE, 'utf-8')}`;
  assert.doesNotMatch(source, /absolute_path|authenticated remote|payload_hash|response_digest|environment value|raw provider/i);
});
