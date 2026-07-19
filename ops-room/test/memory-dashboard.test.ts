import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const memoryPage = fileURLToPath(new URL('../dashboard/src/pages/MemorySpacesPage.tsx', import.meta.url));
const agentDetail = fileURLToPath(new URL('../dashboard/src/pages/AgentDetailPage.tsx', import.meta.url));
const memoryApi = fileURLToPath(new URL('../dashboard/src/api/memory-spaces.ts', import.meta.url));

async function source(path: string) {
  return readFile(path, 'utf8');
}

test('memory page renders registry identity, publication policy, provenance, and assignments', async () => {
  const value = await source(memoryPage);
  for (const phrase of ['Governed memory-space registry', 'Publication path', 'Governance', 'Readers', 'Writers', 'Policy registry, not a memory service']) {
    assert.ok(value.includes(phrase), `missing memory governance UI phrase: ${phrase}`);
  }
  assert.ok(value.includes('No approved memory spaces'));
  assert.ok(value.includes('Memory registry unavailable'));
});

test('agent detail renders resolved memory versions and future review requirements', async () => {
  const value = await source(agentDetail);
  for (const phrase of ['memory_assignments', 'write_policy', 'publication_path', 'Future writes require review and provenance', 'Validated governance only']) {
    assert.ok(value.includes(phrase), `missing agent memory state: ${phrase}`);
  }
});

test('dashboard memory API supports list and detail without mutation methods', async () => {
  const value = await source(memoryApi);
  assert.ok(value.includes('list: ()'));
  assert.ok(value.includes('detail: (key'));
  assert.equal(/\b(create|update|delete|write|publish|sync|search)\s*:/.test(value), false);
});

test('memory views contain no vault mutation control labels', async () => {
  const value = `${await source(memoryPage)}\n${await source(agentDetail)}`;
  assert.equal(/>\s*(Write|Publish|Sync|Create Note|Search Vault|Delete)\s*</.test(value), false);
});
