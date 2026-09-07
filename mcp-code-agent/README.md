# mcp-code-agent

Lets a model on this stack file a fault **against this stack**, and have it fixed
and deployed. It spawns a Claude Code session against this repository; that
session investigates, decides, fixes, tests and commits, and then this wrapper
deploys and verifies.

**This is a host process, not a container.** It runs as the operator and drives
the Claude Code already installed and logged in on this Mac — so there is no
image, no API key, no uid to drop to and no base URL to aim at. Every one of
those existed in the first version only because the agent had been put somewhere
it did not need to be.

Started by `~/Library/LaunchAgents/local.librechat.code-agent.plist`
(`RunAtLoad`, `KeepAlive`), logging to `mcp-code-agent/agent.log`. LibreChat
reaches it at `http://host.docker.internal:3015/sse`.

```bash
launchctl load   ~/Library/LaunchAgents/local.librechat.code-agent.plist   # start
launchctl unload ~/Library/LaunchAgents/local.librechat.code-agent.plist   # stop
tail -f ~/projects/librechat/mcp-code-agent/agent.log
```

## The design stance

**Reversibility over prevention.** This is a single-operator home lab. A wrong
deploy costs a hard refresh and a `git revert`; a wrapper that cannot deploy
costs the entire premise. So the safety budget goes into undo, not walls.

**The wrapper does logistics, not epistemics.** It guarantees the clean-tree
precondition, that the tests actually pass before anything ships, that the deploy
happens and is verified, that a failed verification auto-reverts, and that the
changelog records what happened with the exact command to undo it. It does **not**
judge the fix. Judging the fix is the receiving Claude's job — that is why a
frontier model is in the loop at all.

**Vibes in, judgment inside.** `request_fix` takes one string. No severity, no
scope, no component, no suggested implementation. Every extra field is a question
the sending model would feel obliged to answer precisely, and the moment filing
feels like filling in a form, the sender starts writing specifications instead of
observations. A design that punishes an underspecified premise — by literal
execution or by clarification deadlock — is a failed design, because it taxes the
sender into 5,000-character prompts and kills the reason the tool exists.

`prompt.js` is where that contract is actually enforced, and it is the most
important file here. It tells the receiving session that what it has is a premise
that may be wrong, that it should investigate first, fix the class rather than the
instance, disagree out loud when the diagnosis is off, and decide rather than ask.

## Tools

| Tool | Does |
|---|---|
| `request_fix(premise)` | Files it. Returns a job id immediately and starts working. |
| `check_fix(job_id, include_diff?)` | Status, the agent's own report, commits, diffstat, deploy result, and the undo command. Full diff on request. |
| `resume_fix(job_id)` | Continues a job that hit the turn limit, **in its original session**. |
| `add_note(job_id, note)` | Corrects a premise after filing; reaches a still-running agent. |
| `list_fixes(limit?)` | Recent jobs for this account. |

### Resuming, and why it matters

The turn limit ends a *run*, not a *session*. The transcript stays on disk under
`~/.claude/projects/…` with every file the agent read and every conclusion it
reached, and `--resume <session_id>` continues it headlessly with that context
intact — verified: a fact stated before the cut-off is still recalled after.

So a job that ran out of turns is worth a message, not a whole new run. Filing
again would pay for the same investigation twice and arrive in the same place.
`resume_fix` reuses the job document — same premise, same notes, same base
commit — because it is the same piece of work, and two changelog entries would
claim otherwise. The resume prompt is deliberately short: the agent already holds
everything except the knowledge that it was interrupted rather than finished.

It is also the moment a late correction lands. `add_note` writes outside the
repo; the resume message tells the agent to read that file first, so a premise
corrected after filing reaches the session that is about to act on it.

## What a job actually does

1. **Preflight.** Refuses if another job is running, if the repo is on the wrong
   branch, or if the working tree is dirty — and returns the actual
   `git status --porcelain` so the model can tell its user *what* is in the way.
   A dirty tree matters because the agent's commit would otherwise sweep up
   somebody's unrelated work and ship it without anyone deciding to.
2. **Context.** Finds the caller's most recently touched conversation, pulls its
   last dozen messages out of Mongo, and hands them to the agent as raw evidence.
   The sender never has to curate a bug report; the transcript showing the empty
   tool result is simply there. Skipped if that conversation has not moved in
   `CODE_AGENT_CONTEXT_MAX_AGE_MIN` (30) — a stale transcript presented as
   evidence is worse than none, and the premise alone is a valid input anyway.
