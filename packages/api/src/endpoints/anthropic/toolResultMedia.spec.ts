import { liftToolResultMedia, liftToolResultMediaInRequest } from './toolResultMedia';
import { getLLMConfig } from './llm';

/**
 * These assert the shape measured against Surplus Intelligence on 2026-09-07,
 * where an image nested inside a `tool_result` came back "NOIMAGE" and the same
 * image one position away, as a sibling of that block, was described correctly.
 * The header of `toolResultMedia.ts` has the four-request table.
 */

const IMAGE = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/webp', data: 'AAAABBBB' },
};

function toolResult(id: string, content: unknown[]) {
  return { type: 'tool_result', tool_use_id: id, content };
}

function body(content: unknown[]) {
  return {
    model: 'claude-sonnet-4.5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'draw a cat' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'generate_image', input: {} }],
      },
      { role: 'user', content },
    ],
  };
}

describe('liftToolResultMedia', () => {
  it('moves an image out of a tool result to sit beside it', () => {
    const request = body([
      toolResult('toolu_01', [{ type: 'text', text: 'Image generated.' }, IMAGE]),
    ]);

    expect(liftToolResultMedia(request)).toBe(1);

    const content = request.messages[2].content as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(['tool_result', 'image']);
    expect(content[0].content).toEqual([{ type: 'text', text: 'Image generated.' }]);
    expect(content[1]).toEqual(IMAGE);
  });

  it('keeps each image next to the tool result it came from', () => {
    const second = { ...IMAGE, source: { ...IMAGE.source, data: 'CCCCDDDD' } };
    const request = body([
      toolResult('toolu_01', [{ type: 'text', text: 'first' }, IMAGE]),
      toolResult('toolu_02', [{ type: 'text', text: 'second' }, second]),
    ]);

    expect(liftToolResultMedia(request)).toBe(2);

    const content = request.messages[2].content as Array<Record<string, unknown>>;
    expect(content.map((b) => b.type)).toEqual(['tool_result', 'image', 'tool_result', 'image']);
    expect(content[1]).toEqual(IMAGE);
    expect(content[3]).toEqual(second);
  });

  /** An empty tool result is invalid, and would also misreport a call that worked. */
  it('never leaves a tool result empty', () => {
    const request = body([toolResult('toolu_01', [IMAGE])]);

    expect(liftToolResultMedia(request)).toBe(1);

    const content = request.messages[2].content as Array<Record<string, unknown>>;
    expect(content[0].content).toEqual([{ type: 'text', text: 'Attached below.' }]);
    expect(content[1]).toEqual(IMAGE);
  });

  /**
   * Text stays, everything else moves — the rule is not a media-type list, because
   * the OpenAI tool message a gateway adapts to carries text and nothing else.
   */
  it('lifts every non-text block, not just images', () => {
    const doc = { type: 'document', source: { type: 'text', data: 'x' } };
    const audio = { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: 'QQ' } };
    const video = { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'QQ' } };
    const request = body([
      toolResult('toolu_01', [{ type: 'text', text: 'done' }, doc, IMAGE, audio, video]),
    ]);

    expect(liftToolResultMedia(request)).toBe(4);

    const content = request.messages[2].content as Array<Record<string, unknown>>;
    expect(content[0].content).toEqual([{ type: 'text', text: 'done' }]);
    expect(content.map((b) => b.type)).toEqual([
      'tool_result',
      'document',
      'image',
      'audio',
      'video',
    ]);
  });

  it('keeps every text block inside the tool result', () => {
    const request = body([
      toolResult('toolu_01', [
        { type: 'text', text: 'first' },
        IMAGE,
        { type: 'text', text: 'second' },
      ]),
    ]);

    expect(liftToolResultMedia(request)).toBe(1);

    const content = request.messages[2].content as Array<Record<string, unknown>>;
    expect(content[0].content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
    expect(content.map((b) => b.type)).toEqual(['tool_result', 'image']);
  });

  it('does nothing to a request without tool-result images', () => {
    const request = body([toolResult('toolu_01', [{ type: 'text', text: 'no picture' }])]);
    const before = JSON.stringify(request);

    expect(liftToolResultMedia(request)).toBe(0);
    expect(JSON.stringify(request)).toBe(before);
  });

  it('ignores an image that is already a sibling', () => {
    const request = body([toolResult('toolu_01', [{ type: 'text', text: 'ok' }]), IMAGE]);

    expect(liftToolResultMedia(request)).toBe(0);
  });

  it('survives shapes it does not understand', () => {
    expect(liftToolResultMedia(undefined)).toBe(0);
    expect(liftToolResultMedia({ messages: 'not an array' })).toBe(0);
    expect(liftToolResultMedia({ messages: [null, 42, { role: 'user' }] })).toBe(0);
    expect(
      liftToolResultMedia({
        messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'a string' }] }],
      }),
    ).toBe(0);
  });
});

