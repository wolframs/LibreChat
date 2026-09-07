import crypto from 'node:crypto';
import { Tools } from 'librechat-data-provider';
import { Providers, isOpenAILike, isGoogleLike, isAnthropicLike } from '@librechat/agents';
import type { UIResource } from 'librechat-data-provider';
import type * as t from './types';

export const DEFAULT_MCP_IMAGE_DATA_MAX_BYTES: number = 10 * 1024 * 1024;

function generateResourceId(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 10);
}

function getMCPImageDataMaxBytes(): number {
  const raw = process.env.MCP_IMAGE_DATA_MAX_BYTES;
  if (!raw) {
    return DEFAULT_MCP_IMAGE_DATA_MAX_BYTES;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_IMAGE_DATA_MAX_BYTES;
}

function getBase64Padding(data: string): number {
  if (data.endsWith('==')) {
    return 2;
  }
  if (data.endsWith('=')) {
    return 1;
  }
  return 0;
}

function estimateBase64Bytes(data: string): number {
  const padding = getBase64Padding(data);
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function isRemoteImageUrl(data: string): boolean {
  return data.startsWith('http://') || data.startsWith('https://');
}

const IMAGE_MIME_PREFIX = 'image/';

/**
 * An image lifted out of whichever content block carried it, so an `image` block
 * and an image-typed embedded `resource` take the same path to `artifacts`.
 */
interface InlineImage {
  data: string;
  mimeType: string;
  fileId?: string;
}

/**
 * Returns a note when an image is too large to inline, or undefined when it fits.
 *
 * This used to throw — out of `formatToolContent`, through `MCPManager.callTool`,
 * and out of the tool as `tool call failed` — which discarded every *text* block
 * the same result carried. A server that described what it had produced and
 * attached an oversized image left the model with nothing but a failure, for a
 * call that had already succeeded and already been billed. The cap exists to keep
 * an unbounded payload out of the request; dropping the one block that breaches
 * it does that, and says so, without throwing away everything said alongside it.
 */
function oversizedImageNote(image: InlineImage): string | undefined {
  if (isRemoteImageUrl(image.data)) {
    return undefined;
  }

  const maxBytes = getMCPImageDataMaxBytes();
  const bytes = estimateBase64Bytes(image.data);
  if (bytes <= maxBytes) {
    return undefined;
  }

  return (
    `[image not delivered: ${image.mimeType}, ~${bytes} bytes, over the ${maxBytes}-byte ` +
    'MCP_IMAGE_DATA_MAX_BYTES limit. It is not attached to this result and the model ' +
    'cannot see it; generating it again will produce the same outcome.]'
  );
}

/**
 * Audio has nowhere to go in a tool result: `FormattedContent` has no audio
 * member, and neither the Anthropic nor the OpenAI tool-result shape accepts one
 * — audio rides user turns only, and only on some providers. Before this, an
 * `audio` block fell through to `JSON.stringify` and put its entire base64
 * payload into the model's context: a two-megabyte recording is ~2.7 million
 * characters of text no model can decode, billed as input. Name it instead.
 */
function describeAudio(item: t.AudioContent): string {
  return (
    `[audio not delivered: ${item.mimeType}, ~${estimateBase64Bytes(item.data)} bytes. ` +
    'A tool result has no audio channel on any provider, so the model cannot hear it.]'
  );
}

/**
 * On the string-only path (unrecognized providers) there is no artifact channel,
 * so the bytes cannot reach the model however they are formatted — pasting the
 * base64 into the prompt only buys a token bill. A remote URL is worth keeping:
 * it is short, and the model can act on it.
 */
function describeUndeliverableImage(item: t.ImageContent): string {
  if (isRemoteImageUrl(item.data)) {
    return `[image: ${item.mimeType} at ${item.data} — not attached to this result.]`;
  }
  return (
    `[image not delivered: ${item.mimeType}, ~${estimateBase64Bytes(item.data)} bytes. ` +
    'This provider has no image channel for tool results, so the model cannot see it.]'
  );
}

/**
 * Whether the agent runtime will merge an image artifact back into the model's
 * turn for this provider.
 *
 * Moving an image into `artifacts` is only half of delivering it. `StandardGraph`
 * decides separately, per provider, whether to merge `artifact.content` into the
 * tool message (`formatAnthropicArtifactContent`) or into a following user
 * message (`formatArtifactPayload`) — and its branches do not cover every
 * provider recognized here. Where they miss, the image is taken out of the text,
 * saved as a file for the user, and never put in front of the model: the result
 * describes a picture the model was never shown, and nothing says so. That is the
 * same silence the oversize path used to have, in a second place.
 *
 * Derived from the runtime's own exported predicates rather than restated, so it
 * cannot drift out of step with them. Two wrinkles: `provider` arrives lowercased
 * from `createToolInstance`, which would miss the camelCase `Providers` members
 * (`openAI`, `azureOpenAI`); and Bedrock's branch turns on whether the model is a
 * Claude, which is not visible here — assume delivery, because telling a model it
 * cannot see an image it is looking at is the worse of the two errors.
 */
const PROVIDERS_BY_LOWERCASE: Map<string, Providers> = new Map(
  Object.values(Providers).map((provider) => [provider.toLowerCase(), provider]),
);

function deliversImageArtifacts(provider: t.Provider): boolean {
  const resolved = PROVIDERS_BY_LOWERCASE.get(provider.toLowerCase()) ?? (provider as Providers);
  if (resolved === Providers.BEDROCK || isAnthropicLike(resolved) || isGoogleLike(resolved)) {
    return true;
  }
  return isOpenAILike(resolved) && resolved !== Providers.DEEPSEEK;
}

/**
 * The image is saved and shown in the chat, so it is not lost to the user — but
 * on this provider it never enters the model's context. Says both halves, because
 * "it is displayed in the chat" and "you can see it" are different claims and the
 * model has no way to tell them apart from the inside.
 */
function describeUserOnlyImage(image: InlineImage): string {
  const what = isRemoteImageUrl(image.data)
    ? `${image.mimeType} at ${image.data}`
    : `${image.mimeType}, ~${estimateBase64Bytes(image.data)} bytes`;
  return (
    `[image not delivered to the model: ${what}. It is saved and displayed in the chat, so the ` +
    'user can see it, but this provider has no image channel for tool results and the model ' +
    'cannot. Describe what was asked for rather than what was produced.]'
  );
}

const MAX_STRINGIFIED_STRING_CHARS = 512;

/**
 * `JSON.stringify` for a content block we have no handler for, with any oversized
 * string field replaced by its length. The MCP content union grows over time and
 * every new member arrives here first, so this is the one place a whole base64
 * payload can still reach the prompt by accident.
 */
function stringifyContentPart(item: t.ToolContentPart): string {
  return JSON.stringify(
    item,
    (_key: string, value: unknown) =>
      typeof value === 'string' && value.length > MAX_STRINGIFIED_STRING_CHARS
        ? `[${value.length} characters omitted]`
        : value,
    2,
  );
}

type ResourceContents = t.EmbeddedResource['resource'];
type BlobResource = Extract<ResourceContents, { blob: string }>;

function isBlobResource(resource: ResourceContents): resource is BlobResource {
  return 'blob' in resource && typeof resource.blob === 'string' && resource.blob.length > 0;
}

/**
 * `vertexai` belongs here for the same reason `google` does: everything
 * downstream already treats the two as one. `isGoogleLike` in the agents package
 * merges artifacts for both, and `createToolInstance` sanitizes tool schemas for
 * both. Its absence meant a Vertex request took `parseAsString`, which put the
 * image's base64 in the text and produced no artifact — no attachment for the
 * user, nothing decodable for the model, and the tokens billed anyway.
 */
const RECOGNIZED_PROVIDERS = new Set([
  'google',
  'vertexai',
  'anthropic',
  'openai',
  'azureopenai',
  'openrouter',
  'xai',
  'deepseek',
  'ollama',
  'bedrock',
]);

const imageFormatters: Record<string, undefined | t.ImageFormatter> = {
  // google: (item) => ({
  //   type: 'image',
  //   inlineData: {
  //     mimeType: item.mimeType,
  //     data: item.data,
  //   },
  // }),
  // anthropic: (item) => ({
  //   type: 'image',
  //   source: {
  //     type: 'base64',
  //     media_type: item.mimeType,
  //     data: item.data,
  //   },
  // }),
  default: (item) => ({
    type: 'image_url',
    image_url: {
      url: isRemoteImageUrl(item.data) ? item.data : `data:${item.mimeType};base64,${item.data}`,
    },
  }),
};

function isImageContent(item: t.ToolContentPart): item is t.ImageContent {
  return item.type === 'image';
}

/**
 * A server-chosen file_id for an image result, read from the content block's `_meta`.
 *
 * An MCP server that returns an image has no way of knowing what it will be called
 * afterwards: `createToolEndCallback` hands the block to `saveBase64Image`, which
 * mints a v4 when none is supplied and reports it to nobody. So a server that wants
 * to name the id in its own text result — "pass this back as reference_image_url to
 * edit the image you just made" — cannot, and the model has to spend a second tool
 * call listing files to find what it just produced.
 *
 * `_meta` is the MCP-sanctioned place for exactly this (it survives both SDK
 * schemas untouched), and `artifact.file_ids` is already the channel
 * `createToolEndCallback` reads, index-aligned with `artifact.content`. This just
 * connects the two. Anything not a plain non-empty string is ignored.
 */
function readMetaFileId(meta: Record<string, unknown> | undefined): string | undefined {
  const value = meta?.['librechat/file_id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseAsString(result: t.MCPToolCallResponse): string {
  const content = result?.content ?? [];
  if (!content.length) {
    return '(No response)';
  }

  const text = content
    .map((item) => {
      if (item.type === 'text') {
        return item.text;
      }
      if (item.type === 'resource') {
        const resourceText = [];
        if ('text' in item.resource && item.resource.text != null && item.resource.text) {
          resourceText.push(item.resource.text);
        } else if (isBlobResource(item.resource)) {
          resourceText.push(
            `Resource Data: ~${estimateBase64Bytes(item.resource.blob)} bytes, not delivered inline.`,
          );
        }
        if (item.resource.uri) {
          resourceText.push(`Resource URI: ${item.resource.uri}`);
        }
        if (item.resource.mimeType != null && item.resource.mimeType) {
          resourceText.push(`Type: ${item.resource.mimeType}`);
        }
        return resourceText.join('\n');
      }
      if (isImageContent(item)) {
        return describeUndeliverableImage(item);
      }
      if (item.type === 'audio') {
        return describeAudio(item);
      }
      return stringifyContentPart(item);
    })
    .filter(Boolean)
    .join('\n\n');

  return text;
}

/**
 * Converts MCPToolCallResponse content into a plain-text string plus optional artifacts
 * (images, UI resources). All providers receive string content; images are separated into
 * artifacts and merged back by the agents package via formatArtifactPayload / formatAnthropicArtifactContent.
 *
 * @param provider - Used only to distinguish recognized vs. unrecognized providers.
 * All recognized providers currently produce identical string output;
 * provider-specific artifact merging is delegated to the agents package.
 */
export function formatToolContent(
  result: t.MCPToolCallResponse,
  provider: t.Provider,
): t.FormattedContentResult {
  if (!RECOGNIZED_PROVIDERS.has(provider)) {
    return [parseAsString(result), undefined];
  }

  const content = result?.content ?? [];
  if (!content.length) {
    return ['(No response)', undefined];
  }

  const imageUrls: t.FormattedContent[] = [];
  /** Index-aligned with `imageUrls`; a slot is undefined when the server named no id. */
  const imageFileIds: (string | undefined)[] = [];
  const uiResources: UIResource[] = [];
  const artifactsReachTheModel = deliversImageArtifacts(provider);
  let currentTextBlock = '';

  const appendText = (text: string): void => {
    currentTextBlock += (currentTextBlock ? '\n\n' : '') + text;
  };

  const collectImage = (image: InlineImage): void => {
    const note = oversizedImageNote(image);
    if (note != null) {
      appendText(note);
      return;
    }

    const formatter = imageFormatters.default as t.ImageFormatter;
    const formattedImage = formatter({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType,
    });
    if (formattedImage.type !== 'image_url') {
      return;
    }

    imageUrls.push(formattedImage);
    imageFileIds.push(image.fileId);

    if (!artifactsReachTheModel) {
      appendText(describeUserOnlyImage(image));
    }
  };

  type ContentHandler = undefined | ((item: t.ToolContentPart) => void);

  const contentHandlers: {
    text: (item: Extract<t.ToolContentPart, { type: 'text' }>) => void;
    image: (item: t.ToolContentPart) => void;
    audio: (item: Extract<t.ToolContentPart, { type: 'audio' }>) => void;
    resource: (item: Extract<t.ToolContentPart, { type: 'resource' }>) => void;
  } = {
    text: (item) => {
      appendText(item.text);
    },

    image: (item) => {
      if (!isImageContent(item)) {
        return;
      }
      collectImage({
        data: item.data,
        mimeType: item.mimeType,
        fileId: readMetaFileId(item._meta),
      });
    },

    audio: (item) => {
      appendText(describeAudio(item));
    },

    resource: (item) => {
      const isUiResource = item.resource.uri.startsWith('ui://');
      const resourceText: string[] = [];

      if (isUiResource) {
        const contentToHash =
          'text' in item.resource && item.resource.text && typeof item.resource.text === 'string'
            ? item.resource.text
            : item.resource.uri;
        const resourceId = generateResourceId(contentToHash);
        const uiResource: UIResource = {
          ...item.resource,
          resourceId,
        };
        uiResources.push(uiResource);
        resourceText.push(`UI Resource ID: ${resourceId}`);
        resourceText.push(`UI Resource Marker: \\ui{${resourceId}}`);
      } else if ('text' in item.resource && item.resource.text != null && item.resource.text) {
        resourceText.push(`Resource Text: ${item.resource.text}`);
      } else if (isBlobResource(item.resource)) {
        /**
         * An embedded resource is the MCP-sanctioned way to return an image that
         * also has a URI, and servers use it. Routing the blob through the same
         * artifact path as an `image` block is what makes it visible: without
         * this the model was handed "Resource URI: …" and the bytes were dropped
         * on the floor — not attached for the user, not sent to the model.
         */
        const { mimeType } = item.resource;
        if (mimeType != null && mimeType.startsWith(IMAGE_MIME_PREFIX)) {
          collectImage({
            data: item.resource.blob,
            mimeType,
            fileId: readMetaFileId(item._meta) ?? readMetaFileId(item.resource._meta),
          });
        } else {
          resourceText.push(
            `Resource Data: ~${estimateBase64Bytes(item.resource.blob)} bytes, not delivered inline.`,
          );
        }
      }

      if (item.resource.uri.length) {
        resourceText.push(`Resource URI: ${item.resource.uri}`);
      }
      if (item.resource.mimeType != null && item.resource.mimeType) {
        resourceText.push(`Resource MIME Type: ${item.resource.mimeType}`);
      }

      if (resourceText.length) {
        appendText(resourceText.join('\n'));
      }
    },
  };

  for (const item of content) {
    const handler = contentHandlers[item.type as keyof typeof contentHandlers] as ContentHandler;
    if (handler) {
      handler(item as never);
    } else {
      appendText(stringifyContentPart(item));
    }
  }

  if (uiResources.length > 0) {
    const uiInstructions = `

UI Resource Markers Available:
- Each resource above includes a stable ID and a marker hint like \`\\ui{abc123}\`
- You should usually introduce what you're showing before placing the marker
- For a single resource: \\ui{resource-id}
- For multiple resources shown separately: \\ui{resource-id-a} \\ui{resource-id-b}
- For multiple resources in a carousel: \\ui{resource-id-a,resource-id-b,resource-id-c}
- The UI will be rendered inline where you place the marker
- Format: \\ui{resource-id} or \\ui{id1,id2,id3} using the IDs provided above`;

    currentTextBlock += uiInstructions;
  }

  let artifacts: t.Artifacts = undefined;
  if (imageUrls.length > 0) {
    artifacts = { content: imageUrls };
    // Only carried when at least one server actually named an id; an all-undefined
    // array would make `saveBase64Image` behave identically while looking meaningful.
    if (imageFileIds.some((id) => id !== undefined)) {
      artifacts.file_ids = imageFileIds as string[];
    }
  }

  if (uiResources.length > 0) {
    artifacts = {
      ...artifacts,
      [Tools.ui_resources]: { data: uiResources },
    };
  }

  return [currentTextBlock || (artifacts !== undefined ? '' : '(No response)'), artifacts];
}
