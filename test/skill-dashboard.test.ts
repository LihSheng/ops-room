import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const skillsPage = fileURLToPath(new URL('../dashboard/src/pages/SkillsPage.tsx', import.meta.url));
const agentDetail = fileURLToPath(new URL('../dashboard/src/pages/AgentDetailPage.tsx', import.meta.url));
const skillsApi = fileURLToPath(new URL('../dashboard/src/api/skills.ts', import.meta.url));

async function source(path: string) {
  return readFile(path, 'utf8');
}

test('skills page renders version, description, agents, runtimes, requirements, and compatibility', async () => {
  const value = await source(skillsPage);
  for (const phrase of ['Skill version', 'Description', 'Declared by', 'Runtimes', 'Requirements', 'Compatibility', 'View details']) {
    assert.ok(value.includes(phrase), `missing UI phrase: ${phrase}`);
  }
  assert.ok(value.includes('Empty skill registry'));
  assert.ok(value.includes('Skill registry unavailable'));
  assert.ok(value.includes('Unknown skill version'));
});

test('agent detail renders exact version, resolution, compatibility, reasons, and safe requirements', async () => {
  const value = await source(agentDetail);
  for (const phrase of ['Immutable version', 'resolution_status', 'compatibility', 'Required commands', 'Credential references', 'installed or executable']) {
    assert.ok(value.includes(phrase), `missing agent skill state: ${phrase}`);
  }
});

test('dashboard skill API supports list and immutable detail without mutation methods', async () => {
  const value = await source(skillsApi);
  assert.ok(value.includes("list: ()"));
  assert.ok(value.includes("detail: async"));
  assert.equal(/\b(create|update|delete|install|execute|materialize|activate)\s*:/.test(value), false);
});

test('skill views contain no mutation control labels', async () => {
  const value = `${await source(skillsPage)}\n${await source(agentDetail)}`;
  assert.equal(/>\s*(Install|Execute|Materialize|Activate|Retry)\s*</.test(value), false);
});
