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
