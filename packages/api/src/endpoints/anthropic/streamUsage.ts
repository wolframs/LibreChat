/**
 * Recovers real token usage from an Anthropic-compatible stream that reports it
 * in the wrong frame.
 *
 * Anthropic puts input and cache token counts in `message_start` and only the
 * running output count in `message_delta`. The parser in `@librechat/agents`
 * follows that exactly: its `message_delta` branch reads `usage.output_tokens`
 * and hardcodes `input_tokens: 0`, reading nothing else off that frame.
 *
 * Some gateways stream the other way round — `message_start` carries a
 * `{input_tokens: 0, output_tokens: 0}` placeholder and the true figures,
 * including `cache_creation_input_tokens` and `cache_read_input_tokens`, arrive
 * on `message_delta`. Against such a gateway the parser is not wrong so much as
 * looking in the wrong place, and the numbers are discarded before any object
 * exists to correct: they are not on `usage_metadata`, not on
 * `response_metadata`, not in `additional_kwargs`. The only place they still
 * exist is the raw HTTP body.
 *
 * So this observes the body. `observeAnthropicStreamUsage` wraps a `fetch` so
 * the response is tee'd: one branch is handed to the SDK untouched, the other is
 * read for `message_delta` frames. Nothing is buffered or delayed — the SDK's
 * copy is the original stream object and is unaffected by the read side, so
 * time-to-first-token is unchanged.
 *
 * Recovered figures are reported, never applied here. Deciding whether a
 * collected usage record is missing something, and whether this observation
 * belongs to it, is {@link module:agents/usage}'s job.
 */

/** Real usage read off one streamed response's `message_delta` frame. */
export interface ObservedStreamUsage {
  /** The `message_start` id, when the stream carried one. */
  id?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type StreamUsageSink = (usage: ObservedStreamUsage) => void;

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Feed SSE bytes in, get `message_delta` usage out.
 *
 * Kept as a standalone reducer so the framing rules — events split on a blank
 * line, payload on `data:` lines, a final chunk that may arrive without its
 * terminator — are testable without a network.
 */
export function createSSEUsageReader(report: StreamUsageSink): {
  push: (text: string) => void;
  flush: () => void;
} {
  let buffer = '';
  let messageId: string | undefined;

  const handleEvent = (raw: string): void => {
    const data = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (data === '' || data === '[DONE]') {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      /** A frame we cannot read is a frame we ignore; this is an observer. */
      return;
    }
    if (parsed.type === 'message_start') {
      const message = parsed.message as { id?: unknown } | undefined;
      if (typeof message?.id === 'string') {
        messageId = message.id;
      }
      return;
    }
    if (parsed.type !== 'message_delta') {
      return;
    }
    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (usage == null) {
      return;
    }
    const observed: ObservedStreamUsage = {
      id: messageId,
      inputTokens: toCount(usage.input_tokens),
      outputTokens: toCount(usage.output_tokens),
      cacheCreationInputTokens: toCount(usage.cache_creation_input_tokens),
      cacheReadInputTokens: toCount(usage.cache_read_input_tokens),
    };
    /**
     * A compliant Anthropic stream reaches here every time, carrying only
     * `output_tokens`. Reporting that would be noise at best and, if anything
     * downstream ever matched on it, wrong. Only a frame that actually carries
     * input-side counts is worth reporting, and only such a frame indicates the
     * shape this module exists for.
     */
    if (
      observed.inputTokens === 0 &&
      observed.cacheCreationInputTokens === 0 &&
      observed.cacheReadInputTokens === 0
    ) {
      return;
    }
    report(observed);
  };

  return {
    push(text: string): void {
      buffer += text;
      /** SSE separates events with a blank line; tolerate CRLF. */
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        handleEvent(part);
      }
    },
    flush(): void {
      if (buffer.trim() !== '') {
        handleEvent(buffer);
      }
      buffer = '';
    },
  };
}

/**
 * Wraps `fetch` so streamed Anthropic responses are read for usage on the way
 * past. Non-streaming responses are returned untouched — their usage is on the
 * parsed body and reaches the parser intact.
 */
export function observeAnthropicStreamUsage(
  report: StreamUsageSink,
  baseFetch?: FetchLike,
): FetchLike {
  return async (input: unknown, init?: unknown): Promise<Response> => {
    const doFetch = (baseFetch ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
    const response = await doFetch(input, init);

    const body = response.body;
    const isEventStream = (response.headers?.get('content-type') ?? '').includes('text/event-stream');
    if (body == null || !isEventStream || typeof body.tee !== 'function') {
      return response;
    }

    let forSDK: ReadableStream<Uint8Array>;
    let forUs: ReadableStream<Uint8Array>;
    try {
      [forSDK, forUs] = body.tee();
    } catch {
      /** Cannot observe without risking the real stream — so don't. */
      return response;
    }

    /**
     * Drained independently and deliberately not awaited: the SDK consumes its
     * branch at its own pace and this must not gate it. A tee'd branch that is
     * never read applies backpressure to both, so this loop has to run to
     * completion (or cancel) regardless of what the caller does.
     */
    void (async () => {
      const reader = forUs.getReader();
      const decoder = new TextDecoder();
      const sse = createSSEUsageReader(report);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          sse.push(decoder.decode(value, { stream: true }));
        }
        sse.flush();
      } catch {
        /** An observation that fails costs nothing; the SDK's branch is separate. */
      } finally {
        reader.releaseLock();
      }
    })();

    return new Response(forSDK, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
