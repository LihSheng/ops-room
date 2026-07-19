import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubOps } from '../lib/github-ops.js';
import { getTokenForAgent } from '../lib/github-app.js';
import { REPO } from './runtime-paths.js';
import { redactSecrets } from './security-redaction.js';

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

const {
  addComment: rawAddComment,
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

function addComment(issueNumber, body, agentKey) {
  return rawAddComment(issueNumber, redactSecrets(body), agentKey);
}

export {
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
  githubToken,
};