3. **The session.** `claude -p` with the briefing from `prompt.js`, deny rules
   from `agent-settings.json`, in the real working tree.
4. **Tests.** The wrapper runs `./scripts/agent-test.sh` itself over the touched
   workspaces. Not distrust — "tests were green at deploy time" is a fact about
   the tree as it stands *now*, and only a run now establishes it. Failure
   reverts the commits, because otherwise the human's next deploy ships code
   that failed its tests.
5. **Set aside leftovers.** Anything the agent left uncommitted is `git stash`ed
   first. The gate tests the working tree but the remedy only undoes commits, so
   a half-finished edit left by a cut-off agent would otherwise fail the tests
   and provoke a revert that could not possibly fix it — which is exactly what
   happened once, costing eight commits. It is also what would have shipped,
   since the image builds from the working tree. Stashed rather than discarded:
   `git stash pop` brings it back.
6. **Deploy.** `./scripts/deploy.sh --yes`, which is the real validation chain:
   branch check, health wait, both sidecar probes, 14 feature markers.
7. **Auto-revert on failure.** A stack that fails verification is a stack the
   user cannot talk to a model on — nobody is left who could ask for the change
   to be undone. So it undoes itself and redeploys.
8. **Changelog.** `CHANGELOG-agent.md`, prepended and committed separately, so
   reverting a change does not also revert the record that it happened.

## Why there is no conversation header

`{{LIBRECHAT_BODY_CONVERSATIONID}}` is the only placeholder that would name the
calling chat, and it cannot be used here. A `LIBRECHAT_BODY_*` placeholder makes
the connection **require** a chat request body carrying that field
(`UserConnectionManager.getUserConnection` → `getMissingRuntimeBodyPlaceholderFields`),
and switching a server on from the MCP dropdown is a *reinitialize with no body*.
So it fails with `MCP error -32600: Request body field(s) required to resolve
runtime MCP placeholders: conversationId` and the UI shows **"failed to
initialize MCP server"** — the server cannot be enabled in the one place it is
meant to be enabled.

The conversation is therefore found from the user id: their most recently updated
conversation, and only if it moved in the last 30 minutes. That is a heuristic,
deliberately bounded rather than trusted, and the job runs on the premise alone
when the window lapses.

## Why it is not a container

It was one, briefly, and everything that went wrong with it was container tax:

- Claude Code refuses `--dangerously-skip-permissions` as root, but the container
  had to be root to reach the mounted docker socket to run `deploy.sh` — so the
  agent had to be spawned at a dropped uid, with `git config` written for both
  uids, and the repo bind-mounted at its own host path so the daemon would
  resolve relative binds correctly.
