import { AGENT_NAMES } from '../lib/config.mjs';
import { ghApi, ghApiText, addPullRequestReview } from '../services/github.mjs';
import { REPO, SHARED_MEMORY } from '../services/runtime-paths.mjs';
import { appendFile } from 'node:fs/promises';
import { buildPrReviewPrompt } from '../server/pr-review-payload.mjs';
import { askAI } from './chat-response.mjs';

function parseReviewEvent(reviewText) {
  const upper = String(reviewText || '').toUpperCase();
  if (upper.includes('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (upper.includes('APPROVE')) return 'APPROVE';
  return 'COMMENT';
}

async function appendToMemory(entry) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '');
    await appendFile(SHARED_MEMORY, `- ${ts}: [GitHub Issue] ${entry}\n`);
  } catch { }
}

async function fetchPrReviewContext({ repository, pr, agent }) {
  const prData = ghApi('GET', `repos/${repository}/pulls/${pr}`, agent);
  const diff = ghApiText(
    'GET',
    `repos/${repository}/pulls/${pr}`,
    agent,
    ['Accept: application/vnd.github.v3.diff']
  );

  return {
    repository,
    pr,
    prTitle: prData.title || '',
    prBody: prData.body || '',
    prAuthor: prData.user?.login || 'unknown',
    baseRef: prData.base?.ref || '',
    headRef: prData.head?.ref || '',
    headSha: prData.head?.sha || null,
    diff,
  };
}

export async function runPrReviewWorkflow(payload) {
  const {
    agent,
    task,
    repository,
    pr,
    mode,
    commenter = 'unknown',
  } = payload;

  const prContext = await fetchPrReviewContext({ repository, pr, agent });
  const prompt = buildPrReviewPrompt({
    agent: AGENT_NAMES[agent] || agent,
    task,
    repository,
    pr,
    mode,
    ...prContext,
  });

  const reviewText = (await askAI(prompt)).trim();
  if (!reviewText) {
    throw new Error(`PR review generation returned an empty response for ${repository}#${pr}`);
  }

  const event = parseReviewEvent(reviewText);
  addPullRequestReview(pr, reviewText, event, agent);

  await appendToMemory(`PR review from ${repository}#${pr} by @${commenter} → **${agent}**: ${task}`);
  console.log(`[pr-review] Posted ${event} review on ${repository}#${pr} as ${agent}`);

  return {
    mode: 'pr_review',
    repository,
    pr,
    agent,
    review_event: event,
  };
}
