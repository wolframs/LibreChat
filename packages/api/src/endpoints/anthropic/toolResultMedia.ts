/**
 * Moves non-text content out of `tool_result` blocks so a gateway cannot lose it.
 *
 * Anthropic lets an image sit inside a `tool_result`, and that is what
 * LibreChat sends: `StandardGraph` merges a tool's `artifact.content` into the
 * tool message, and `@langchain/anthropic` nests the whole thing under the
 * `tool_result` block. Against `api.anthropic.com` this is correct and the
 * model sees the picture.
 *
 * Against a gateway it is the one shape that does not survive. An image inside
 * a tool result is the newest and least portable corner of the Anthropic
 * schema, and the OpenAI tool message — what most gateways adapt to — has no
 * room for one at all, so an adapter has nowhere to put it and drops it. The
 * request still succeeds. The model still answers. It simply never received the
 * image, and nothing anywhere says so: the user is looking at the picture in
 * the chat while the model apologises for failing to make it, or invents a
 * description to match a tool result claiming success.
 *
 * Measured on Surplus Intelligence, 2026-09-07, four requests differing only in
 * where the image block sat. A 200x200 magenta PNG, asked for one word:
 *
 *   plain user message, no tools        -> "Magenta"     (110 input tokens)
 *   nested inside `tool_result`         -> "NOIMAGE"     (667)
 *   sibling of `tool_result`, same turn -> "magenta"     (735)
 *   in a following user message         -> "magenta"     (741)
 *
 * So the gateway carries images perfectly well; it loses them in exactly one
 * position. The ~70-token gap is the image, absent from the second request.
 *
 * Images were simply the first case to be noticed. The OpenAI tool message a
 * gateway adapts to holds text and nothing else, so audio and video nested in a
 * tool result are lost by the same mechanism — hence text stays and everything
 * else moves, rather than an allowlist of media types.
 *
 * This lifts each block out of its `tool_result` and re-inserts it immediately
 * after, as a sibling block in the same user turn — the third row above. That
 * shape was chosen over the fourth for being the smaller edit: no new message,
 * so role alternation, the tool_use/tool_result adjacency rule and the
 * relative order of any `cache_control` markers are all untouched. Anthropic
 * accepts a user turn holding a `tool_result` and an image side by side, and an
 * OpenAI-shaped adapter maps that to an ordinary vision part.
 *
 * It runs on the serialized body rather than in the graph deliberately. The
 * alternative was flipping `@librechat/agents`' artifact dispatch, and the flag
 * that selects it (`anthropicLike`) also gates `sanitizeOrphanToolBlocks` — so
 * that route changes graph behaviour to fix a wire-format problem. Here the
 * bytes are the only thing that changes, at the last point before they leave.
 */

type JsonObject = Record<string, unknown>;

/** A `fetch` as the Anthropic SDK supplies and expects it back. */
type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlockOfType(value: unknown, type: string): value is JsonObject {
  return isObject(value) && value.type === type;
}

/**
 * Split a `tool_result`'s content into what stays and what is lifted out.
 *
 * **Text stays, everything else moves.** Stated that way round on purpose: the
 * reason a nested block is lost is that the OpenAI tool message a gateway adapts
 * to carries text and nothing else, so *anything* that is not text is at risk in
 * that position, and an allowlist of media types would just be a list of the
 * ones someone happened to think of. Images were the first to be noticed; audio
 * and video reach the same place by the same route.
 *
 * Nothing here inspects a MIME type or decides what the destination supports.
 * If a lifted block is one the endpoint does not accept, it answers with a 400
 * naming it — which is a better failure than this function quietly deciding the
 * model gets nothing, and is the failure the previous shape had.
 */
function partitionToolResultContent(content: unknown[]): {
  kept: unknown[];
  lifted: unknown[];
} {
  const kept: unknown[] = [];
  const lifted: unknown[] = [];
  for (const block of content) {
    if (isObject(block) && block.type !== 'text') {
      lifted.push(block);
    } else {
      kept.push(block);
    }
  }
  return { kept, lifted };
}

/**
 * Rewrite one message's content array, lifting media out of every tool result.
 *
 * Each block is re-inserted directly after the tool result it came from, so a
 * turn carrying several tool results keeps each one's media next to it — the
 * model has no other way to tell which result a picture belongs to.
 */
function liftInMessageContent(content: unknown[]): { content: unknown[]; moved: number } {
  let moved = 0;
  const next: unknown[] = [];

  for (const block of content) {
    if (!isBlockOfType(block, 'tool_result') || !Array.isArray(block.content)) {
      next.push(block);
      continue;
    }

    const { kept, lifted } = partitionToolResultContent(block.content);
    if (lifted.length === 0) {
      next.push(block);
      continue;
    }

    /**
     * A `tool_result` whose only content was the media would be left empty, and
     * an empty tool result is both invalid and a lie — the call succeeded. Say
     * what happened instead; the content is one block further along.
     */
    next.push({
      ...block,
      content: kept.length > 0 ? kept : [{ type: 'text', text: 'Attached below.' }],
    });
    next.push(...lifted);
    moved += lifted.length;
  }

  return { content: next, moved };
}

/**
 * Lift every `tool_result`'s non-text content in an Anthropic request body,
 * in place.
 *
 * Returns how many moved, so a caller can log the interesting case and stay
 * silent on the overwhelmingly common one where nothing did.
 */
export function liftToolResultMedia(body: unknown): number {
  if (!isObject(body) || !Array.isArray(body.messages)) {
    return 0;
  }

  let moved = 0;
  for (const message of body.messages) {
    /** `tool_result` blocks only ever appear on a user turn. */
    if (!isObject(message) || message.role !== 'user' || !Array.isArray(message.content)) {
      continue;
    }
    const result = liftInMessageContent(message.content);
    if (result.moved > 0) {
      message.content = result.content;
      moved += result.moved;
    }
  }
  return moved;
}

/**
 * Cheap reject for the ordinary request.
 *
 * A body carrying tool-result media is often megabytes of base64, and parsing
 * every request only to find it has none would be paid on every turn of every
 * conversation. No tool result, nothing to do.
 */
function mightCarryNestedMedia(body: string): boolean {
  return body.includes('"tool_result"');
}

/**
 * Wrap a `fetch` so outgoing Anthropic requests get their tool-result media
 * lifted out.
 *
 * Composes with the other wrapper on this path (`observeAnthropicStreamUsage`)
 * by taking the fetch it is given and returning one of the same shape. Anything
 * unexpected — a non-string body, a body that will not parse, a shape without
 * `messages` — is passed through untouched: this is a delivery improvement, and
 * failing to make it must never cost the request itself.
 */
export function liftToolResultMediaInRequest(
  next?: FetchLike,
  onLift?: (moved: number) => void,
): FetchLike {
  const base: FetchLike = next ?? ((input, init) => fetch(input as string, init as RequestInit));

  return async function liftingFetch(input: unknown, init?: unknown): Promise<Response> {
    if (!isObject(init) || typeof init.body !== 'string' || !mightCarryNestedMedia(init.body)) {
      return base(input, init);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }

    const moved = liftToolResultMedia(parsed);
    if (moved === 0) {
      return base(input, init);
    }

    onLift?.(moved);
    return base(input, { ...init, body: JSON.stringify(parsed) });
  };
}
