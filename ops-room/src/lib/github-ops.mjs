import { execSync, execFileSync } from 'node:child_process';

export function createGitHubOps({ repo, tokenForAgent, processEnv = process.env, logger = console }) {
  function withAgentFallback(agentKey, work, actionLabel) {
    try {
      return work(agentKey);
    } catch (error) {
      const msg = (error.stderr && error.stderr.toString()) || error.message;
      if (agentKey !== 'professor' && (msg.includes('403') || msg.includes('Resource not accessible'))) {
        logger.warn(`[poller] ${agentKey} token lacks ${actionLabel} permission, falling back to professor`);
        return work('professor');
      }
      throw error;
    }
  }

  function addComment(issueNumber, body, agentKey = 'professor') {
    const tryPost = (key) => {
      const token = tokenForAgent(key);
      return execFileSync(
        'gh',
        ['api', `repos/${repo}/issues/${issueNumber}/comments`, '-X', 'POST', '-f', `body=${body}`],
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, env: { ...processEnv, GH_TOKEN: token } },
      );
    };

    try {
      withAgentFallback(agentKey, tryPost, 'comment');
    } catch (error) {
      const msg = (error.stderr && error.stderr.toString()) || error.message;
      logger.error(`[poller] addComment error on #${issueNumber}:`, msg);
    }
  }

  function ghApi(method, path, agentKey = 'professor') {
    const token = tokenForAgent(agentKey);
    const args = ['api', path];
    if (method !== 'GET') args.push('-X', method);
    const out = execFileSync('gh', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...processEnv, GH_TOKEN: token },
    });
    return JSON.parse(out);
  }

  function ghApiText(method, path, agentKey = 'professor', headers = []) {
    return withAgentFallback(agentKey, (key) => {
      const token = tokenForAgent(key);
      const args = ['api'];
      for (const header of headers) {
        args.push('-H', header);
      }
      args.push(path);
      if (method !== 'GET') args.push('-X', method);
      return execFileSync('gh', args, {
        encoding: 'utf-8',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...processEnv, GH_TOKEN: token },
      });
    }, 'API');
  }

  function addPullRequestReview(prNumber, body, event = 'COMMENT', agentKey = 'professor') {
    return withAgentFallback(agentKey, (key) => {
      const token = tokenForAgent(key);
      return execFileSync(
        'gh',
        [
          'api',
          `repos/${repo}/pulls/${prNumber}/reviews`,
          '-X',
          'POST',
          '-f',
          `body=${body}`,
          '-f',
          `event=${event}`,
        ],
        {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          env: { ...processEnv, GH_TOKEN: token },
        },
      );
    }, 'pull request review');
  }

  function ghExec(args, opts = {}) {
    return execSync(`gh ${args} --repo "${repo}"`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    }).trim();
  }

  function ensureLabel(label, color = 'fbca04') {
    try {
      execSync(
        `gh label create ${JSON.stringify(label)} --repo ${JSON.stringify(repo)} --color ${JSON.stringify(color)} --force`,
        { encoding: 'utf-8', stdio: 'pipe' },
      );
    } catch (error) {
      const msg = error.stderr?.toString() || error.message;
      logger.warn(`[poller] ensureLabel warning for ${label}: ${msg.slice(0, 300)}`);
    }
  }

  function removeLabel(issueNumber, label) {
    try {
      execSync(`gh issue edit ${issueNumber} --remove-label "${label}" --repo "${repo}"`, { encoding: 'utf-8' });
    } catch {}
  }

  function addLabel(issueNumber, label) {
    try {
      execSync(`gh issue edit ${issueNumber} --add-label "${label}" --repo "${repo}"`, { encoding: 'utf-8' });
    } catch {}
  }

  async function transitionLabels(ctx, { remove: removeLabels, add: addLabels }) {
    for (const label of removeLabels) removeLabel(ctx.issueNumber, label);
    for (const label of addLabels) ensureLabel(label);
    for (const label of addLabels) addLabel(ctx.issueNumber, label);
  }

  return {
    addComment,
    addPullRequestReview,
    ghApi,
    ghApiText,
    ghExec,
    ensureLabel,
    removeLabel,
    addLabel,
    transitionLabels,
  };
}
