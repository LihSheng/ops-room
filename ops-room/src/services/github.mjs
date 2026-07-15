import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubOps } from '../lib/github-ops.mjs';
import { getTokenForAgent } from '../lib/github-app.mjs';
import { REPO } from './runtime-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function githubToken(agentKey) {
  return getTokenForAgent(agentKey, join(__dirname, '..', 'server', 'github-app-token.mjs'));
}

const ops = createGitHubOps({
  repo: REPO,
  tokenForAgent: githubToken,
  processEnv: process.env,
  logger: console,
});

export const {
  addComment,
  addPullRequestReview,
  listIssueCommentReactions,
  addIssueCommentReaction,
  removeIssueCommentReaction,
  ghApi,
  ghApiText,
  getCommitStatuses,
  createCommitStatus,
  ensureLabel,
  removeLabel,
  addLabel,
  transitionLabels,
} = ops;

export { githubToken };
