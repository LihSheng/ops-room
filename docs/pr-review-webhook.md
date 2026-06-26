# PR Review Webhook Design

This enhancement routes PR review commands to Ops Room so the selected agent can respond using its own GitHub App identity.

## Goal

When a user comments on a PR:

```text
/openab berlin --chat review this PR
```

GitHub Actions should call Ops Room instead of posting queue comments itself. Ops Room then uses Berlin's GitHub App credentials to fetch PR context and post the review as `lihsheng-berlin[bot]`.

## Required runtime configuration

Ops Room already supports separate GitHub App configuration per agent:

- `GITHUB_APP_ID_BERLIN`
- `GITHUB_APP_INSTALLATION_ID_BERLIN`
- `GITHUB_APP_KEY_PATH_BERLIN`
- `GITHUB_APP_BOT_USER_BERLIN`

The GitHub workflow should only call the Ops Room webhook with `OPENAB_WEBHOOK_SECRET`. It should not use a user PAT for agent actions.

## Payload shape

```json
{
  "agent": "berlin",
  "task_type": "chat",
  "task": "review this PR",
  "repository": "LihSheng/LinkUp",
  "pr": 24,
  "commenter": "LihSheng",
  "trigger": "issue_comment"
}
```

## Desired flow

```text
GitHub PR comment
  -> GitHub Actions parses command
  -> GitHub Actions POSTs payload to Ops Room
  -> Ops Room generates Berlin GitHub App installation token
  -> Ops Room fetches PR metadata and diff
  -> Berlin reviews the PR
  -> Ops Room posts the review with Berlin's GitHub App token
```
