import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedTranscript,
  invokeBoundedAgentChat,
  systemPrompt,
} from '../src/services/agent-chat-provider.js';

const PROFILE = {
  id: 'professor',
  display_name: 'Professor',
  enabled: true,
  mission: 'Implement bounded changes under human control.',
  personality: {
    communication_style: 'Direct and evidence-oriented.',
    decision_policy: ['State uncertainty clearly.'],
    constraints: ['Do not claim unverified actions.'],
  },
  runtime: { backend: 'opencode' },
  repositories: ['LihSheng/private-repository-name'],
  memory: { read: ['secret-memory-space'], write: [] },
};

test('system prompt contains public profile policy and denies operational authority', () => {
  const prompt = systemPrompt(PROFILE);
  assert.match(prompt, /Implement bounded changes under human control/);
  assert.match(prompt, /Direct and evidence-oriented/);
  assert.match(prompt, /no repository, workspace, file, shell, Git, GitHub, skill, memory-body, web, or lifecycle authority/i);
  assert.match(prompt, /Never reveal private chain-of-thought/i);
  assert.doesNotMatch(prompt, /private-repository-name|secret-memory-space/);
});

test('transcript is bounded to recent supported messages', () => {
  const source = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
  }));
  source.push({ role: 'system', content: 'must be ignored' });
  const result = boundedTranscript(source);
  assert.equal(result.length, 19);
  assert.equal(result[0].content, 'message-11');
  assert.equal(result.at(-1)?.content, 'message-29');
  assert.equal(result.some((entry) => entry.content === 'must be ignored'), false);
});

test('provider request contains no tool contract and returns only bounded final text', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const result = await invokeBoundedAgentChat({
    agentId: 'professor',
    transcript: [{ role: 'user', content: 'What is the safe next step?' }],
    profileLookup: () => PROFILE,
    apiKey: 'test-key',
    model: 'test-model',
    fetchFn: async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Review the durable state before deciding.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.match(capturedUrl, /chat\/completions/);
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: 'What is the safe next step?' });
  assert.equal('tools' in body, false);
  assert.equal('tool_choice' in body, false);
  assert.doesNotMatch(JSON.stringify(body), /private-repository-name|secret-memory-space/);
  assert.equal(result.text, 'Review the durable state before deciding.');
  assert.equal(result.provider, 'opencode');
  assert.equal(result.model, 'test-model');
  assert.match(result.response_digest, /^[a-f0-9]{64}$/);
});

test('missing provider credential fails before an external request', async () => {
  let called = false;
  await assert.rejects(
    invokeBoundedAgentChat({
      agentId: 'professor',
      transcript: [],
      profileLookup: () => PROFILE,
      apiKey: '',
      fetchFn: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    }),
    /agent_chat_provider_unconfigured/,
  );
  assert.equal(called, false);
});

test('provider error bodies are not included in public failure codes', async () => {
  await assert.rejects(
    invokeBoundedAgentChat({
      agentId: 'professor',
      transcript: [],
      profileLookup: () => PROFILE,
      apiKey: 'test-key',
      fetchFn: async () => new Response('credential-like provider details', { status: 500 }),
    }),
    (error: any) => error.message === 'agent_chat_provider_failed',
  );
});
