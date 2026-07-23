import { createHash } from 'node:crypto';

import { getAgentProfile } from './agent-profile/registry.js';
import { OPENCODE_API, OPENCODE_MAX_TOKEN, OPENCODE_MODEL } from './runtime-paths.js';

const MAX_TRANSCRIPT_MESSAGES = 30;
const MAX_TRANSCRIPT_CHARACTERS = 40_000;
const MAX_RESPONSE_CHARACTERS = 12_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function bounded(value: unknown, maximum: number) {
  return String(value ?? '').trim().slice(0, maximum);
}

function participantProfile(participant: any, profileLookup = getAgentProfile) {
  const agentId = String(participant?.agent_id || '').trim();
  const profile = profileLookup(agentId);
  if (!profile || profile.id !== agentId) throw new Error('mission_chat_profile_missing');
  if (!profile.enabled) throw new Error('mission_chat_profile_disabled');
  if (profile.runtime?.backend !== 'opencode') throw new Error('mission_chat_backend_unsupported');
  return profile;
}

function missionParticipantSystemPrompt(mission: any, participant: any, profile: any) {
  const decisions = Array.isArray(profile.personality?.decision_policy)
    ? profile.personality.decision_policy.map((entry: unknown) => bounded(entry, 300)).filter(Boolean)
    : [];
  const constraints = Array.isArray(profile.personality?.constraints)
    ? profile.personality.constraints.map((entry: unknown) => bounded(entry, 300)).filter(Boolean)
    : [];
  const roles = Array.isArray(participant?.roles)
    ? participant.roles.map((entry: unknown) => bounded(entry, 80)).filter(Boolean)
    : [];
  const participants = Array.isArray(mission?.participants)
    ? mission.participants.map((entry: any) => `${bounded(entry.agent_id, 120)} (${Array.isArray(entry.roles) ? entry.roles.map((role: unknown) => bounded(role, 80)).join(', ') : ''})`)
    : [];
  return [
    `You are ${bounded(profile.display_name || profile.id, 120)}, agent ID ${bounded(profile.id, 120)}.`,
    `Your profile mission: ${bounded(profile.mission, 1_000)}`,
    `Communication style: ${bounded(profile.personality?.communication_style, 600)}`,
    decisions.length ? `Decision policies:\n- ${decisions.join('\n- ')}` : '',
    constraints.length ? `Constraints:\n- ${constraints.join('\n- ')}` : '',
    '',
    'This is a governed Mission participant chat in Ops Room.',
    `Mission title: ${bounded(mission?.title, 240)}`,
    `Mission objective: ${bounded(mission?.objective, 3_000)}`,
    `Mission state: ${bounded(mission?.state, 80)}`,
    `Your declared Mission roles: ${roles.join(', ') || 'participant'}`,
    participants.length ? `Declared participants: ${participants.join('; ')}` : '',
    '',
    'Return only a useful final response as the addressed participant. Never reveal private chain-of-thought or hidden reasoning.',
    'You have no repository, SHA, workspace, provider-effect, task, file, shell, Git, GitHub, skill, memory-body, web, lifecycle, release, or deployment authority in this chat.',
    'Do not claim to have inspected files, executed commands, changed state, contacted systems, completed a stage, approved work, or produced durable evidence.',
    'Discuss the bounded Mission objective, clarify responsibilities, explain likely approaches, identify questions, or summarize the visible conversation.',
    'Chat never replaces task records, Workflow transitions, workspace ownership, exact-SHA handoffs, Berlin decisions, approvals, or audit evidence.',
  ].filter(Boolean).join('\n');
}

function boundedMissionTranscript(transcript: any[]) {
  const normalized: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let remaining = MAX_TRANSCRIPT_CHARACTERS;
  for (const entry of transcript.slice(-MAX_TRANSCRIPT_MESSAGES).reverse()) {
    if (!entry || !['user', 'assistant'].includes(entry.role)) continue;
    const content = bounded(entry.content, Math.min(4_500, remaining));
    if (!content) continue;
    normalized.push({ role: entry.role, content });
    remaining -= content.length;
    if (remaining <= 0) break;
  }
  return normalized.reverse();
}

function responseText(payload: any) {
  const text = bounded(payload?.choices?.[0]?.message?.content, MAX_RESPONSE_CHARACTERS);
  if (!text) throw new Error('mission_chat_provider_empty_response');
  return text;
}

export async function invokeBoundedMissionParticipantChat({
  mission,
  participant,
  transcript,
  profileLookup = getAgentProfile,
  fetchFn = fetch,
  apiUrl = OPENCODE_API,
  apiKey = process.env.OPENCODE_API_KEY,
  model = OPENCODE_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: any) {
  const profile = participantProfile(participant, profileLookup);
  if (!apiKey) throw new Error('mission_chat_provider_unconfigured');
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort('mission_chat_provider_timeout'),
    Math.max(1_000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 300_000)),
  );
  timeout.unref?.();
  try {
    let response: Response;
    try {
      response = await fetchFn(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: missionParticipantSystemPrompt(mission, participant, profile) },
            ...boundedMissionTranscript(Array.isArray(transcript) ? transcript : []),
          ],
          max_tokens: Math.max(256, Math.min(Number(OPENCODE_MAX_TOKEN) || 4_096, 16_384)),
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new Error('mission_chat_provider_timeout');
      throw new Error('mission_chat_provider_unavailable');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('mission_chat_provider_auth_failed');
      if (response.status === 408 || response.status === 429) throw new Error('mission_chat_provider_retry_later');
      throw new Error('mission_chat_provider_failed');
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error('mission_chat_provider_response_invalid');
    }
    const text = responseText(payload);
    return {
      text,
      provider: 'opencode',
      model: bounded(model, 120),
      response_digest: createHash('sha256').update(text).digest('hex'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export { boundedMissionTranscript, missionParticipantSystemPrompt, participantProfile };
