import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemorySpaceCatalog, buildSkillCatalog } from '../src/services/agent-profile/catalogs.js';
import type { AgentProfile } from '../src/services/agent-profile/schema.js';

function profile(id: string, skills: string[] = [], read: string[] = [], write: string[] = []): AgentProfile {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    profileVersion: '1.0.0',
    mission: 'test',
    personality: { communicationStyle: 'test', decisionPolicy: ['test'], constraints: ['test'] },
    runtime: { backend: 'opencode' },
    skills,
    memory: { read, write },
    repositories: ['LihSheng/ops-room'],
    enabled: true,
  };
}

test('skill catalog deduplicates and sorts skills and agents', () => {
  assert.deepEqual(buildSkillCatalog([
    profile('tokyo', ['verification', 'shared']),
    profile('berlin', ['shared', 'review']),
  ]), [
    { key: 'review', agents: ['berlin'] },
    { key: 'shared', agents: ['berlin', 'tokyo'] },
    { key: 'verification', agents: ['tokyo'] },
  ]);
  assert.deepEqual(buildSkillCatalog([]), []);
});

test('memory catalog merges read and write usage without filesystem access', () => {
  assert.deepEqual(buildMemorySpaceCatalog([
    profile('professor', [], ['Projects/Ops-Room'], ['Projects/Ops-Room']),
    profile('berlin', [], ['Projects/Ops-Room', 'Projects/Review'], []),
    profile('berlin', [], ['Projects/Ops-Room'], []),
  ]), [
    { key: 'Projects/Ops-Room', readers: ['berlin', 'professor'], writers: ['professor'] },
    { key: 'Projects/Review', readers: ['berlin'], writers: [] },
  ]);
  assert.deepEqual(buildMemorySpaceCatalog([]), []);
});
