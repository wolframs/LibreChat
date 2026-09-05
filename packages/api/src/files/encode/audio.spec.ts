import { Providers } from '@librechat/agents';
import { Types } from 'mongoose';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { encodeAndFormatAudios } from './audio';

jest.mock('~/files/validation', () => ({
  validateAudio: jest.fn(),
}));

jest.mock('./utils', () => ({
  getFileStream: jest.fn(),
  getConfiguredFileSizeLimit: jest.fn(),
}));

import { validateAudio } from '~/files/validation';
import { getFileStream, getConfiguredFileSizeLimit } from './utils';

const mockedValidateAudio = validateAudio as jest.MockedFunction<typeof validateAudio>;
const mockedGetFileStream = getFileStream as jest.MockedFunction<typeof getFileStream>;
const mockedGetConfiguredFileSizeLimit = getConfiguredFileSizeLimit as jest.MockedFunction<
  typeof getConfiguredFileSizeLimit
>;

const CONTENT = 'SUQzBAAAAAA=';

const createMockFile = (filename: string, type: string): IMongoFile =>
  ({
    _id: new Types.ObjectId(),
    user: new Types.ObjectId(),
    file_id: 'audio-1',
    filename,
    filepath: `/uploads/${filename}`,
    type,
    bytes: 1024,
    object: 'file',
    embedded: false,
    usage: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as IMongoFile;

const run = (file: IMongoFile, provider: Providers) =>
  encodeAndFormatAudios(
    {} as ServerRequest,
    [file],
    { provider },
    jest.fn() as unknown as Parameters<typeof encodeAndFormatAudios>[3],
  );

describe('encodeAndFormatAudios', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetConfiguredFileSizeLimit.mockReturnValue(undefined);
    mockedValidateAudio.mockResolvedValue({ isValid: true });
    mockedGetFileStream.mockImplementation(async (_req, file) => ({
      file,
      content: CONTENT,
      metadata: {
        file_id: file.file_id,
        filepath: file.filepath,
        filename: file.filename,
        type: file.type,
      },
    }));
  });

  it.each([
    [Providers.OPENAI, 'a custom endpoint or OpenAI itself'],
    [Providers.OPENROUTER, 'OpenRouter'],
    [Providers.XAI, 'xAI'],
  ])('emits an input_audio part for %s (%s)', async (provider) => {
    const result = await run(createMockFile('track.mp3', 'audio/mpeg'), provider as Providers);
    expect(result.audios).toEqual([
      { type: 'input_audio', input_audio: { data: CONTENT, format: 'mp3' } },
    ]);
  });

  it('emits a media part for Google', async () => {
    const result = await run(createMockFile('track.mp3', 'audio/mpeg'), Providers.GOOGLE);
    expect(result.audios).toEqual([{ type: 'media', mimeType: 'audio/mpeg', data: CONTENT }]);
  });

  it('falls back to the MIME type when the filename carries no usable extension', async () => {
    const result = await run(createMockFile('voice-memo', 'audio/mpeg'), Providers.OPENAI);
    expect(result.audios).toEqual([
      { type: 'input_audio', input_audio: { data: CONTENT, format: 'mp3' } },
    ]);
  });

  it('maps audio/x-m4a to the m4a format value', async () => {
    const result = await run(createMockFile('clip.M4A', 'audio/x-m4a'), Providers.OPENAI);
    expect(result.audios[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: CONTENT, format: 'm4a' },
    });
  });

  it('sends a naming note instead of the file where no audio block exists', async () => {
    const result = await run(createMockFile('track.mp3', 'audio/mpeg'), Providers.ANTHROPIC);
    expect(result.audios).toHaveLength(1);
    const note = result.audios[0] as { type: string; text: string };
    expect(note.type).toBe('text');
    expect(note.text).toContain('track.mp3');
    expect(note.text).toContain('audio-1');
    expect(note.text).not.toContain(CONTENT);
    expect(result.files).toHaveLength(1);
  });
});
