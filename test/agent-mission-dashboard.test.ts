import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const API_FILE = new URL('../dashboard/src/api/agent-fleet.ts', import.meta.url);
const EVIDENCE_FILE = new URL('../dashboard/src/components/CurrentMissionEvidence.tsx', import.meta.url);
const SUMMARY_FILE = new URL('../dashboard/src/components/AgentOperationalSummary.tsx', import.meta.url);
const FLEET_FILE = new URL('../dashboard/src/pages/AgentFleetPage.tsx', import.meta.url);

test('fleet API types mission and workflow evidence separately from task/runtime state', async () => {
  const source = await readFile(API_FILE, 'utf8');
  assert.match(source, /export interface AgentFleetMission/);
  assert.match(source, /current_agent_is_stage_owner: boolean/);
  assert.match(source, /evidence_status:/);
  assert.match(source, /additional_mission_count: number/);
  assert.match(source, /current_mission: AgentFleetMission \| null/);
  assert.match(source, /workflows: AgentEvidenceSourceState/);
});

test('shared mission presentation identifies stage ownership and degraded evidence', async () => {
  const source = await readFile(EVIDENCE_FILE, 'utf8');
  assert.match(source, /Current stage owner/);
  assert.match(source, /Mission and workflow remain separate authorities/);
  assert.match(source, /No missing state has been inferred/);
  assert.match(source, /additional_mission_count/);
  assert.doesNotMatch(source, /objective/);
  assert.doesNotMatch(source, /history/);
});

test('Agent Fleet and Agent Detail use the same normalized mission component', async () => {
  const fleet = await readFile(FLEET_FILE, 'utf8');
  const summary = await readFile(SUMMARY_FILE, 'utf8');

  assert.match(fleet, /<CurrentMissionEvidence mission=\{agent\.current_mission\} compact \/>/);
  assert.match(fleet, /agent\.current_mission\?\.attention_required/);
  assert.match(fleet, /Name, role, mission, repository, or task/);
  assert.match(summary, /<CurrentMissionEvidence mission=\{fleet\.current_mission\} \/>/);
  assert.match(summary, /mission, workflow, runtime, lifecycle, and current-work evidence/);
});
