# code-agent

A host MCP server drives the operator's installed, authenticated Claude Code. LibreChat
files a request and immediately receives a job ID. The job continues independently of
the originating tool call, chat turn, SSE connection, and any API restart.

## Work belongs to a job

Every new job starts from the committed `local-features` tip in its own Git worktree,
on `code-agent/<full-job-id>`. The operator checkout's staged, unstaged and untracked
changes are neither copied nor committed nor stashed. No deployment builds from that WIP.

The root defaults to `~/.local/state/librechat-code-agent/<hash-of-repo-path>/`. Under
`jobs/<id>/`, `job.json` is the durable lifecycle record, `notes.md` is the versioned
communication channel, and `worktree/` is the checkout. Mongo mirrors the record for
`check_fix` and `/agent`. The filesystem record is written first and reconciled to Mongo
at startup. It records the base/tested/integrated SHAs, branch, path, Claude session ID,
subprocess groups, notes, usage per segment, validation, image IDs and cleanup outcome.

Git worktrees share the object database and refs. This is ordinary working-directory
isolation, **not a security sandbox** for hostile code. The coding agent is instructed
to use only its own checkout. No node_modules or workspace-build symlinks point into
the operator checkout: each job runs its own `npm ci` and `npm run build:packages`.
That preparation can take several minutes and is reported as `preparing`; it happens
outside the Claude turn budget. The install is reused on resume when the lockfile matches.

One job runs at a time. Admission is reserved before asynchronous preflight can race
another caller. A filesystem supervisor lock also excludes a second server instance.
Model and build/test/git process groups are recorded before their input is released;
timeouts terminate the group, including descendant processes. Starting another job is
refused while a recorded group is still alive after a supervisor crash. A PID that may
have been reused is treated conservatively and requires inspection.

## Completion and interruption

Claude returns a structured result: `outcome` (`complete` or `needs_input`), `report`,
and the `notesVersion` it read. Exit zero or a reassuring final sentence alone is not
completion. Uncommitted source also prevents publication. Nothing is automatically
stashed to make the gate appear clean.

A turn-limit exit preserves **both commits and unfinished edits**, and never deploys
partial work. By default the wrapper can continue the same session twice, within a
45-minute model-running budget per start/resume request. Exhausting either bound leaves
the job `paused`. `resume_fix` grants a fresh bounded attempt in the same directory and
session. It does not manufacture a new job or lose its context. Progress counts assistant
messages separately from CLI turns; those are not interchangeable measurements.

`needs_input` is an intentional handoff: the LibreChat agent relays the question, records
the user's answer with `add_note`, then resumes the job. A user-requested `pause_fix`
terminates the current coding/preparation/test/build process before publication; source
edits remain. Once integration begins, the supervisor finishes that transaction rather
than killing it halfway through.

## Notes and the two agents

The coding agent reads versioned notes before decisions and before its completion report.
The supervisor checks its acknowledgement. A newer note received before integration
invalidates an older report, including notes arriving during testing or image build.
A continuation can read it automatically within the bounded budget; otherwise the job
pauses for `resume_fix`. An `add_note` receipt explicitly distinguishes this from a late
note: once integration begins, the note is retained as follow-up, not advertised as
changing the revision in flight. Notes do not themselves restart a paused job.

Both prompts preserve explicit user requirements while treating uncertain diagnoses as
hypotheses. The coding agent can ask for an essential choice through `needs_input`;
it is no longer told that nobody can answer. It does not recursively call this MCP
server: its CLI invocation uses a strict empty MCP configuration. The operator's normal
CLI model/auth choices remain in effect.

The most recently updated conversation belonging to the caller remains a bounded
context heuristic (30 minutes by default), not proof of which conversation filed the
job. It is labelled as potentially unrelated evidence. Do not add a
`LIBRECHAT_BODY_CONVERSATIONID` header: enabling the server from LibreChat's MCP dropdown
has no request body and that placeholder prevents initialization.

## Tests, integration, and deployment

The gate runs in the private worktree, builds packages before consumers, and tests
affected workspaces. Package changes also test consumers. A failed Jest suite is retried
in isolation (up to eight suites); the record names what passed only on retry. Passing
alone indicates a non-repeatable failure, not proof that the change cannot cause it.
`mcp-code-agent` and `mcp-image-gen` changes run their own npm tests. Unsupported runtime
components are explicitly left for operator application, not silently reported deployed.

Before testing, target-branch advances are merged into the job worktree. Conflicts stay
there for the coding agent to resolve on resume. Tests run against the resulting commit.
Integration requires the operator checkout to be on the expected branch, clean, and at
the target commit used in that test. If it is dirty or has moved again, the completed
job waits in `awaiting_integration`; `resume_fix` retries without repeating investigation
(unless new notes require the model). No auto-stash or auto-commit is performed there.
Integration is a merge commit, checked against its expected two parents.

API-only source changes are built from `git archive <tested-sha>` in a temporary build
directory, excluding all ignored files, dependencies and unrelated WIP. The resulting
immutable image ID is recorded. Runtime compose configuration must match the running
API's configuration hash before automatic application. A pending operator config change
therefore waits for reconciliation rather than being included in this deployment.

