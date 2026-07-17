import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubOps } from '../lib/github-ops.js';
import { getTokenForAgent } from '../lib/github-app.js';
import { REPO } from './runtime-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function githubToken(agentKey) {
  return getTokenForAgent(agentKey, join(__dirname, '..', 'server', 'github-app-token.js'));
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
