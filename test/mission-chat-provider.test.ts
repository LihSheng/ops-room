import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedMissionTranscript,
  invokeBoundedMissionParticipantChat,
  missionParticipantSystemPrompt,
} from '../src/services/mission-chat-provider.js';

const PROFILE = {
  id: 'tokyo',
  display_name: 'Tokyo',
  enabled: true,
  mission: 'Verify implementation evidence.',
  personality: {
    communication_style: 'Precise and test-oriented.',
    decision_policy: ['State verification gaps.'],
    constraints: ['Do not claim tests were executed.'],
  },
  runtime: { backend: 'opencode' },
  repositories: ['LihSheng/private-repository-name'],
  memory: { read: ['secret-memory-space'], write: [] },
};

const MISSION = {
  mission_id: 'mission:test:provider',
  title: 'Mission chat provider test',
  objective: 'Discuss a bounded verification strategy.',
  state: 'active',
  repository_id: 'private/repository',
  starting_sha: 'a'.repeat(40),
  supporting_context: 'private supporting context',
  participants: [
    { agent_id: 'professor', roles: ['implementation'] },
    { agent_id: 'tokyo', roles: ['test'] },
    { agent_id: 'berlin', roles: ['review'] },
  ],
};

const PARTICIPANT = { agent_id: 'tokyo', roles: ['test'] };

test('Mission participant prompt includes bounded public context and denies authority', () => {
  const prompt = missionParticipantSystemPrompt(MISSION, PARTICIPANT, PROFILE);
  assert.match(prompt, /Mission chat provider test/);
  assert.match(prompt, /Discuss a bounded verification strategy/);
  assert.match(prompt, /Your declared Mission roles: test/);
  assert.match(prompt, /professor \(implementation\).*tokyo \(test\).*berlin \(review\)/);
  assert.match(prompt, /no repository, SHA, workspace, provider-effect, task, file, shell, Git, GitHub/i);
  assert.match(prompt, /Never reveal private chain-of-thought/i);
  assert.doesNotMatch(prompt, /private\/repository|private supporting context|private-repository-name|secret-memory-space/);
  assert.doesNotMatch(prompt, new RegExp('a'.repeat(40)));
});

test('Mission transcript keeps recent supported messages only', () => {
  const source = Array.from({ length: 35 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
  }));
  source.push({ role: 'system', content: 'must be ignored' });
  const result = boundedMissionTranscript(source);
  assert.equal(result.length, 29);
  assert.equal(result[0].content, 'message-6');
  assert.equal(result.at(-1)?.content, 'message-34');
  assert.equal(result.some((entry) => entry.content === 'must be ignored'), false);
});

test('provider request contains no tools or sensitive Mission authority', async () => {
  let capturedInit: RequestInit | undefined;
  const result = await invokeBoundedMissionParticipantChat({
    mission: MISSION,
    participant: PARTICIPANT,
    transcript: [{ role: 'user', content: '[Human Operator] To tokyo: What should be verified?' }],
    profileLookup: () => PROFILE,
    apiKey: 'test-key',
    model: 'test-model',
    fetchFn: async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Verify the bounded acceptance criteria.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: '[Human Operator] To tokyo: What should be verified?' });
  assert.equal('tools' in body, false);
  assert.equal('tool_choice' in body, false);
  assert.doesNotMatch(JSON.stringify(body), /private\/repository|private supporting context|private-repository-name|secret-memory-space/);
  assert.doesNotMatch(JSON.stringify(body), new RegExp('a'.repeat(40)));
  assert.equal(result.text, 'Verify the bounded acceptance criteria.');
  assert.equal(result.provider, 'opencode');
  assert.equal(result.model, 'test-model');
  assert.match(result.response_digest, /^[a-f0-9]{64}$/);
});

test('disabled participant fails before an external request', async () => {
  let called = false;
  await assert.rejects(
    invokeBoundedMissionParticipantChat({
      mission: MISSION,
      participant: PARTICIPANT,
      transcript: [],
      profileLookup: () => ({ ...PROFILE, enabled: false }),
      apiKey: 'test-key',
      fetchFn: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    }),
    /mission_chat_profile_disabled/,
  );
  assert.equal(called, false);
});

test('raw provider error bodies are not surfaced', async () => {
  await assert.rejects(
    invokeBoundedMissionParticipantChat({
      mission: MISSION,
      participant: PARTICIPANT,
      transcript: [],
      profileLookup: () => PROFILE,
      apiKey: 'test-key',
      fetchFn: async () => new Response('credential-like provider details', { status: 500 }),
    }),
    (error: any) => error.message === 'mission_chat_provider_failed',
  );
});
