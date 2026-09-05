import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { isDocumentSupportedProvider, isOpenAILikeProvider } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions, AudioResult } from '~/types';
import { getFileStream, getConfiguredFileSizeLimit } from './utils';
import { validateAudio } from '~/files/validation';
import { runGuardedEncode } from './memoryGuard';

/**
 * `format` values accepted by the OpenAI-compatible `input_audio` part. OpenAI
 * itself takes only `wav`/`mp3`; OpenRouter and gateways proxying Gemini accept
 * the wider set, so the list is permissive and the provider rejects what it
 * cannot read.
 */
const openAIAudioFormats = new Set([
  'wav',
  'mp3',
  'aiff',
  'aac',
  'ogg',
  'flac',
  'm4a',
  'opus',
  'webm',
  'pcm16',
  'pcm24',
]);

/**
 * MIME types don't map to `format` values by simply dropping the `audio/`
 * prefix (`audio/mpeg` is `mp3`, not `mpeg`), so the filename extension is the
 * first source of truth and this table is the fallback for files uploaded
 * without one.
 */
const mimeToAudioFormat: Record<string, string> = {
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
};

/**
 * Resolves the `format` field of an OpenAI-compatible `input_audio` part.
 * Prefers the filename extension (which is what the provider's own docs
 * enumerate) and falls back to the MIME type the upload was stored with.
 */
function resolveAudioFormat(file: { filename?: string; type: string }): string {
  const ext = file.filename?.split('.').pop()?.toLowerCase();
  if (ext && openAIAudioFormats.has(ext)) {
    return ext;
  }
  const fromMime = mimeToAudioFormat[file.type?.toLowerCase()];
  if (fromMime) {
    return fromMime;
  }
  throw new Error(
    `Could not determine audio format for "${file.filename ?? 'unnamed file'}" (${file.type})`,
  );
}

/**
 * Encodes and formats audio files for different providers
 * @param req - The request object
 * @param files - Array of audio files
 * @param params - Object containing provider and optional endpoint
 * @param params.provider - The provider to format for (currently only google is supported)
 * @param params.endpoint - Optional endpoint name for file config lookup
 * @param getStrategyFunctions - Function to get strategy functions
 * @returns Promise that resolves to audio and file metadata
 */
export async function encodeAndFormatAudios(
  req: ServerRequest,
  files: IMongoFile[],
  params: { provider: Providers; endpoint?: string },
  getStrategyFunctions: (source: string) => StrategyFunctions,
): Promise<AudioResult> {
  const { provider, endpoint } = params;
  if (!files?.length) {
    return { audios: [], files: [] };
  }

  const encodingMethods: Record<string, StrategyFunctions> = {};
  const result: AudioResult = { audios: [], files: [] };

  const results = await Promise.allSettled(
    files.map((file) =>
      runGuardedEncode(file.bytes ?? 0, () =>
        getFileStream(req, file, encodingMethods, getStrategyFunctions),
      ),
    ),
  );

  for (const settledResult of results) {
    if (settledResult.status === 'rejected') {
      console.error('Audio processing failed:', settledResult.reason);
      continue;
    }

    const processed = settledResult.value;
    if (!processed) continue;

    const { file, content, metadata } = processed;

    if (!content || !file) {
      if (metadata) result.files.push(metadata);
      continue;
    }

    if (!file.type.startsWith('audio/') || !isDocumentSupportedProvider(provider)) {
      result.files.push(metadata);
      continue;
    }

    const audioBuffer = Buffer.from(content, 'base64');

    /** Extract configured file size limit from fileConfig for this endpoint */
    const configuredFileSizeLimit = getConfiguredFileSizeLimit(req, {
      provider,
      endpoint,
    });

    const validation = await validateAudio(
      audioBuffer,
      audioBuffer.length,
      provider,
      configuredFileSizeLimit,
    );

    if (!validation.isValid) {
      throw new Error(`Audio validation failed: ${validation.error}`);
    }

    if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
      result.audios.push({
        type: 'media',
        mimeType: file.type,
        data: content,
      });
    } else if (isOpenAILikeProvider(provider)) {
      /**
       * Every OpenAI-compatible destination takes the same `input_audio` part,
       * so this covers custom endpoints and gateways too — `agent.provider` for
       * a custom endpoint resolves to `openai` unless the row names another.
       * Upstream only emitted this for OpenRouter, which meant an audio file
       * attached on any other OpenAI-compatible endpoint was dropped between
       * upload and request with nothing logged and no error shown.
       */
      result.audios.push({
        type: 'input_audio',
        input_audio: {
          data: content,
          format: resolveAudioFormat(file),
        },
      });
    } else {
      /**
       * Anthropic and Bedrock have no audio content block, so the file itself
       * cannot go. Send a text part naming it instead of dropping in silence:
       * without this the model is asked "how do you feel about this track?" with
       * no evidence that a track exists, and answers as though the user simply
       * forgot to attach one. The `file_id` is in the note because it is the
       * argument the audio-ears MCP tool takes — a model with that tool can act
       * on this, and one without it can at least say what it cannot do.
       */
      logger.warn(
        `[encodeAndFormatAudios] Provider "${provider}" has no audio input format; describing "${file.filename}" (${file.type}) instead of sending it.`,
      );
      result.audios.push({
        type: 'text',
        text:
          `[Audio attachment: "${file.filename}" (${file.type}, file_id: ${file.file_id}). ` +
          'You cannot hear this file directly — this model has no audio input. ' +
          'If a tool for listening to audio is available, pass this file_id to it; ' +
          'otherwise tell the user you cannot hear it rather than guessing at its contents.]',
      });
    }

    result.files.push(metadata);
  }

  return result;
}
