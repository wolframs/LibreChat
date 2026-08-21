import { createSSEUsageReader, observeAnthropicStreamUsage } from './streamUsage';
import type { ObservedStreamUsage } from './streamUsage';

/** One SSE frame, terminated the way a real stream terminates it. */
function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe('createSSEUsageReader', () => {
  it('reports the input and cache counts a gateway puts on message_delta', () => {
    const seen: ObservedStreamUsage[] = [];
    const reader = createSSEUsageReader((u) => seen.push(u));

    reader.push(frame('message_start', { message: { id: 'msg_1', usage: { input_tokens: 0 } } }));
    reader.push(
      frame('message_delta', {
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 16112 },
      }),
    );

    expect(seen).toEqual([
      {
        id: 'msg_1',
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 16112,
        cacheReadInputTokens: 0,
      },
    ]);
  });

  it('stays silent on a compliant Anthropic stream', () => {
    /** There, message_delta carries only output_tokens and message_start already
     *  gave the parser everything — reporting would be noise, and anything
     *  downstream matching on it would be matching on a record that is fine. */
    const seen: ObservedStreamUsage[] = [];
    const reader = createSSEUsageReader((u) => seen.push(u));

    reader.push(
      frame('message_start', {
        message: { id: 'msg_1', usage: { input_tokens: 4321, cache_read_input_tokens: 900 } },
      }),
    );
    reader.push(frame('message_delta', { usage: { output_tokens: 250 } }));

    expect(seen).toEqual([]);
  });

  it('reads a cache read as readily as a cache write', () => {
    const seen: ObservedStreamUsage[] = [];
    const reader = createSSEUsageReader((u) => seen.push(u));
    reader.push(
      frame('message_delta', {
        usage: { input_tokens: 15, output_tokens: 7, cache_read_input_tokens: 36183 },
      }),
    );
    expect(seen[0]).toMatchObject({ cacheReadInputTokens: 36183, cacheCreationInputTokens: 0 });
  });

  it('reassembles frames split across chunk boundaries', () => {
    /** The transport chops wherever it likes; a frame is not a chunk. */
    const seen: ObservedStreamUsage[] = [];
    const reader = createSSEUsageReader((u) => seen.push(u));
    const whole = frame('message_delta', {
      usage: { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 5000 },
    });
    for (let i = 0; i < whole.length; i += 7) {
      reader.push(whole.slice(i, i + 7));
    }
    reader.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].cacheCreationInputTokens).toBe(5000);
  });

  it('handles CRLF frame separators', () => {
    const seen: ObservedStreamUsage[] = [];
    const reader = createSSEUsageReader((u) => seen.push(u));
    reader.push(
      'event: message_delta\r\ndata: ' +
        JSON.stringify({
          type: 'message_delta',
          usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 100 },
        }) +
        '\r\n\r\n',
    );
    expect(seen).toHaveLength(1);
  });

  it('reads a final frame that arrives without its terminator', () => {
    const seen: ObservedStreamUsage[] = [];
    const reader = createSSEUsageReader((u) => seen.push(u));
    reader.push(
      'data: ' +
        JSON.stringify({ type: 'message_delta', usage: { input_tokens: 8, output_tokens: 1 } }),
    );
    expect(seen).toHaveLength(0);
    reader.flush();
    expect(seen).toHaveLength(1);
  });

  it('ignores frames it cannot parse rather than throwing', () => {
    /** This is an observer riding a live billing path; a malformed frame must
     *  cost nothing more than the observation itself. */
    const seen: ObservedStreamUsage[] = [];
    const reader = createSSEUsageReader((u) => seen.push(u));
    reader.push('data: {not json\n\n');
    reader.push('data: [DONE]\n\n');
    reader.push(': a comment line\n\n');
    reader.push(frame('content_block_delta', { delta: { text: 'hi' } }));
    reader.push(frame('message_delta', { usage: { input_tokens: 5, output_tokens: 1 } }));
    expect(seen).toHaveLength(1);
  });

  it('treats absent, negative and non-numeric counts as zero', () => {
    const seen: ObservedStreamUsage[] = [];
    const reader = createSSEUsageReader((u) => seen.push(u));
    reader.push(
      frame('message_delta', {
        usage: {
          input_tokens: 20,
          output_tokens: null,
          cache_creation_input_tokens: -5,
          cache_read_input_tokens: 'lots',
        },
      }),
    );
    expect(seen[0]).toEqual({
      id: undefined,
      inputTokens: 20,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});

describe('observeAnthropicStreamUsage', () => {
  function sseResponse(body: string): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('observes usage while handing the SDK an intact stream', async () => {
    const seen: ObservedStreamUsage[] = [];
    const body =
      frame('message_start', { message: { id: 'msg_9', usage: { input_tokens: 0 } } }) +
      frame('content_block_delta', { delta: { text: 'ACK' } }) +
      frame('message_delta', {
        usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 6214 },
      });

    const wrapped = observeAnthropicStreamUsage(
      (u) => seen.push(u),
      async () => sseResponse(body),
    );
    const response = await wrapped('https://example.invalid/v1/messages');
    const received = await response.text();

    /** The SDK's copy must be byte-identical — this is on the content path. */
    expect(received).toBe(body);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([
      {
        id: 'msg_9',
        inputTokens: 11,
        outputTokens: 4,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 6214,
      },
    ]);
  });

  it('passes a non-streaming response through untouched', async () => {
    /** Its usage is on the parsed body and reaches the parser intact, so there
     *  is nothing to observe and no reason to tee. */
    const seen: ObservedStreamUsage[] = [];
    const json = new Response(JSON.stringify({ usage: { input_tokens: 5 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const wrapped = observeAnthropicStreamUsage(
      (u) => seen.push(u),
      async () => json,
    );
    const response = await wrapped('https://example.invalid/v1/messages');
    expect(response).toBe(json);
    expect(seen).toEqual([]);
  });

  it('passes an error response through untouched', async () => {
    const seen: ObservedStreamUsage[] = [];
    const err = new Response('{"error":{"message":"nope"}}', {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
    const wrapped = observeAnthropicStreamUsage(
      (u) => seen.push(u),
      async () => err,
    );
    const response = await wrapped('https://example.invalid/v1/messages');
    expect(response.status).toBe(429);
    expect(seen).toEqual([]);
  });

  it('preserves status and headers on the stream it returns', async () => {
    const wrapped = observeAnthropicStreamUsage(
      () => undefined,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
          { status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream', 'x-si-provider-family': 'anthropic' } },
        ),
    );
    const response = await wrapped('https://example.invalid/v1/messages');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-si-provider-family')).toBe('anthropic');
  });
});

describe('getLLMConfig stream-usage gating', () => {
  /**
   * The observer must be genuinely absent, not merely inert, on the direct path.
   * A request straight to api.anthropic.com reports usage where the parser reads
   * it, so there is nothing to recover and no reason to tee its stream — and
   * this is the endpoint carrying almost all of the spend.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getLLMConfig } = require('./llm') as typeof import('./llm');

  it('sets no custom fetch when no sink is supplied', () => {
    const { llmConfig } = getLLMConfig('sk-test', {
      modelOptions: { model: 'claude-sonnet-5' },
    });
    expect((llmConfig.clientOptions as { fetch?: unknown } | undefined)?.fetch).toBeUndefined();
  });

  it('sets one when a sink is supplied', () => {
    const { llmConfig } = getLLMConfig('sk-test', {
      modelOptions: { model: 'claude-sonnet-5' },
      streamUsageSink: () => undefined,
    });
    expect(typeof (llmConfig.clientOptions as { fetch?: unknown }).fetch).toBe('function');
  });
})
