import { ErrorTypes } from 'librechat-data-provider';

const mockValidateEndpointURL = jest.fn();
jest.mock('~/auth', () => ({
  validateEndpointURL: (...args: unknown[]) => mockValidateEndpointURL(...args),
}));

import {
  parseUserKeyBlob,
  getActiveProfile,
  resolveUserEndpoint,
  getUserKeyValuesSafe,
} from './profiles';

const PROFILE = {
  id: 'p1',
  name: 'LiteLLM proxy',
  baseURL: 'https://proxy.example.com/v1',
  apiKey: 'sk-profile',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('parseUserKeyBlob', () => {
  it('treats a bare string as the API key (legacy Anthropic/Google shape)', () => {
    expect(parseUserKeyBlob('sk-ant-bare')).toEqual({ apiKey: 'sk-ant-bare' });
  });

  it('parses the JSON object shape', () => {
    expect(parseUserKeyBlob('{"apiKey":"sk-1","baseURL":"https://x/v1"}')).toEqual({
      apiKey: 'sk-1',
      baseURL: 'https://x/v1',
    });
  });

  it('returns null for an absent value', () => {
    expect(parseUserKeyBlob(undefined)).toBeNull();
    expect(parseUserKeyBlob('')).toBeNull();
  });

  it('throws on malformed JSON rather than treating it as a bare key', () => {
    expect(() => parseUserKeyBlob('{"apiKey":')).toThrow(ErrorTypes.INVALID_USER_KEY);
  });
});

describe('getActiveProfile', () => {
  it('returns undefined for the default selection', () => {
    expect(getActiveProfile({ active: 'default', profiles: [PROFILE] })).toBeUndefined();
    expect(getActiveProfile({ profiles: [PROFILE] })).toBeUndefined();
    expect(getActiveProfile(null)).toBeUndefined();
  });

  it('returns the named profile', () => {
    expect(getActiveProfile({ active: 'p1', profiles: [PROFILE] })).toEqual(PROFILE);
  });

  it('returns undefined when the active id no longer exists', () => {
    expect(getActiveProfile({ active: 'deleted', profiles: [PROFILE] })).toBeUndefined();
  });
});

describe('resolveUserEndpoint', () => {
  it('passes the fallbacks through untouched when no profile is active', async () => {
    const result = await resolveUserEndpoint({
      userValues: { apiKey: 'sk-user' },
      fallbackApiKey: 'sk-admin',
      fallbackBaseURL: 'https://api.anthropic.com',
      endpoint: 'anthropic',
    });

    expect(result).toEqual({
      apiKey: 'sk-admin',
      baseURL: 'https://api.anthropic.com',
      baseURLIsUserProvided: false,
    });
    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('lets an active profile override both key and URL', async () => {
    const result = await resolveUserEndpoint({
      userValues: { apiKey: 'sk-user', endpointProfiles: { active: 'p1', profiles: [PROFILE] } },
      fallbackApiKey: 'sk-admin',
      fallbackBaseURL: 'https://api.anthropic.com',
      endpoint: 'anthropic',
    });

    expect(result.apiKey).toBe('sk-profile');
    expect(result.baseURL).toBe(PROFILE.baseURL);
    expect(result.baseURLIsUserProvided).toBe(true);
    expect(result.activeProfile).toEqual(PROFILE);
  });

  it('falls back to the provider key when the profile carries none', async () => {
    const result = await resolveUserEndpoint({
      userValues: {
        endpointProfiles: { active: 'p1', profiles: [{ ...PROFILE, apiKey: undefined }] },
      },
      fallbackApiKey: 'sk-admin',
      endpoint: 'anthropic',
    });

    expect(result.apiKey).toBe('sk-admin');
    expect(result.baseURL).toBe(PROFILE.baseURL);
  });

  it('validates a profile URL against the SSRF guard', async () => {
    await resolveUserEndpoint({
      userValues: { endpointProfiles: { active: 'p1', profiles: [PROFILE] } },
      endpoint: 'anthropic',
      allowedAddresses: ['proxy.lan:8080'],
    });

    expect(mockValidateEndpointURL).toHaveBeenCalledWith(PROFILE.baseURL, 'anthropic', [
      'proxy.lan:8080',
    ]);
  });

  it('propagates a rejected profile URL', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(new Error('blocked'));

    await expect(
      resolveUserEndpoint({
        userValues: { endpointProfiles: { active: 'p1', profiles: [PROFILE] } },
        endpoint: 'anthropic',
      }),
    ).rejects.toThrow('blocked');
  });

  it('does not validate the fallback URL, leaving that to existing call sites', async () => {
    await resolveUserEndpoint({
      fallbackBaseURL: 'https://user-set.example.com/v1',
      fallbackURLIsUserProvided: true,
      endpoint: 'test-custom',
    });

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('ignores a profile with no base URL', async () => {
    const result = await resolveUserEndpoint({
      userValues: {
        endpointProfiles: { active: 'p1', profiles: [{ ...PROFILE, baseURL: '' }] },
      },
      fallbackApiKey: 'sk-admin',
      fallbackBaseURL: 'https://api.anthropic.com',
      endpoint: 'anthropic',
    });

    expect(result.baseURL).toBe('https://api.anthropic.com');
    expect(result.baseURLIsUserProvided).toBe(false);
  });
});

describe('getUserKeyValuesSafe', () => {
  it('returns null when the user has no stored key', async () => {
    const db = {
      getUserKey: jest
        .fn()
        .mockRejectedValue(new Error(JSON.stringify({ type: ErrorTypes.NO_USER_KEY }))),
    };

    await expect(getUserKeyValuesSafe({ db, userId: 'u1', name: 'anthropic' })).resolves.toBeNull();
  });

  it('reads through getUserKey so legacy bare-string blobs still parse', async () => {
    const db = { getUserKey: jest.fn().mockResolvedValue('sk-ant-bare') };

    await expect(getUserKeyValuesSafe({ db, userId: 'u1', name: 'anthropic' })).resolves.toEqual({
      apiKey: 'sk-ant-bare',
    });
  });

  it('rethrows unexpected errors', async () => {
    const db = { getUserKey: jest.fn().mockRejectedValue(new Error('mongo down')) };

    await expect(getUserKeyValuesSafe({ db, userId: 'u1', name: 'anthropic' })).rejects.toThrow(
      'mongo down',
    );
  });

  it('skips the lookup entirely without a user id', async () => {
    const db = { getUserKey: jest.fn() };

    await expect(getUserKeyValuesSafe({ db, userId: '', name: 'anthropic' })).resolves.toBeNull();
    expect(db.getUserKey).not.toHaveBeenCalled();
  });
});
