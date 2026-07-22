import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemorySpaceCatalog, buildSkillCatalog } from '../src/services/agent-profile/catalogs.js';
function profile(id, skills = [], read = [], write = []) {
    return {
        schemaVersion: 2,
        id,
        displayName: id,
        profileVersion: '2.0.0',
        mission: 'test',
        personality: { communicationStyle: 'test', decisionPolicy: ['test'], constraints: ['test'] },
        runtime: { backend: 'opencode' },
        skills: skills.map((key) => ({ key, version: '1.0.0' })),
        memory: { read, write },
        repositories: ['LihSheng/ops-room'],
        enabled: true,
    };
}
test('legacy key catalog remains deterministic for backward compatibility', () => {
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
});
//# sourceMappingURL=agent-profile-catalogs.test.js.map