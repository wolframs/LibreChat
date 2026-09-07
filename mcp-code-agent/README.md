# mcp-code-agent

Lets a model on this stack file a fault **against this stack**, and have it fixed
and deployed. It spawns a Claude Code session against this repository; that
session investigates, decides, fixes, tests and commits, and then this wrapper
deploys and verifies.

Reached over SSE at `http://mcp-code-agent:3015/sse`. Not built by
`./scripts/deploy.sh` — `docker compose up -d --build mcp-code-agent`.

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
| `list_fixes(limit?)` | Recent jobs for this account. |

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
5. **Deploy.** `./scripts/deploy.sh --yes`, which is the real validation chain:
   branch check, health wait, both sidecar probes, 14 feature markers.
6. **Auto-revert on failure.** A stack that fails verification is a stack the
   user cannot talk to a model on — nobody is left who could ask for the change
   to be undone. So it undoes itself and redeploys.
7. **Changelog.** `CHANGELOG-agent.md`, prepended and committed separately, so
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

## The two unusual mounts

Both are load-bearing.

**The repo, read-write, at its own host path.** Same path on both sides is not
cosmetic: `deploy.sh` runs `docker compose` against the host daemon, and the
daemon resolves the compose file's relative bind mounts against the *host*
filesystem. Mount the repo anywhere else and every path in a deploy triggered
from in here resolves to somewhere that does not exist.

**The docker socket**, which is root-equivalent on the host. It is here because
the wrapper's whole promise is "when this says done, it is deployed and one hard
refresh shows it", and that promise cannot be kept without running `deploy.sh`.

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
| `CODE_AGENT_ANTHROPIC_KEY` | `${SURPLUS_API_KEY}` | Required. **Not** `ANTHROPIC_API_KEY` — see below. |
| `CODE_AGENT_BASE_URL` | Surplus `/anthropic` | Must not end in `/v1`; the client appends `/v1/messages`. Empty = api.anthropic.com. |
| `CODE_AGENT_MODEL` | `claude-opus-4.8` | Dotted id, because that is the marketplace's spelling. |
| `CODE_AGENT_UID` / `_GID` | `1000` / `1000` | The uid the agent runs as. Must not be 0. |
| `CODE_AGENT_DAILY_LIMIT` | `3` | Per user, per day. `0` disables. |
| `CODE_AGENT_MAX_TURNS` | `80` | `claude --max-turns`. |
| `CODE_AGENT_TIMEOUT_SEC` | `2700` | Wall clock for one session. |
| `CODE_AGENT_REPO_PATH` | `/Users/wolfram/projects/librechat` | Must be identical on host and in the container. |
| `DEPLOY_BRANCH` | `local-features` | Preflight refuses anything else. |

### Two credentials that are not what they look like

**`ANTHROPIC_API_KEY` on this stack is the literal string `user_provided`** —
LibreChat's sentinel meaning each user supplies their own key through the UI. It
is 13 bytes, it is not a key, and passing it to the agent produces a 401 three
seconds into every job with nothing on the wire to suggest the problem is
configuration rather than code. Hence the separate `CODE_AGENT_ANTHROPIC_KEY`,
and `preflight` refusing that exact string by name.

**The wrapper runs as root and the agent must not.** Claude Code exits
immediately with *"--dangerously-skip-permissions cannot be used with root/sudo
privileges for security reasons"*. The container is root because the wrapper
needs the docker socket for `deploy.sh`, so the agent is dropped to uid 1000 via
`execFile`'s `uid`/`gid` — no `su` wrapper, therefore no shell to escape a
multi-thousand-character prompt through. `git config` is set for **both** uids in
the Dockerfile; configure only `/root` and the agent's commits fail with "please
tell me who you are". `stdio: ['ignore', …]` closes the child's stdin, or the CLI
waits on an inherited one that nothing will ever close.

`/healthz` reports `keyOk`, `baseUrl`, `agentUid` and `wrapperUid` so all of that
is visible without filing a job.

### Cost

Measured on Surplus, 2026-09-07: **a single one-word turn cost $0.96.** Claude
Code sends a large system prompt and full tool definitions on the first request,
and that is what you are paying for — later turns in the same session are far
cheaper because of prompt caching, but the floor for *any* job is around a
dollar. A real repair is plausibly $5–30.

That makes this by far the most expensive thing on the stack: an image is $0.01,
an audio listen ~$0.016. `CODE_AGENT_DAILY_LIMIT` defaults to **3** for that
reason, and it is the only thing bounding the spend.

Spend draws down the **Surplus buyer credit**, so it does show up in `/cost`'s
credit-remaining card — but not as transactions, and not attributed to this
sidecar. Run out and the gateway answers 402 mid-job.

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
