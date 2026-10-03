import { retainProviderAgnosticParameters, shouldResetProviderParameters } from './ModelPanel';

describe('retainProviderAgnosticParameters', () => {
  it('drops hidden provider request parameters while preserving LibreChat controls', () => {
    expect(
      retainProviderAgnosticParameters({
        topP: 1,
        top_p: 0.7,
        topK: 12,
        promptCache: true,
        maxContextTokens: 128000,
        resendFiles: false,
        fileTokenLimit: 4000,
      }),
    ).toEqual({
      maxContextTokens: 128000,
      resendFiles: false,
      fileTokenLimit: 4000,
    });
  });
});

describe('shouldResetProviderParameters', () => {
  it('resets only when the user selects a different effective provider', () => {
    expect(shouldResetProviderParameters('anthropic', 'openAI')).toBe(true);
    expect(shouldResetProviderParameters('anthropic', 'anthropic')).toBe(false);
  });

  it('does not treat initial form hydration as a provider change', () => {
    expect(shouldResetProviderParameters('', 'anthropic')).toBe(false);
  });
});
