# mcp-audio-ears

MCP sidecar that lets a model without audio input hear an audio file the user
uploaded. It reads the file off the uploads mount, sends it to an audio-capable
model on OpenRouter, and returns that model's description as text.

Reached over SSE at `http://mcp-audio-ears:3014/sse`; configured in
`librechat.yaml` under `mcpServers.audio-ears`. Full write-up in
`~/LibreChatDocs/audio-input.md`.

**This is not the native audio path.** The api image forwards audio directly to
the model the user is talking to wherever that model can take it (see
`fork-customizations.md` §11). This server exists for where it cannot: Claude and
anything else on the Anthropic protocol, Ollama text models — and for long files,
which it splits into chunks the single-part native path has no way to handle.

## Tools

- `get_user_audio(limit?)` — the caller's recent audio uploads, with index
  aliases (`INDEX_1`, …) and local file_ids.
- `listen_to_audio(file_id, focus?, style?, max_seconds?, shrink?, cross_check?, model?)`
  — returns markdown: one section per chunk, timestamped.

Usage guidance for the model lives **in `librechat.yaml`**, inline under
`mcpServers.audio-ears.serverInstructions`, for the same reason as the imager:
LibreChat only reads a server's own declared instructions in
`MCPServerInspector`, which skips any server carrying runtime placeholders, and
the `x-user-id: {{LIBRECHAT_USER_ID}}` header is one. See the comment above
`createMcpServer()` in `index.js`.

## Where the listening logic came from

`describe_audio.py` is vendored from Wolfram's `audio-listening` Claude skill
(v3, Sep 2026) — the chunk planner, the ffmpeg calls, the description prompt and
the `audio_tokens` guard are all his, largely unchanged. Divergences:

| Change | Why |
|---|---|
| `--usage-json PATH` | The wrapper has to record what a call cost; this spend never reaches LibreChat's `transactions` collection. Written even when the run fails part-way, because chunks 1–2 of 4 were already paid for. |
| `"usage": {"include": true}` in the request | OpenRouter only settles `usage.cost` into the response when asked. |
| No key in the file | The skill carries a `$1/month` key inline, deliberately. This server takes `OPENROUTER_KEY` from the environment — the same server-wide key the image sidecar spends on. |

Everything else — including the CLI, `--list-live-models` and `--cross-check` —
still works standalone inside the container:

```bash
docker compose exec mcp-audio-ears sh -c \
  'OPENROUTER_API_KEY=$OPENROUTER_KEY python3 /app/describe_audio.py --list-live-models'
```

Keep the two copies in sync deliberately. The skill is the upstream.

## Model choice is the sharp edge

`AUDIO_EARS_MODEL` must be a model that *genuinely* ingests audio. OpenRouter
listing `"audio"` in a model's `input_modalities` is **not** evidence:
`xiaomi/mimo-v2.5` listed it, accepted the `input_audio` block, discarded it,
billed as text, and returned fluent invented music criticism — a sea shanty
described as drum-and-bass, complete with a fabricated transcription. For a
translation layer that is the worst possible failure: the model reading the
description has no seam to notice.

Two things are evidence: an audio line in the model's `pricing`, and
`usage.prompt_tokens_details.audio_tokens > 0` in the response. The script checks
the second on every call; `tools.js` puts a warning banner *above* the
description when it comes back zero, because a model reading a tool result skims.

## Config

| Env | Default | Notes |
|---|---|---|
| `OPENROUTER_KEY` | — | Server-wide; the per-user limits below are what bound who spends on it |
| `AUDIO_EARS_MODEL` | `google/gemini-3.8-flash` | $0.75/M in, $3.75/M out |
| `AUDIO_EARS_DAILY_LIMIT` | 20 | Per user, per container-local day. 0 disables |
| `AUDIO_EARS_COOLDOWN_SEC` | 5 | 0 disables |
| `AUDIO_EARS_TIMEOUT_SEC` | 600 | Whole listen, chunks included. The MCP `timeout` in `librechat.yaml` must exceed it |

Measured cost: a 4:08 track at source bitrate was 2 chunks, 6206 audio tokens,
**$0.0158**. Most of that is output tokens, not the audio — so `shrink: true`
saves wall clock more than money.

## Deliberately not built

- **URL input.** The skill has a Suno fast-path; this does not. Fetching an
  arbitrary URL from a container sitting on the compose network is an SSRF
  surface, and inside LibreChat the user can just attach the file. If it's ever
  wanted: resolve the hostname first and refuse private/loopback/link-local
  addresses, then cap the download size.
- **`/cost` integration.** Same gap as `mcp_image_gen_usage` — the rows are in
  `mcp_audio_ears_usage` with a settled `cost` per listen, and nothing reads them
  yet.

## Rebuilding

`scripts/deploy.sh` does **not** rebuild this container (same as `cost-dashboard`
and `mcp-image-gen`). It does probe `/healthz` from inside the api container
afterwards, which is the half that actually breaks — network reachability plus
the `mcpSettings` allowlist.

```bash
docker compose up -d --build mcp-audio-ears
```
