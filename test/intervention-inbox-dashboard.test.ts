import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const APP_FILE = new URL('../dashboard/src/App.tsx', import.meta.url);
const API_FILE = new URL('../dashboard/src/api/interventions.ts', import.meta.url);
const PAGE_FILE = new URL('../dashboard/src/pages/InterventionsPage.tsx', import.meta.url);
const WORKFLOW_DESK_FILE = new URL('../dashboard/src/components/WorkflowControlDesk.tsx', import.meta.url);
const WORKFLOW_PANEL_FILE = new URL('../dashboard/src/components/WorkflowControlPanel.tsx', import.meta.url);

 test('Needs Human is a first-class dashboard route and refresh authority', async () => {
  const source = await readFile(APP_FILE, 'utf8');
  assert.match(source, /label: 'Needs Human', path: '\/interventions'/);
  assert.match(source, /<Route path="\/interventions" element=\{<InterventionsPage \/>\} \/>/);
  assert.match(source, /\['interventions'\]/);
  assert.match(source, /navigate\('\/interventions'\)/);
});

test('intervention read model composes accepted authenticated read contracts', async () => {
  const source = await readFile(API_FILE, 'utf8');
  assert.match(source, /missionsApi\.listMissions\(\)/);
  assert.match(source, /missionsApi\.getMission\(mission\.mission_id\)/);
  assert.match(source, /\/api\/review-tasks\?limit=100/);
  assert.match(source, /\/effects\?state=CLAIMED/);
  assert.match(source, /agentFleetApi\.list\(\)/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /sources\.mission_rooms = roomFailures === missions\.length \? 'unavailable' : 'degraded'/);
  assert.doesNotMatch(source, /method:\s*['"]POST['"]|method:\s*['"]DELETE['"]|method:\s*['"]PUT['"]|method:\s*['"]PATCH['"]/);
});

test('intervention items explain effect uncertainty, retry safety, block reason, recommendation, and evidence', async () => {
  const source = await readFile(API_FILE, 'utf8');
  assert.match(source, /external_effect:/);
  assert.match(source, /may_have_occurred/);
  assert.match(source, /retry:/);
  assert.match(source, /blocked_reason/);
  assert.match(source, /recommended_response/);
  assert.match(source, /evidence:/);
  assert.match(source, /Uncertain external effects must not be replayed automatically/);
  assert.match(source, /Retry safety cannot be established/);
});

test('intervention ordering and deduplication are deterministic', async () => {
  const source = await readFile(API_FILE, 'utf8');
  assert.match(source, /const byId = new Map<string, InterventionItem>\(\)/);
  assert.match(source, /severityRank\[right\.severity\] - severityRank\[left\.severity\]/);
  assert.match(source, /timestamp\(right\.occurred_at\) - timestamp\(left\.occurred_at\)/);
  assert.match(source, /left\.intervention_id\.localeCompare\(right\.intervention_id\)/);
});

test('Needs Human preserves explanations and hosts governed task and workflow controls', async () => {
  const [page, desk, panel] = await Promise.all([
    readFile(PAGE_FILE, 'utf8'),
    readFile(WORKFLOW_DESK_FILE, 'utf8'),
    readFile(WORKFLOW_PANEL_FILE, 'utf8'),
  ]);
  assert.match(page, /Governed task and workflow controls/);
  assert.match(page, /<TaskControlDesk \/>/);
  assert.match(page, /<WorkflowControlDesk \/>/);
  assert.match(page, /Could an external effect have occurred\?/);
  assert.match(page, /Retry assessment/);
  assert.match(page, /Why action is blocked/);
  assert.match(page, /Recommended operator response/);
  assert.match(page, /Effect resolution, workspace cleanup controls, provider invocation, and uncertain-effect replay remain unavailable/);
  assert.match(desk, /Select a Mission with active or needs-human workflow evidence/);
  assert.match(panel, /Server remains authoritative/);
  assert.match(panel, /same request key is retained/i);
  assert.match(panel, /\['mission-room', room\.mission\.mission_id\]/);
  assert.match(panel, /\['interventions'\]/);
  assert.doesNotMatch(`${page}\n${desk}\n${panel}`, /absolute_path|relative_path|payload_hash|provider_output|environment|credential|private reasoning/i);
});
