---
name: github-operations
description: GitHub issue operations for OpenAB multi-agent system — posting comments, managing labels, using agent-specific GitHub App tokens, and calling the opencode-zen AI API from the poller
license: MIT
---

## Overview

The OpenAB system uses GitHub issues for task dispatch. The current implementation lives in the repo-local `ops-room/` package. `ops-room/src/server/webhook.js` starts the HTTP server and an in-process poll loop; `ops-room/src/server/poller.js` is the standalone poller entrypoint and now reuses the same shared poll-loop helpers.

### Flow

1. User comments `/openab <agent> <task>` on a GitHub issue
2. GitHub Action adds `openab/<agent>` label and posts a metadata comment (`<!-- openab-task ... -->`)
3. Poller (every 30s) runs `gh issue list --label openab/<agent>`
4. Claim: remove `openab/<agent>`, add `openab/<agent>/wip`
5. Post acknowledgment as the agent's bot user
6. Read issue context via `gh api repos/LihSheng/LinkUp/issues/<N>`
7. Extract the user's command from the `<!-- openab-task -->` comment
8. Call opencode-zen API to generate a response
9. Post the answer, transition labels to `openab/done`

### Key files

- `ops-room/src/server/webhook.js` — webhook server + in-process poller + coding/chat task workflows
- `ops-room/src/server/poller.js` — standalone poller entrypoint using the shared poll loop
- `ops-room/src/server/claim.js` — manual claim/list CLI
- `ops-room/src/server/github-app-token.js` — generates GitHub App installation tokens
- `ops-room/src/lib/config.js` — shared agent and label configuration
- `ops-room/src/lib/task-routing.js` — shared task parsing and routing helpers
- `ops-room/src/lib/github-app.js` — shared GitHub App token helper
- `ops-room/src/lib/github-ops.js` — shared comment/label/API helpers
- `ops-room/src/lib/issue-poller.js` — shared poll loop used by both server entrypoints

## GitHub App authentication

Three GitHub Apps provide per-agent bot identities:

| Agent | App ID | Bot user | Key path (in professor container) |
|-------|--------|----------|-----------------------------------|
| Professor | 4128776 | `lihsheng-professor[bot]` | `/home/node/.ssh/github-app-key.pem` |
| Berlin | 4131786 | `lihsheng-berlin[bot]` | `/home/node/.ssh/berlin-key.pem` |
| Tokyo | 4131816 | `lihsheng-tokyo[bot]` | `/home/node/.ssh/tokyo-key.pem` |

Env vars used by `githubEnvForAgent()` in `ops-room/src/lib/github-app.js`:

```javascript
const GITHUB_APP_CONFIG = {
  professor: { appId: 'GITHUB_APP_ID', installationId: 'GITHUB_APP_INSTALLATION_ID', keyPath: 'GITHUB_APP_KEY_PATH', botUser: 'GITHUB_APP_BOT_USER' },
  berlin:    { appId: 'GITHUB_APP_ID_BERLIN', installationId: 'GITHUB_APP_INSTALLATION_ID_BERLIN', keyPath: 'GITHUB_APP_KEY_PATH_BERLIN', botUser: 'GITHUB_APP_BOT_USER_BERLIN' },
  tokyo:     { appId: 'GITHUB_APP_ID_TOKYO', installationId: 'GITHUB_APP_INSTALLATION_ID_TOKYO', keyPath: 'GITHUB_APP_KEY_PATH_TOKYO', botUser: 'GITHUB_APP_BOT_USER_TOKYO' },
};
```

### Token generation

Use `node ops-room/src/server/github-app-token.js` with the right env vars:

```javascript
const tokenResult = execFileSync('node', ['ops-room/src/server/github-app-token.js'], {
  encoding: 'utf-8',
  env: { ...process.env, ...githubEnvForAgent('tokyo') },
}).trim();
const token = JSON.parse(tokenResult).token;
```

The script creates a JWT signed with the app's private key, exchanges it for an installation access token via `POST /app/installations/{id}/access_tokens`.

### Permission fallback (Berlin)

Berlin's GitHub App (`lihsheng-berlin`) **lacks `issues: write` permission**. Posting comments with Berlin's token returns:

```
gh: Resource not accessible by integration (HTTP 403)
```

The `addComment` function in `server.js` handles this by falling back to the professor token:

```javascript
function addComment(issueNumber, body, agentKey = 'professor') {
  const tryPost = (key) => { /* ... generates token, posts comment ... */ };
  try {
    tryPost(agentKey);
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || e.message;
    if (agentKey !== 'professor' && (msg.includes('403') || msg.includes('Resource not accessible'))) {
      console.warn(`[poller] ${agentKey} token lacks comment permission, falling back to professor`);
      tryPost('professor'); // comment appears as lihsheng-professor[bot]
    }
  }
}
```

**Permanent fix**: Go to GitHub → Settings → Developer Settings → GitHub Apps → `lihsheng-berlin` → Permissions → Issues → **Read & Write** → Save.

To verify permissions, use the installation token to check accessible repos:

```bash
GITHUB_APP_ID=4131786 GITHUB_APP_INSTALLATION_ID=142302463 GITHUB_APP_KEY_PATH=/home/node/.ssh/berlin-key.pem \
  node /scripts/github-app-token.js | jq -r '.token' | xargs -I{} \
  curl -H "Authorization: Bearer {}" https://api.github.com/installation/repositories
```

## Reading issue context

Use `gh api` with the professor token (has full access):

