# mcp-image-gen

MCP sidecar (`imager` in `librechat.yaml`) that gives LibreChat agents image
generation and editing through **OpenRouter** and **Surplus Intelligence** — the
model picked per call decides the route. Vendored from
[nguyen1oc/mcp-librechat-image-generation-via-OP](https://github.com/nguyen1oc/mcp-librechat-image-generation-via-OP)
(copied, not submoduled — same treatment as `cost-dashboard/`); the Surplus
provider and the model registry are this fork's.

Reached over SSE at `http://mcp-image-gen:3013/sse`; configured in
`librechat.yaml` under `mcpServers.imager`. Full write-up in
`~/LibreChatDocs/image-generation.md`.

## Tools

- `get_user_images(limit?)` — lists the caller's uploaded images with index
  aliases (`INDEX_1`, …) and local file_ids.
- `generate_image(prompt, model?, reference_image_url?, reference_image_urls?, aspect_ratio?)`
  — text-to-image, or image-to-image when references are given. `model` is an
  enum of `IMAGE_GEN_MODELS`, and its description (built at startup from the
  registry plus the Surplus catalogue) tells the model each option's provider,
  list price and whether it takes references.

Usage guidance for the model lives **in `librechat.yaml`**, inline under
`mcpServers.imager.serverInstructions`, and is folded into the system
prompt — so there is nothing to paste into an agent's Instructions box. It is
deliberately *not* declared by this server: LibreChat only reads a server's own
declared instructions in `MCPServerInspector`, which skips any server carrying
runtime placeholders, and the `x-user-id: {{LIBRECHAT_USER_ID}}` header is one. See
the comment above `createMcpServer()` in `index.js`.

## Environment

| Var | Default | Notes |
|---|---|---|
| `OPENROUTER_KEY` | — | Needed for OpenRouter models. **Server-wide** — every user of the stack spends on this one key. |
| `SURPLUS_IMAGE_KEY` | — | Needed for Surplus models. Its own key, **not** `SURPLUS_API_KEY`: see *Surplus* below. |
| `IMAGE_GEN_MODELS` | `meta/muse-image` | Comma-separated menu. `vendor/name` ⇒ OpenRouter, bare name ⇒ Surplus; `openrouter:`/`surplus:` prefix overrides. First entry is the default. |
| `IMAGE_GEN_MODEL` | first of the list | Which listed model is the default. |
| `IMAGE_GEN_SURPLUS_WEEKLY_USD` | `1.5` | Rolling 7-day dollar cap on Surplus spend, all users. Enforced here because the key cannot cap itself. `0` disables. |
| `IMAGE_GEN_API` | `auto` | `images` \| `chat` \| `auto`. OpenRouter route only. See below. |
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
   reaches LibreChat's `transactions` collection; this collection is the only record, and
   `/cost` reads it directly (`cost-dashboard/sidecars.py`) — summary cards and a *Tool
   sidecars* panel, not the per-conversation tables.
8. `IMAGE_GEN_API` makes the route explicit. Upstream picks it from
   `model.includes("gemini")`, which is still the `auto` behaviour.
9. **`generate_image` returns a text block, not just the image.** Upstream returns the
   `image` block alone — and LibreChat diverts every image block into `artifacts`, so the
   *model* calling the tool receives the empty string. It sees "no output", reports a
   failure to the user over a picture already on their screen, and is one step from paying
   for a retry. The text block states success, the file_id, the model, the format, the
   measured dimensions, the size, the delivered aspect ratio and the cost. Full reasoning in
   `~/LibreChatDocs/image-generation.md` → *Result shape*.
    It explains **what happens to the picture** — that it is already in the chat and the model
    need do nothing to show it — and says **nothing about whether the model can see it**. Both
    halves are deliberate, and both were learned by getting them wrong. The mechanism has to be
    stated because a model reading this in a bare chat, with none of these docs, has no way to
    know LibreChat renders the artifact for the user; without that line it may try to "deliver"
    an image the user is already looking at. The perception half has to be absent because every
    version that included it made things worse: asserting the model could see it was false on a
    gateway; hedging got read as "the stack is broken" and escalated; asking the model to report
    what it could and could not see turned a chat into a QA session. See the trap.
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
14. **A second provider, chosen per call.** `models.js` is the registry, `surplus.js` the
    Surplus route, and `tools.js` picks by the entry's provider. Upstream is OpenRouter-only
    with one model baked in. Everything measured about the Surplus route is in the next
    section and in the comment atop `surplus.js`.

## Surplus Intelligence

Surplus reaches its image models through the **OpenAI images shape**, not OpenRouter's:
`POST /v1/images/generations` `{model, prompt, size, response_format}` and
`POST /v1/images/edits` with `image` (one data URI) or `input_images` (up to 8, first is the
base). JSON, not multipart. Both answer `{created, data: [{b64_json}]}` and nothing else —
no `media_type` (the container is sniffed off the bytes), no `usage`, and no cost header.
Measured 2026-09-08, all of it:

- **A key minted before the images endpoints existed cannot call them.** `SURPLUS_API_KEY`
  (2026-08-03) answers `/v1/images/*` with `403 endpoint_not_in_key_scope`; a key minted
  the same day works. `/v1/buyer/keys` lists no scope field and takes none, so the only fix
  is a new key. Hence `SURPLUS_IMAGE_KEY`, labelled `librechat-imager` in the dashboard
  (id `01M20QD32N7M2RADBJ0D44J9AD`, prefix `inf_eb82d5b1`).
- **The key cannot cap itself.** `PUT /v1/buyer/keys/{id}/preferences` accepts a `limits`
  object and stores `{}` — 200, no error. `IMAGE_GEN_SURPLUS_WEEKLY_USD` in `tools.js` is
  the cap, summed from `mcp_image_gen_usage` over a rolling week.
- **A catalogue entry is not a routable model, and routability moves by the minute.**
  `/v1/models` lists 55 image-output models; `venice-z-image-turbo`, `venice-seedream-v5-lite`
  and `venice-hunyuan-image-v3` are all there and all answer `not a valid model ID`.
  `/v1/prices` shows `providers: []` for every image model. `grok-imagine-edit` routed at
  14:49 UTC and not at 16:46; `venice-sd35` at 16:46 and not at 16:52 UTC. So `IMAGE_GEN_MODELS`
  is hand-kept, and `surplus.js` classifies that 400 as `SurplusNotRoutingError`: `tools.js`
  answers with a "not routing right now, nothing billed, switch to …" message whose
  alternatives fit the call, remembers the gap for `IMAGE_GEN_NOT_ROUTING_WINDOW_MS`
  (3 min) and refuses a repeat pre-flight, and `healthz.surplusNotRouting` lists it.
- **A text-to-image model never takes a reference, whichever field carries it.** The
  gateway checks capability per model: `/edits` answers `model_capability_unsupported`, and
  an `image`/`input_images` on `/generations` is routed into the same check. The cheap
  edit tier ($0.04–0.06) never routed on 2026-09-08; `wan-2-7-pro-edit` ($0.094) did, and
  is the second edit model for when `grok-imagine-edit` is down.
- **Moderation differs per model and the description says so.** `meta/muse-image` refuses
  "a woman in a bikini" (`content management policy`, 67 s); every Venice model returns it;
  lustify is uncensored. `MODERATION` in `models.js` feeds the `model` description, and an
  OpenRouter filter refusal comes back naming the lenient models and "nothing was billed".
- **Model-facing text uses the registered tool names** (`generate_image_mcp_imager`,
  `TOOL_SUFFIX` in `tools.js`): LibreChat appends `_mcp_<yaml key>`, and a bare
  `generate_image` in the instructions is a `Tool not found` round-trip.
- **`size` is a closed set** — `1024x1024`, `1536x1024`, `1024x1536`, `1792x1024` accepted;
  `1344x768`, `896x1120`, `1920x1080` are `Invalid request parameters`. So `aspect_ratio`
  maps to the nearest of those, and the gateway honours orientation, not the exact ratio —
  the same as `meta/muse-image`, with different shapes — on `venice-sd35`. `venice-wan-2.7`
  (always 1024²) and `venice-qwen-image` (always 1024×768) ignore `size` altogether, and
  the result text says "ignores" rather than "orientation hint" when even that was missed.
  `aspect_ratio` itself is rejected by the gateway even where the catalogue lists it. An
  edit keeps the reference's shape.
- **`/edits` rejects `n`** with the same `Invalid request parameters` it gives an unknown
  size, while `/generations` accepts it. Nothing in the message says which field.
- A reference sent to a text-only model is `400 model_capability_unsupported` after the
  round-trip; `tools.js` refuses it before the request instead. An edit model on
  `/generations` works as plain text-to-image.
- **Cost arrives an hour later.** The settled charge exists only in the buyer usage export,
  so the usage row records the catalogue list price (`listCost`, `costSource: "list"`) and
  `cost-dashboard/reconcile.py` writes `reconciled.costUSD` onto it — matched by model and
  `requestedAt`, since the export's `request_id` is not the response's `x-request-id`.
  Settled at ~35% of list on the day: `venice-sd35` $0.0035, `grok-imagine-edit` $0.014.
- Every Venice-served response carries `x-si-adapted-params: safe_mode`. Recorded on the
  usage row (`adaptedParams`), not interpreted.

## Keepalive

`/sse` writes an SSE comment line every `SSE_KEEPALIVE_MS` (30 s). LibreChat applies the
yaml row's `timeout` as undici's `bodyTimeout` on the stream, and an idle MCP session is
silent, so without this the api killed and reopened the session every 184 s and any tool
call inside the reconnect window came back `Tool … not found`. Measured 2026-09-08; the
comment above the handler in `index.js` has the timestamps.

## The trap: attaching an image is not delivering one

**A gateway will remove an image nested inside a `tool_result`, and nothing reports it.**
Fixed on 2026-09-07 by moving the image out of that position — see *The fix* at the end of
this section — but the shape of the fault is worth keeping, because it took three
investigations to pin and the next media type will fail the same way.

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

### The fix: position, not transport

The gateway carries images perfectly well. It loses them in exactly one position. Four
requests on 2026-09-07 differing only in where the image block sat — a 200×200 magenta PNG,
one word asked back:

| Where the image sat | Reply | Input tokens |
|---|---|---|
| plain user message, no tools | `Magenta` | 110 |
| **nested inside `tool_result`** | **`NOIMAGE`** | **667** |
| sibling of `tool_result`, same user turn | `magenta` | 735 |
| in a following user message | `magenta` | 741 |

The ~70-token hole in row 2 is the image, absent. Rows 3 and 4 are the same request with
the block moved one position.

So LibreChat now moves it. `packages/api/src/endpoints/anthropic/toolResultMedia.ts`
lifts every non-text block out of its `tool_result` and re-inserts it immediately after, as a
sibling in the same user turn (row 3), in a `fetch` wrapper on the outgoing body — and
only off `api.anthropic.com`, where the nested shape is correct and delivered. Row 3 over
row 4 because it adds no message, so role alternation, the tool_use/tool_result adjacency
rule and `cache_control` ordering are all untouched. `deploy.sh` marker 15 guards it, and
`toolResultMedia.spec.ts` pins the shape.

Three consequences still worth knowing:

- **Write the result text for a model in a bare chat.** It has none of these docs and 40k
  tokens of nothing: it needs to know the call worked, that the user is already looking at the
  picture, how to name it later, and not to retry a billed call. It does not need to be asked
  what it can and cannot perceive — that is a QA protocol, and this is a chat. The same goes
  for `serverInstructions` in `librechat.yaml`, which is the same text in a different place.
  Item 9 above has the three ways the visibility line has been got wrong. It now
  says the image should be visible and to describe what is actually there.
- Not every provider even gets that far. `formatToolContent` recognizes providers that
  `StandardGraph` has no merge branch for (DeepSeek, `ollama`), and there the artifact is
  saved for the user and never shown to the model at all. `parsers.ts` now says so in the
  result text; that is a LibreChat-side gap, not a gateway one.
- The rule is **text stays, everything else moves** — not a media-type list — so audio and
  video returned by an MCP tool take the same route without further work. Nothing inspects a
  MIME type; an endpoint that will not take a block answers with a 400 naming it.

## Route selection (OpenRouter)

Two OpenRouter routes reach an image model and they are not interchangeable:

- `POST /api/v1/images` — for models whose catalogue `output_modalities` is
  image-only, `meta/muse-image` among them. Returns `data[0].{b64_json,media_type}`
  and a settled `usage.cost`.
- `POST /api/v1/chat/completions` with `modalities: ["image","text"]` — for models
  that answer in text *and* image (the Gemini `*-image` family), where the image is
  buried in the assistant message in one of three shapes.

`auto` sends anything matching `gemini` down the chat route and everything else to
`/images`.

## Rebuild and test

```bash
cd ~/projects/librechat
docker compose up -d --build mcp-image-gen
(cd mcp-image-gen && npm test)     # registry parsing, size mapping, MIME sniffing
```

It is not part of the api image, so `./scripts/deploy.sh` does **not** rebuild it —
the same as `cost-dashboard/`.
