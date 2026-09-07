import { tool } from '@langchain/core/tools';
import { ToolMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import {
  Providers,
  isOpenAILike,
  isGoogleLike,
  isAnthropicLike,
  formatArtifactPayload,
  formatAnthropicArtifactContent,
} from '@librechat/agents';
import type { BaseMessage } from '@langchain/core/messages';
import type * as t from '../types';
import { formatToolContent } from '../parsers';

/**
 * Does an image an MCP server returns actually reach the model?
 *
 * Twice now a model has reported that it cannot see an image a tool just made,
 * and twice the answer has been re-derived from scratch by reading the whole
 * path — parsers, `MCPManager`, `createToolInstance`, `StandardGraph`, the
 * Anthropic converter — at the cost of an entire agent job each time. The claim
 * ("LibreChat puts the image in the request it sends") lived only in prose, in a
 * sidecar README, where nothing could check it and it aged silently.
 *
 * So it is pinned here instead. Delivery is a chain of four links, three of them
 * in this repo and one at the seam with `@librechat/agents`:
 *
 *   1. `formatToolContent` lifts the `image` block out of the MCP result into
 *      `artifacts.content`, leaving the text behind.
 *   2. LangChain's `content_and_artifact` tool puts that on `ToolMessage.artifact`.
 *   3. `StandardGraph` merges `artifact.content` back into the model's turn —
 *      into the tool message itself on Anthropic, into a following user message
 *      on OpenAI-shaped providers.
 *   4. The provider's converter turns the `image_url` block into a real image.
 *
 * Link 4 belongs to `@librechat/agents` / `@langchain/anthropic` and is tested
 * there. Links 1-3 are ours, and 3 is the one that silently does nothing when a
 * provider falls between the runtime's branches — which is what `parsers.ts`
 * now warns about, and what the last case here covers.
 *
 * If this suite is green and a model still cannot see the image, the loss is
 * downstream of LibreChat: the endpoint or gateway the request was sent to.
 */

const IMAGE_BYTES = Buffer.from('x'.repeat(1200)).toString('base64');
const MIME_TYPE = 'image/webp';

function imageResult(): t.MCPToolCallResponse {
  return {
    content: [
      { type: 'text', text: 'Image generated successfully.' },
      {
        type: 'image',
        data: IMAGE_BYTES,
        mimeType: MIME_TYPE,
        _meta: { 'librechat/file_id': 'server-chosen-id' },
      },
    ],
  } as t.MCPToolCallResponse;
}

/** Mirrors `createToolInstance` in `api/server/services/MCP.js`. */
async function callMCPTool(provider: t.Provider): Promise<ToolMessage> {
  const instance = tool(async () => formatToolContent(imageResult(), provider), {
    name: 'generate_image_mcp_imager',
    description: 'generates an image',
    schema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: [],
    },
    responseFormat: 'content_and_artifact',
  });

  /** `tool()` infers `invoke` from the function's return type and does not model
   *  what `content_and_artifact` actually produces, so narrow it at runtime. */
  const result: unknown = await instance.invoke({
    id: 'toolu_01delivery',
    name: 'generate_image_mcp_imager',
    args: { prompt: 'a cat' },
    type: 'tool_call',
  });
  if (!(result instanceof ToolMessage)) {
    throw new Error('expected a ToolMessage from a content_and_artifact tool');
  }
  return result;
}

function conversation(toolMessage: ToolMessage): BaseMessage[] {
  return [
    new HumanMessage('draw me a cat'),
    new AIMessageChunk({
      content: '',
      tool_calls: [
        { id: 'toolu_01delivery', name: 'generate_image_mcp_imager', args: { prompt: 'a cat' } },
      ],
    }),
    toolMessage,
  ];
}

function imageBlocks(content: BaseMessage['content']): Array<{ image_url: { url: string } }> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is { type: 'image_url'; image_url: { url: string } } =>
      typeof block === 'object' && block != null && block.type === 'image_url',
  );
}

describe('MCP image delivery', () => {
  it('carries an image from an MCP result into the model turn on Anthropic', async () => {
    const toolMessage = await callMCPTool('anthropic' as t.Provider);

    expect(toolMessage.content).toBe('Image generated successfully.');
    expect(toolMessage.artifact?.content).toHaveLength(1);
    expect(toolMessage.artifact?.file_ids).toEqual(['server-chosen-id']);

    const messages = conversation(toolMessage);
    formatAnthropicArtifactContent(messages);

    const merged = messages[messages.length - 1].content;
    expect(Array.isArray(merged)).toBe(true);
    expect((merged as Array<{ type: string }>)[0]).toEqual({
      type: 'text',
      text: 'Image generated successfully.',
    });

    const images = imageBlocks(merged);
    expect(images).toHaveLength(1);
    expect(images[0].image_url.url).toBe(`data:${MIME_TYPE};base64,${IMAGE_BYTES}`);
  });

  it('carries an image into a following user message on OpenAI-shaped providers', async () => {
    const toolMessage = await callMCPTool('openai' as t.Provider);
    const messages = conversation(toolMessage);

    formatArtifactPayload(messages);

    expect(messages).toHaveLength(4);
    const images = imageBlocks(messages[3].content);
    expect(images).toHaveLength(1);
    expect(images[0].image_url.url).toBe(`data:${MIME_TYPE};base64,${IMAGE_BYTES}`);
  });

  it('keeps the base64 payload out of the text on every provider', async () => {
    for (const provider of ['anthropic', 'openai', 'google', 'deepseek', 'unknown-gateway']) {
      const [text] = formatToolContent(imageResult(), provider as t.Provider);
      expect(text).not.toContain(IMAGE_BYTES);
    }
  });

  /**
   * The runtime's three merge branches do not cover every provider
   * `formatToolContent` recognizes. Where they miss, the image is taken out of
   * the text and never put back — so the note `parsers.ts` appends is the only
   * thing standing between the model and a result that describes a picture it
   * was never shown. This asserts the two lists still disagree exactly where we
   * think they do; if `@librechat/agents` gains a branch, this fails and the
   * note should go.
   */
  it('warns the model whenever the runtime will not merge the artifact back', async () => {
    const recognized: t.Provider[] = [
      'google',
      'vertexai',
      'anthropic',
      'openai',
      'azureopenai',
      'openrouter',
      'xai',
      'deepseek',
      'bedrock',
    ];

    const byLowercase = new Map(Object.values(Providers).map((p) => [p.toLowerCase(), p]));

    for (const provider of recognized) {
      const resolved = byLowercase.get(provider) ?? (provider as Providers);
      /** Bedrock's branch is model-dependent and the model is not visible here. */
      const merges =
        resolved === Providers.BEDROCK ||
        isAnthropicLike(resolved) ||
        isGoogleLike(resolved) ||
        (isOpenAILike(resolved) && resolved !== Providers.DEEPSEEK);

      const [text, artifacts] = formatToolContent(imageResult(), provider);

      expect(artifacts?.content).toHaveLength(1);
      expect(text.includes('not delivered to the model')).toBe(!merges);
    }
  });
});