```javascript
function ghApi(method, path) {
  const tokenResult = execFileSync('node', ['/scripts/github-app-token.js'], {
    encoding: 'utf-8',
    env: { ...process.env, ...githubEnvForAgent('professor') },
  }).trim();
  const token = JSON.parse(tokenResult).token;
  const args = ['api', path];
  if (method !== 'GET') args.push('-X', method);
  const out = execFileSync('gh', args, { encoding: 'utf-8', env: { GH_TOKEN: token } });
  return JSON.parse(out);
}
```

### Common API calls

```javascript
// Get issue details
const issue = ghApi('GET', `repos/LihSheng/LinkUp/issues/${number}`);

// Get issue comments
const comments = ghApi('GET', `repos/LihSheng/LinkUp/issues/${number}/comments`);

// Post comment (via addComment helper — handles auth + fallback)
addComment(number, body, 'tokyo');
```

## Posting comments

Use the `addComment` helper — it handles token generation, GH_TOKEN env override, and permission fallback:

```javascript
addComment(issueNumber, body, agentKey);
// agentKey: 'professor', 'berlin', or 'tokyo'
// body: Markdown string
```

The comment is posted as the agent's bot user. For Berlin, it falls back to `lihsheng-professor[bot]`.

## Managing labels

Labels drive the task lifecycle:

| Label | Stage |
|-------|-------|
| `openab/<agent>` | Pending |
| `openab/<agent>/wip` | In progress |
| `openab/done` | Completed |

Use `gh issue edit` with the globally-authenticated `gh` CLI (uses professor's token from `entrypoint.sh`):

```javascript
execSync(`gh issue edit ${number} --remove-label openab/tokyo --repo LihSheng/LinkUp`);
execSync(`gh issue edit ${number} --add-label openab/tokyo/wip --repo LihSheng/LinkUp`);
execSync(`gh issue edit ${number} --add-label openab/done --repo LihSheng/LinkUp`);
```

## Calling the opencode-zen AI API

The AI API endpoint is `https://opencode.ai/zen/v1/chat/completions`, discovered from `~/.cache/opencode/models.json`:

```javascript
const OPENCODE_API = 'https://opencode.ai/zen/v1/chat/completions';

async function askAI(prompt) {
  const res = await fetch(OPENCODE_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENCODE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash-free',  // or 'deepseek-v4-pro' for Berlin
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}
```

The prompt should include the issue context (number, creator, title, body, question) so the AI can answer without needing GitHub API access.

## Extracting the user's command

The GitHub Action posts a metadata comment with the task details:

```
<!-- openab-task
agent: tokyo
task: who opened this issue?
repository: LihSheng/LinkUp
issue: 15
commenter: LihSheng
-->
```

Parse it with:

```javascript
function extractTask(comments) {
  const ack = comments.find(c => c.body?.includes('<!-- openab-task'));
  if (!ack) return null;
  const taskMatch = ack.body.match(/task:\s*(.+?)(?:\n|$)/);
  const commenterMatch = ack.body.match(/commenter:\s*(\S+)/);
  return { task: taskMatch?.[1]?.trim() || '', commenter: commenterMatch?.[1] || 'unknown' };
}
```

## Auto-responder pattern

The poller's `autoRespond` orchestrates the full flow:

```javascript
async function autoRespond(issueNumber, agentKey) {
  const issue = ghApi('GET', `repos/LihSheng/LinkUp/issues/${issueNumber}`);
  const comments = ghApi('GET', `repos/LihSheng/LinkUp/issues/${issueNumber}/comments`);
  const task = extractTask(comments);
  const prompt = `Issue #${issueNumber} by @${issue.user?.login}\nTitle: ${issue.title}\nBody: ...\nQuestion: "${task?.task}"`;
  const answer = await askAI(prompt);
  addComment(issueNumber, `**Response**: ${answer}`, agentKey);
  execSync(`gh issue edit ${issueNumber} --remove-label openab/${agentKey}/wip --repo LihSheng/LinkUp`);
  execSync(`gh issue edit ${issueNumber} --add-label openab/done --repo LihSheng/LinkUp`);
}
```

## Poller auto-start

The repo-local startup path is now:

```bash
cd ops-room
npm run bootstrap
npm start
```

Detached start without a shell wrapper:

```bash
cd ops-room
nohup npm start >> ../data/ops-room/logs/server.log 2>&1 &
```

`npm start` loads `../.env` via Node `--env-file`. `OPENAB_WEBHOOK_SECRET` must be set explicitly or the server exits on startup.

## Logs

```bash
tail -f data/ops-room/logs/server.log
```

Look for:
- `[poller] <agent> task on #<N>` — task detected
- `[poller] <agent> token lacks comment permission, falling back to professor` — Berlin permission fallback
- `[poller] Auto-responded to #<N> for <agent>` — successful auto-response
- `[poller] autoRespond error on #<N>` — AI API or context fetch failure
- `[poller] addComment error on #<N>` — comment posting failure
- `gh: Validation Failed (HTTP 422)` — usually from label creation (already exists, safe to ignore)
- `gh: Resource not accessible by integration (HTTP 403)` — app permission issue

## Architecture note

There are still two entrypoints:

- `ops-room/src/server/webhook.js` — live HTTP server with in-process poller
- `ops-room/src/server/poller.js` — standalone poller

The duplicated poll-loop, task-routing, GitHub App auth, and GitHub operations logic has been moved into `ops-room/src/lib/` so changes no longer need to be mirrored manually across both entrypoints.