- It needed its own credential, and `ANTHROPIC_API_KEY` on this stack is the
  literal string `user_provided` (LibreChat's per-user-key sentinel), so it had
  to be pointed at a separate key and base URL.
- And that meant paying per token — $0.96 for a single one-word turn on the
  marketplace — for a Claude Code that was worse than the one already sitting on
  the machine, authenticated, one version newer.

As a host process all of that is simply absent. `git`, `docker compose`,
`deploy.sh` and `claude` all behave exactly as they do when the operator runs
them, because it *is* the operator running them.

The one thing the container did buy was isolation from the rest of the home
directory. That is gone, and the deny list gained the specific things `git
revert` cannot undo — the Forgejo PAT, `~/.ssh`, `~/.aws`, `gh` credentials.
File tools are already confined to the repo by the working directory; those
entries cover the shell path around it.

**Mongo has to be reachable from the host** for this, so
`docker-compose.override.yml` binds it to `127.0.0.1:27017` — loopback only, off
the LAN and off Tailscale.

## What is denied, and why only this

`agent-settings.json` is short on purpose. `git revert` undoes a bad edit, so the
deny list is only for the things it cannot undo:

- `.env`, `.env.*`, `searxng/settings.yml` — a leaked secret is out. (The Brave
  API key and the SearXNG `secret_key` live in that file.)
- `data-node/**` — chat history.
- `scripts/deploy.sh`, `scripts/agent-test.sh` — the supervisors. An agent that
  can weaken its own verification makes every later job less trustworthy with
  nothing to show for it in any diff anyone reads.
- `CHANGELOG-agent.md` — the wrapper writes it; an agent editing its own record
  defeats the record.
- `git push` — publication is a human decision, and the GitHub fork is public.
- `docker`, `deploy.sh` — not a restriction on capability, a sequencing rule.
  The wrapper deploys once, after the tests, so the job state and the changelog
  are true. An ad-hoc deploy mid-session makes both of them lie.

Every commit is authored `LibreChat code-agent <code-agent@librechat.local>`, so
`git log --author=code-agent` separates what a model changed from what a person
did, permanently, with no list to maintain.

## Environment

| Var | Default | Notes |
|---|---|---|
| `CODE_AGENT_MAX_TURNS` | `250` | A backstop, not a budget — 80 cut a real investigation off mid-thought. |
| `CODE_AGENT_MODEL` | unset | Empty means whatever the installed Claude Code defaults to, which is usually right. |
| `CODE_AGENT_DAILY_LIMIT` | `0` (off) | Filing only happens from a chat the operator is in, so there is nothing to ration. |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/LibreChat` | Loopback, via the compose port binding. |
| `CODE_AGENT_MAX_TURNS` | `80` | `claude --max-turns`. |
| `CODE_AGENT_TIMEOUT_SEC` | `2700` | Wall clock for one session. |
| `CODE_AGENT_REPO_PATH` | `/Users/wolfram/projects/librechat` | Must be identical on host and in the container. |
| `DEPLOY_BRANCH` | `local-features` | Preflight refuses anything else. |

### Usage, not cost

It runs on the operator's own Claude Code subscription, so `total_cost_usd` from
the CLI is **not a bill**. `modelUsage[…].costBasis` says `"list"` — it is what
the work would have cost at API list price had it gone through a key. Leading
with that number invites reading money that was never spent.

What a subscription actually consumes is tokens, and they are not one number:

| | means |
|---|---|
| **out** | generation, the real work |
| **cache-write** | new context being laid down |
| **cache-read** | context reused, roughly a tenth the weight |
| **in** | uncached input, usually tiny |

So a run that looks enormous by cache-read is generally cheap, and one heavy on
cache-write is not. `check_fix`, `/agent` and the changelog all report the
breakdown, with the list-price figure last and labelled as notional.

Live totals during a run are summed from each assistant message; the final
figures come from the stream's `result` event, which is authoritative.

There is no daily limit by default. It existed to bound spend against a paid key;
the agent runs on the operator's own subscription now, and a filing only ever
happens from a chat they are sitting in — so it was rationing something nobody
could spend behind their back, while blocking the one case that genuinely needs
several filings in a row: a bad afternoon.

### Health

`/healthz` reports `agentAvailable`, which actually runs `claude --version`. That
is the check worth having: a LaunchAgent inherits no login shell, so a `PATH`
missing `~/.local/bin` shows up as "claude: not found" — and without the probe it
would only show up after a job had been filed and a conversation dropped.
`deploy.sh` warns (does not fail) when it cannot reach the sidecar, since the
stack is fine without it.

## Turning it on

The container can run without being reachable by any model — nothing connects
until this block exists in `librechat.yaml`, which is the deliberate on-switch:

```yaml
mcpSettings:
  allowedDomains: ["mcp-image-gen", "mcp-audio-ears", "mcp-code-agent"]
  allowedAddresses: ["mcp-image-gen:3013", "mcp-audio-ears:3014", "mcp-code-agent:3015"]

mcpServers:
  code-agent:
    type: sse
    url: "http://mcp-code-agent:3015/sse"
    headers:
      x-user-id: "{{LIBRECHAT_USER_ID}}"
      # No conversation header — see "Why there is no conversation header" below.
    chatMenu: true
    timeout: 60000
    requiresOAuth: false
    serverInstructions: |
      You can file a fault against this LibreChat stack itself and have it fixed.

      Use `request_fix` when you notice something wrong with your own environment
      — a tool returning nothing, a file you cannot read, a capability that is
      documented but absent. Describe what you noticed in one or two sentences,
      in your own words. Do NOT write a specification, do not guess at the cause
      unless you actually know it, and do not propose an implementation: a Claude
      Code session reads the whole repository and works it out, and a confident
      wrong guess sends it down your wrong path.

      Filing costs real money and changes a live system. Ask the user first
      unless they have already asked you to fix it.

      The deploy restarts the api, so THIS CONVERSATION WILL DROP a few minutes
      after you file. That is expected. Tell the user to hard-refresh once, then
      call `check_fix(job_id)` to read what was found and done.

      Every change is a git commit and `check_fix` returns the exact command to
      undo it. Offer that if the user is unhappy with the result — it is routine,
      not an emergency.
```

Then `./scripts/deploy.sh --config`.