`DEPLOY_EXPECTED_HEAD=<integration-sha> ./scripts/deploy.sh --yes --image sha256:...`
applies that image without a source build or rebuilding other services. The normal
`librechat-fork:local` tag is updated too, so later compose operations use the same image.
The script refuses changed source before application, restarts the API and nginx, then
runs the normal health and feature checks. The previous image ID is recorded first.
On failure, the wrapper restores that image and reverts only its own integration merge,
provided the source is still at the expected clean HEAD. Concurrent operator edits are
left intact; an incomplete source/runtime rollback is `recovery_required`.

Runtime configuration, sidecar, or mixed runtime/API changes integrate with status
`applied_pending_restart` and explicit application advice. In particular code-agent is
a **host process**, not a Docker service: after `/healthz` reports `activeJob: null`,
apply its source with `launchctl kickstart -k gui/$(id -u)/local.librechat.code-agent`.
Do not restart it during a job. Documentation-only work is `integrated_only`. Only
`done` means the API candidate was deployed and verified.

## Recovery and cleanup

The worktree is locked against incidental Git worktree pruning. Paused, conflicted,
failed and waiting jobs retain it. Successful clean jobs are removed automatically,
after `refs/code-agent/jobs/<id>` makes their committed work permanently reachable.
The branch is then removed; the small job/notes record, session and recovery ref remain.

Use `archive_fix` only when the user wants to close a retained job. It commits unfinished
tracked/untracked source **in that job's checkout**, creates the recovery ref, then
removes the worktree. It refuses credential-bearing files. Unknown ignored files also
defer cleanup; only recognised dependency/build/cache outputs can be discarded. The
receipt and health inventory name any deferred cleanup. Archived sessions are closed,
not automatically resumable. To recover source manually:

```sh
git show refs/code-agent/jobs/<id>
git worktree add --detach <new-directory> refs/code-agent/jobs/<id>
```

At most 12 retained worktrees are allowed by default. Hitting that bound lists the job
IDs to resume or archive; it never deletes paused work by age. `/healthz` inventories
retained directories, cleanup warnings and recovery refs independently of recent Mongo
history. Failed image-build directories are separately recorded for inspection, then
removed on a build retry or safe job cleanup; image
IDs and tags remain subject to normal Docker retention. Do not prune an image needed
for a pending deployment or rollback.

Startup reconciles unfinished records without assuming every child died. Interrupted
editing/testing can be resumed after recorded processes exit. Interrupted integration
or deployment is `recovery_required`. An explicit `resume_fix` can recover only when
the branch parents, clean target, and live image match the recorded transaction; an
unrelated branch advance/image requires human inspection. The supervisor does not
silently repeat a deploy at boot. Legacy jobs created before isolation remain readable,
but their shared-checkout sessions cannot be resumed under this new contract.

New job reports live in the durable record, Mongo, MCP and `/agent`. `CHANGELOG-agent.md`
remains the historical record; this workflow does not append commits to the operator's
checkout merely to log a failed or no-change job. The source undo is one
`git revert -m 1 <integration-sha>`; runtime application is a separate step.

## MCP surface and configuration

`request_fix`, `check_fix`, `resume_fix`, `add_note`, `list_fixes`, `pause_fix`, `archive_fix`.
Keep full IDs across chat turns. Poll in 30–60 seconds or on the next user turn. An API
deployment may disconnect the chat; reconnect and check the same ID rather than filing
again. Starting a job does not guarantee a deployment or a disconnect.

`prompt.js` exports `SERVER_INSTRUCTIONS`, also served by MCP initialization. Since
LibreChat can skip those instructions for a server with per-user placeholders, the
same text must be used in `librechat.yaml`'s code-agent `serverInstructions`. Tool
descriptions carry the essential status and handoff contract independently.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPO_PATH` | `/Users/wolfram/projects/librechat` | Operator checkout/runtime project |
| `DEPLOY_BRANCH` | `local-features` | Integration branch; never upstream `main` here |
| `CODE_AGENT_WORKTREE_ROOT` | repo-specific state directory | Durable job directories |
| `CODE_AGENT_MAX_WORKTREES` | 12 | Retained-worktree capacity |
| `CODE_AGENT_MAX_TURNS` | 250 | CLI turns per model segment |
| `CODE_AGENT_MAX_CONTINUATIONS` | 2 | Automatic extra segments per start/resume |
| `CODE_AGENT_TIMEOUT_SEC` | 2700 | Total model-running time per start/resume |
| `CODE_AGENT_MODEL` | installed CLI default | Optional model override |
| `CODE_AGENT_DAILY_LIMIT` | 0 (off) | New jobs per user/day; resumes remain available |
| `CODE_AGENT_CONTEXT_MAX_AGE_MIN` | 30 | Conversation heuristic window |
| `CODE_AGENT_CONTEXT_MESSAGES` | 12 | Maximum context messages |
| `PORT` | 3015 | Host MCP listener |
| `MONGO_URI` | `mongodb://mongodb:27017/LibreChat` | Set to host loopback in launchd |

Run `npm test` here. Tests use real temporary Git repositories/worktrees and real child
processes, with controlled replacements only at the Claude/deployment boundary. They
do not invoke a paid model, modify the operator checkout, or deploy the live stack.
