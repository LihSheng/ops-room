import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const API_FILE = new URL('../dashboard/src/api/missions.ts', import.meta.url);
const ACTIVITY_FILE = new URL('../dashboard/src/components/MissionActivityPanel.tsx', import.meta.url);
const CONTENT_FILE = new URL('../dashboard/src/components/MissionRoomContent.tsx', import.meta.url);
const TIMELINE_FILE = new URL('../dashboard/src/components/MissionRoomTimeline.tsx', import.meta.url);

test('Mission activity API type remains bounded and internally cross-linked', async () => {
  const source = await readFile(API_FILE, 'utf8');
  assert.match(source, /export interface MissionActivityEvent/);
  assert.match(source, /category: MissionActivityCategory/);
  assert.match(source, /severity: MissionActivitySeverity/);
  assert.match(source, /stage: string \| null/);
  assert.match(source, /agent: string \| null/);
  assert.match(source, /activity_summary/);
  assert.doesNotMatch(source, /absolute_path|relative_path|payload_hash|provider_output|private_reasoning/);
});

test('Mission Room exposes filterable correlated activity and durable evidence links', async () => {
  const source = await readFile(ACTIVITY_FILE, 'utf8');
  assert.match(source, /Mission activity/);
  assert.match(source, /Durable evidence only/);
  assert.match(source, /duplicate history representations are collapsed deterministically/);
  assert.match(source, /Attention/);
  assert.match(source, /Reviews/);
  assert.match(source, /Effects/);
  assert.match(source, /Workspaces/);
  assert.match(source, /Stage evidence/);
  assert.match(source, /Workflow summary/);
  assert.match(source, /event\.links\.agent/);
  assert.doesNotMatch(source, /raw provider output|unrestricted logs|absolute path/i);
});

test('Mission Room summary and timeline support activity cross-links on durable URLs', async () => {
  const content = await readFile(CONTENT_FILE, 'utf8');
  const timeline = await readFile(TIMELINE_FILE, 'utf8');
  assert.match(content, /id="workflow-summary"/);
  assert.match(content, /<MissionActivityPanel room=\{room\} \/>/);
  assert.match(content, /Activity events/);
  assert.match(timeline, /stageKeyFromHash/);
  assert.match(timeline, /#stage-/);
  assert.match(timeline, /id=\{stageAnchor\(stage\)\}/);
  assert.match(timeline, /scrollIntoView/);
});
