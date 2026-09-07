# mcp-image-gen

MCP sidecar that gives LibreChat agents image generation and editing through
OpenRouter. Vendored from
[nguyen1oc/mcp-librechat-image-generation-via-OP](https://github.com/nguyen1oc/mcp-librechat-image-generation-via-OP)
(copied, not submoduled — same treatment as `cost-dashboard/`).

Reached over SSE at `http://mcp-image-gen:3013/sse`; configured in
`librechat.yaml` under `mcpServers.openrouter-imager`. Full write-up in
`~/LibreChatDocs/image-generation.md`.

## Tools

- `get_user_images(limit?)` — lists the caller's uploaded images with index
  aliases (`INDEX_1`, …) and local file_ids.
- `generate_image(prompt, reference_image_url?, reference_image_urls?, aspect_ratio?)`
  — text-to-image, or image-to-image when references are given.

Usage guidance for the model lives **in `librechat.yaml`**, inline under
`mcpServers.openrouter-imager.serverInstructions`, and is folded into the system
prompt — so there is nothing to paste into an agent's Instructions box. It is
deliberately *not* declared by this server: LibreChat only reads a server's own
declared instructions in `MCPServerInspector`, which skips any server carrying
runtime placeholders, and the `x-user-id: {{LIBRECHAT_USER_ID}}` header is one. See
the comment above `createMcpServer()` in `index.js`.

## Environment

| Var | Default | Notes |
|---|---|---|
| `OPENROUTER_KEY` | — | Required. **Server-wide** — every user of the stack spends on this one key. |
| `IMAGE_GEN_MODEL` | `meta/muse-image` | Any OpenRouter image model. |
| `IMAGE_GEN_API` | `auto` | `images` \| `chat` \| `auto`. See below. |
| `IMAGE_GEN_DAILY_LIMIT` | `3` | Per user, per container-local day. `0` disables. |
| `IMAGE_GEN_COOLDOWN_SEC` | `30` | Per user. `0` disables. |
| `IMAGE_GEN_MAX_INLINE_BYTES` | `10485760` | Above this the image is described but not attached. Keep at or below the api container's `MCP_IMAGE_DATA_MAX_BYTES`. |
| `MONGO_URI` | `mongodb://mongodb:27017/LibreChat` | Reads `files`, writes `mcp_image_gen_usage`. |

Values live in the stack's `.env`; the compose service passes them through.

## Changes from upstream

1. **Model is `IMAGE_GEN_MODEL`, default `meta/muse-image`.** Upstream hardcodes
   `google/gemini-2.5-flash-image` in `tools.js` and tells you to edit and rebuild.
2. **`media_type` from the response sets the MCP `mimeType`.** Upstream leaves the
   `/images` path pinned to the `image/png` default. `meta/muse-image` answers in
   **webp**, so every generation was mislabelled.
3. **`aspect_ratio` is a `z.enum`** of the 22 values OpenRouter accepts. Anything
   else is a hard 400 from the gateway; now it fails at the tool boundary instead.
4. **OpenRouter's error body is returned to the agent**, not just
   `Request failed with status code 400`. The body is where the actionable part is.
5. **`GET /healthz`** — probed by `scripts/deploy.sh` like the other sidecars.
6. **Instructions live in `librechat.yaml`** rather than pasted into each agent. (Upstream
   ships them as a markdown block for you to paste into every agent's Instructions box.)
7. **`usage.cost` is recorded** on each `mcp_image_gen_usage` row. This spend never
   reaches LibreChat's `transactions` collection, so it is invisible to `/cost`;
   this collection is the only record.
8. `IMAGE_GEN_API` makes the route explicit. Upstream picks it from
   `model.includes("gemini")`, which is still the `auto` behaviour.
9. **`generate_image` returns a text block, not just the image.** Upstream returns the
   `image` block alone — and LibreChat diverts every image block into `artifacts`, so the
   *model* calling the tool receives the empty string. It sees "no output", reports a
   failure to the user over a picture already on their screen, and is one step from paying
   for a retry. The text block states success, the file_id, the model, the format, the
   measured dimensions, the size, the delivered aspect ratio and the cost. Full reasoning in
   `~/LibreChatDocs/image-generation.md` → *Result shape*.
    The one thing it does **not** claim is that the model can see the image. See the trap
    below.
10. **The server chooses the `file_id`** and stamps it on the image block's
    `_meta['librechat/file_id']`. `saveBase64Image` does `file_id = _file_id ?? v4()` and
    reports neither, so upstream's server can never name its own output; a model wanting to
    edit what it just made had to call `get_user_images` and guess at the newest row. Needs
    the fork change in `packages/api/src/mcp/parsers.ts` (`fork-customizations.md` §12) —
    without it the id in the text is simply not the one on disk, which is why the text also
    names `get_user_images` as the fallback.
11. **Skipped reference images are reported.** `referencesToDataUrls` drops a reference it
    cannot read and generates anyway, silently turning an edit into a fresh generation.
    `generateImageOnOpenRouter` now returns `referencesUsed` and the summary states any
    shortfall.
12. **Dimensions are read from the returned bytes** (`imageinfo.js` — webp/png/jpeg/gif
    headers, no dependency), so "requested 16:9, delivered 3:2" is measured rather than
    assumed. Verified against `sips` on twelve real generations.
13. **An image above `IMAGE_GEN_MAX_INLINE_BYTES` (default 10 MB) is described but not
    attached.** This keeps a payload the api container is going to refuse anyway off the
    SSE transport, and lets the summary say *why* in this server's own words rather than
    LibreChat's. Since 2026-09-07 the api side drops just the oversized block and keeps the
    text (`packages/api/src/mcp/parsers.ts`); before that its cap threw and took the whole
    result with it, which is the fault this guard was originally written for. Keep the two
    values in step regardless.

## The trap: attaching an image is not delivering one

**A gateway can remove the image between here and the model, and nothing reports it.**

Measured 2026-09-07 on `Surplus (Claude)` / `claude-fable-5`. The tool returned a
1600×1600 webp; `formatToolContent` built the artifact (the saved `files` row carries
*this server's* `_meta` file_id, so the artifact path demonstrably ran); the user saw the
picture in the chat. The model's next turn was billed **454 new input tokens**, where that
image alone is ~3.3k on Anthropic's own arithmetic. It never arrived.

It is not LibreChat dropping it. This was measured once by hand and then, when a second
model filed the same report against the stack on 2026-09-07, pinned as a test:
`packages/api/src/mcp/__tests__/delivery.test.ts` drives a real MCP image result through
`formatToolContent`, a real `content_and_artifact` tool and the agents package's own
merge, and requires the base64 image out the far end — inside the `tool_result` on
Anthropic, as a separate user message on the OpenAI-shaped providers. **Do not
re-investigate this by reading the path. Run the test.** If it is green the image is in
the outbound request and the loss is downstream.

That gateway is already known to rewrite request bodies in transit (see the
`promptCacheTtl` note in `librechat.yaml`: it strips our `cache_control` TTL and stamps
its own), and an image *inside a tool result* is the newest and least portable part of the
Anthropic shape — the OpenAI tool-message shape has no room for one at all, so any seller
reached through an OpenAI-shaped adapter must drop it.

Three consequences worth knowing:

- The **OpenAI-compatible row is the more robust one for images**. On `provider: openai`
  LibreChat sends tool-result images as a *separate user message*
  (`formatArtifactPayload`), which is an ordinary vision input every gateway carries. Only
  `provider: anthropic` puts them inside the `tool_result`. If an image has to reach the
  model, prefer the plain `Surplus` row over `Surplus (Claude)`.
- The result text must not assert that the model can see the image, because on this
  gateway that is false and the model can tell. Item 9 above. It must also say where
  LibreChat's responsibility *ends*, or the model resolves "you may or may not see it" as
  "the stack is broken" and escalates — which is what produced the second report.
- Not every provider even gets that far. `formatToolContent` recognizes providers that
  `StandardGraph` has no merge branch for (DeepSeek, `ollama`), and there the artifact is
  saved for the user and never shown to the model at all. `parsers.ts` now says so in the
  result text; that is a LibreChat-side gap, not a gateway one.

## Route selection

Two OpenRouter routes reach an image model and they are not interchangeable:

- `POST /api/v1/images` — for models whose catalogue `output_modalities` is
  image-only, `meta/muse-image` among them. Returns `data[0].{b64_json,media_type}`
  and a settled `usage.cost`.
- `POST /api/v1/chat/completions` with `modalities: ["image","text"]` — for models
  that answer in text *and* image (the Gemini `*-image` family), where the image is
  buried in the assistant message in one of three shapes.

`auto` sends anything matching `gemini` down the chat route and everything else to
`/images`.

## Rebuild

```bash
cd ~/projects/librechat
docker compose up -d --build mcp-image-gen
```

It is not part of the api image, so `./scripts/deploy.sh` does **not** rebuild it —
the same as `cost-dashboard/`.