describe('liftToolResultMediaInRequest', () => {
  function capture() {
    const seen: { body?: string } = {};
    const next = jest.fn(async (_input: unknown, init?: unknown) => {
      seen.body = (init as { body?: string } | undefined)?.body;
      return new Response('{}');
    });
    return { seen, next };
  }

  it('rewrites the outgoing body', async () => {
    const { seen, next } = capture();
    const onLift = jest.fn();
    const wrapped = liftToolResultMediaInRequest(next, onLift);

    const request = body([
      toolResult('toolu_01', [{ type: 'text', text: 'Image generated.' }, IMAGE]),
    ]);
    await wrapped('https://gateway.example/v1/messages', {
      method: 'POST',
      body: JSON.stringify(request),
    });

    expect(onLift).toHaveBeenCalledWith(1);
    const sent = JSON.parse(seen.body as string);
    expect(sent.messages[2].content.map((b: { type: string }) => b.type)).toEqual([
      'tool_result',
      'image',
    ]);
  });

  /**
   * The overwhelmingly common request has no tool-result image, and parsing a
   * multi-megabyte body to discover that on every turn would be the wrong
   * trade. It must reach the underlying fetch as the identical object.
   */
  it('passes an ordinary request straight through', async () => {
    const { next } = capture();
    const wrapped = liftToolResultMediaInRequest(next);
    const init = { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user' }] }) };

    await wrapped('https://gateway.example/v1/messages', init);

    expect(next).toHaveBeenCalledWith('https://gateway.example/v1/messages', init);
  });

  it('passes through a body it cannot parse rather than failing the request', async () => {
    const { next } = capture();
    const wrapped = liftToolResultMediaInRequest(next);
    const init = { method: 'POST', body: '{"tool_result" "image" broken' };

    await expect(wrapped('https://gateway.example/v1/messages', init)).resolves.toBeDefined();
    expect(next).toHaveBeenCalledWith('https://gateway.example/v1/messages', init);
  });

  it('passes through a non-string body', async () => {
    const { next } = capture();
    const wrapped = liftToolResultMediaInRequest(next);
    const init = { method: 'POST', body: new Uint8Array([1, 2, 3]) };

    await wrapped('https://gateway.example/v1/messages', init);

    expect(next).toHaveBeenCalledWith('https://gateway.example/v1/messages', init);
  });
});

/**
 * The function being right is half of it; the other half is that it is actually
 * installed, and only where it should be. Both halves have gone wrong on this
 * stack before — a correct sidecar that nothing rebuilt, a correct parser whose
 * output a gateway then discarded — so the wiring gets asserted too.
 */
describe('getLLMConfig wiring', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('installs a lift that rewrites the request a gateway actually receives', async () => {
    const seen: { body?: string } = {};
    global.fetch = jest.fn(async (_input: unknown, init?: unknown) => {
      seen.body = (init as { body?: string } | undefined)?.body;
      return new Response('{}');
    }) as unknown as typeof fetch;

    const { llmConfig } = getLLMConfig('test-api-key', {
      modelOptions: { model: 'claude-sonnet-4.5' },
      reverseProxyUrl: 'https://api.surplusintelligence.ai/anthropic',
    } as Parameters<typeof getLLMConfig>[1]);

    const installed = (llmConfig.clientOptions as { fetch?: unknown }).fetch;
    expect(installed).toEqual(expect.any(Function));

    await (installed as (i: unknown, init: unknown) => Promise<Response>)(
      'https://api.surplusintelligence.ai/anthropic/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify(
          body([toolResult('toolu_01', [{ type: 'text', text: 'Image generated.' }, IMAGE])]),
        ),
      },
    );

    const sent = JSON.parse(seen.body as string);
    expect(sent.messages[2].content.map((b: { type: string }) => b.type)).toEqual([
      'tool_result',
      'image',
    ]);
  });

  /**
   * Against Anthropic's own API the nested shape is correct and delivered, so
   * rewriting it would be meddling with a request that works.
   */
  it('leaves a direct Anthropic request alone', () => {
    const direct = getLLMConfig('test-api-key', {
      modelOptions: { model: 'claude-sonnet-4.5' },
    } as Parameters<typeof getLLMConfig>[1]);
    expect((direct.llmConfig.clientOptions as { fetch?: unknown } | undefined)?.fetch).toBeUndefined();

    const explicit = getLLMConfig('test-api-key', {
      modelOptions: { model: 'claude-sonnet-4.5' },
      reverseProxyUrl: 'https://api.anthropic.com',
    } as Parameters<typeof getLLMConfig>[1]);
    expect(
      (explicit.llmConfig.clientOptions as { fetch?: unknown } | undefined)?.fetch,
    ).toBeUndefined();
  });
});
