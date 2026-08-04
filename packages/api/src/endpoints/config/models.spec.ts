import { AuthType, EModelEndpoint } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';

const mockValidateEndpointURL = jest.fn().mockResolvedValue(undefined);
jest.mock('~/auth', () => ({
  validateEndpointURL: (...args: unknown[]) => mockValidateEndpointURL(...args),
}));

jest.mock('~/utils', () => {
  const original = jest.requireActual('~/utils');
  return {
    ...original,
    // Inline literal — jest.mock() factory may not reference imports.
    isUserProvided: (val: string) => val === 'user_provided',
  };
});

import { SCOPED_TOKEN_CONFIG_KEY_PREFIX } from '../keys';
import { createLoadConfigModels } from './models';

describe('createLoadConfigModels – user-provided baseURL header guard', () => {
  const fetchModels = jest.fn().mockResolvedValue([]);

  const buildAppConfig = (endpointOverrides: Record<string, unknown>) => ({
    endpoints: {
      [EModelEndpoint.custom]: [
        {
          name: 'TestProxy',
          baseURL: AuthType.USER_PROVIDED,
          apiKey: AuthType.USER_PROVIDED,
          models: { fetch: true },
          ...endpointOverrides,
        },
      ],
    },
  });

  beforeEach(() => {
    fetchModels.mockReset().mockResolvedValue([]);
    mockValidateEndpointURL.mockReset().mockResolvedValue(undefined);
  });

  it('does NOT forward configured headers when baseURL is user-provided', async () => {
    const headers = {
      Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}',
      'X-User-Email': '{{LIBRECHAT_USER_EMAIL}}',
    };

    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(buildAppConfig({ headers })),
      getUserKeyValues: jest.fn().mockResolvedValue({
        apiKey: 'sk-user-key',
        baseURL: 'https://user-controlled.example.com/v1',
      }),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1', email: 'user@example.com' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(mockValidateEndpointURL).toHaveBeenCalledWith(
      'https://user-controlled.example.com/v1',
      'TestProxy',
      undefined,
    );
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TestProxy',
        baseURL: 'https://user-controlled.example.com/v1',
        baseURLIsUserProvided: true,
        headers: undefined,
      }),
    );
  });

  it('uses the user API key when baseURL is user-provided', async () => {
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(
        buildAppConfig({
          apiKey: 'sk-system-key',
        }),
      ),
      getUserKeyValues: jest.fn().mockResolvedValue({
        apiKey: 'sk-user-key',
        baseURL: 'https://user-controlled.example.com/v1',
      }),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1', email: 'user@example.com' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TestProxy',
        apiKey: 'sk-user-key',
        baseURL: 'https://user-controlled.example.com/v1',
      }),
    );
    expect(fetchModels).not.toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-system-key',
      }),
    );
  });

  it('does NOT call fetchModels when user-provided baseURL validation fails', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(new Error('blocked SSRF target'));

    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(buildAppConfig({})),
      getUserKeyValues: jest.fn().mockResolvedValue({
        apiKey: 'sk-user-key',
        baseURL: 'http://127.0.0.1:11434/v1',
      }),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1' },
      config: undefined,
    } as unknown as ServerRequest;

    const modelsConfig = await loadConfigModels(req);

    expect(fetchModels).not.toHaveBeenCalled();
    expect(modelsConfig.TestProxy).toEqual([]);
  });

  it('DOES forward configured headers when baseURL is admin-trusted (only apiKey is user-provided)', async () => {
    const headers = {
      Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}',
    };

    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'TrustedProxy',
              baseURL: 'https://admin-trusted.example.com/v1',
              apiKey: AuthType.USER_PROVIDED,
              models: { fetch: true },
              headers,
            },
          ],
        },
      }),
      getUserKeyValues: jest.fn().mockResolvedValue({
        apiKey: 'sk-user-key',
        baseURL: undefined,
      }),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'TrustedProxy',
        baseURL: 'https://admin-trusted.example.com/v1',
        baseURLIsUserProvided: false,
        headers,
      }),
    );
  });

  it('tenant-scopes the fetched token config cache key for system-defined endpoints', async () => {
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(
        buildAppConfig({
          baseURL: 'https://admin-trusted.example.com/v1',
          apiKey: 'sk-system-key',
        }),
      ),
      getUserKeyValues: jest.fn(),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1', tenantId: 'tenant-a' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(1);
    const tokenKey = fetchModels.mock.calls[0][0].tokenKey;
    expect(fetchModels.mock.calls[0][0].name).toBe('TestProxy');
    expect(tokenKey.startsWith(SCOPED_TOKEN_CONFIG_KEY_PREFIX)).toBe(true);
    expect(tokenKey).not.toBe('tenant:tenant-a:TestProxy');
    expect(tokenKey).not.toContain('tenant-a');
    expect(tokenKey).not.toContain('TestProxy');
  });
});

describe('createLoadConfigModels – in-request fetch coalescing', () => {
  const fetchModels = jest.fn().mockResolvedValue([]);

  beforeEach(() => {
    fetchModels.mockReset().mockResolvedValue([]);
  });

  it('does NOT coalesce two endpoints with the same baseURL+apiKey but different headers', async () => {
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'TenantA',
              baseURL: 'https://shared-proxy.example.com/v1',
              apiKey: 'sk-shared',
              models: { fetch: true },
              headers: { 'X-Tenant': 'a' },
            },
            {
              name: 'TenantB',
              baseURL: 'https://shared-proxy.example.com/v1',
              apiKey: 'sk-shared',
              models: { fetch: true },
              headers: { 'X-Tenant': 'b' },
            },
          ],
        },
      }),
      getUserKeyValues: jest.fn(),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    expect(fetchModels).toHaveBeenCalledTimes(2);
    const headersByName = new Map<string, Record<string, string> | undefined>();
    for (const call of fetchModels.mock.calls) {
      headersByName.set(call[0].name, call[0].headers);
    }
    expect(headersByName.get('TenantA')).toEqual({ 'X-Tenant': 'a' });
    expect(headersByName.get('TenantB')).toEqual({ 'X-Tenant': 'b' });
  });

  it('still coalesces two endpoints that share baseURL+apiKey AND identical headers', async () => {
    const sharedHeaders = { Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}' };
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue({
        endpoints: {
          [EModelEndpoint.custom]: [
            {
              name: 'AliasOne',
              baseURL: 'https://shared-proxy.example.com/v1',
              apiKey: 'sk-shared',
              models: { fetch: true },
              headers: sharedHeaders,
            },
            {
              name: 'AliasTwo',
              baseURL: 'https://shared-proxy.example.com/v1',
              apiKey: 'sk-shared',
              models: { fetch: true },
              headers: sharedHeaders,
            },
          ],
        },
      }),
      getUserKeyValues: jest.fn(),
      fetchModels,
    });

    const req = {
      user: { id: 'user-1' },
      config: undefined,
    } as unknown as ServerRequest;

    await loadConfigModels(req);

    // Same baseURL + apiKey + headers → one fetch shared across both endpoints.
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });
});

describe('createLoadConfigModels – models.filter', () => {
  const fetchModels = jest.fn();

  /** One gateway, two rows: an OpenAI-compatible catch-all and a native
   *  Anthropic row that should expose only the Claude slice. */
  const buildAppConfig = (modelsOverrides: Record<string, unknown>) => ({
    endpoints: {
      [EModelEndpoint.custom]: [
        {
          name: 'Gateway (Claude)',
          baseURL: 'https://gateway.example.com/anthropic',
          apiKey: 'gw-key',
          provider: EModelEndpoint.anthropic,
          models: { fetch: true, default: ['claude-opus-4.8'], ...modelsOverrides },
        },
      ],
    },
  });

  const load = (modelsOverrides: Record<string, unknown>) =>
    createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(buildAppConfig(modelsOverrides)),
      getUserKeyValues: jest.fn().mockResolvedValue(null),
      fetchModels,
    })({ user: { id: 'user-1' }, config: undefined } as unknown as ServerRequest);

  const catalogue = [
    'claude-opus-4.8',
    'claude-opus-5',
    'claude-fable-5',
    'deepseek-v4-flash',
    'gpt-5.4',
    'wan-2.5-image-to-video',
  ];

  beforeEach(() => {
    fetchModels.mockReset().mockResolvedValue(catalogue);
  });

  it('keeps only the matching ids', async () => {
    const result = await load({ filter: '^claude-' });
    expect(result['Gateway (Claude)']).toEqual([
      'claude-opus-4.8',
      'claude-opus-5',
      'claude-fable-5',
    ]);
  });

  it('matches case-insensitively', async () => {
    const result = await load({ filter: '^CLAUDE-' });
    expect(result['Gateway (Claude)']).toHaveLength(3);
  });

  it('returns the full fetched list when no filter is set', async () => {
    const result = await load({});
    expect(result['Gateway (Claude)']).toEqual(catalogue);
  });

  it('falls back to models.default when the filter matches nothing', async () => {
    // Better an admin-curated list than an endpoint with an empty picker.
    const result = await load({ filter: '^nothing-matches-this-' });
    expect(result['Gateway (Claude)']).toEqual(['claude-opus-4.8']);
  });

  it('forwards the endpoint provider so the Anthropic models path is used', async () => {
    await load({ filter: '^claude-' });
    expect(fetchModels).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Gateway (Claude)',
        provider: EModelEndpoint.anthropic,
      }),
    );
  });
});

describe('createLoadConfigModels – models.chatOnly', () => {
  const fetchModels = jest.fn();

  /** Mirrors the shape a marketplace catalogue returns: an `architecture`
   *  block per entry describing what the model consumes and produces. */
  const catalogue = [
    { id: 'claude-opus-4.8', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'gpt-5-vision', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    { id: 'kling-text-to-video', architecture: { input_modalities: ['text'], output_modalities: ['video'] } },
    { id: 'wan-2.7', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    { id: 'whisper-large', architecture: { input_modalities: ['audio'], output_modalities: ['text'] } },
    { id: 'text-embedding-3', architecture: { input_modalities: ['text'], output_modalities: ['embedding'] } },
    { id: 'legacy-no-metadata' },
  ];

  const buildAppConfig = (modelsOverrides: Record<string, unknown>) => ({
    endpoints: {
      [EModelEndpoint.custom]: [
        {
          name: 'Marketplace',
          baseURL: 'https://gateway.example.com/v1',
          apiKey: 'gw-key',
          models: { fetch: true, default: ['fallback-model'], ...modelsOverrides },
        },
      ],
    },
  });

  const load = (modelsOverrides: Record<string, unknown>) =>
    createLoadConfigModels({
      getAppConfig: jest.fn().mockResolvedValue(buildAppConfig(modelsOverrides)),
      getUserKeyValues: jest.fn().mockResolvedValue(null),
      fetchModels,
    })({ user: { id: 'user-1' }, config: undefined } as unknown as ServerRequest);

  beforeEach(() => {
    fetchModels.mockReset().mockImplementation(async (params) => {
      params.onModelData?.(catalogue);
      return catalogue.map((m) => m.id);
    });
  });

  it('keeps only models that take text in and give text out', async () => {
    const result = await load({ chatOnly: true });
    expect(result['Marketplace']).toEqual([
      'claude-opus-4.8',
      'gpt-5-vision',
      // no metadata → kept, see fail-open note
      'legacy-no-metadata',
    ]);
  });

  it('keeps everything when chatOnly is not set', async () => {
    const result = await load({});
    expect(result['Marketplace']).toHaveLength(catalogue.length);
  });

  it('composes with the regex filter', async () => {
    const result = await load({ chatOnly: true, filter: '^claude-' });
    expect(result['Marketplace']).toEqual(['claude-opus-4.8']);
  });

  /** A catalogue with no `architecture` anywhere must not empty the picker. */
  it('keeps every model when the catalogue publishes no modality metadata', async () => {
    fetchModels.mockImplementation(async (params) => {
      const bare = [{ id: 'model-a' }, { id: 'model-b' }];
      params.onModelData?.(bare);
      return bare.map((m) => m.id);
    });

    const result = await load({ chatOnly: true });
    expect(result['Marketplace']).toEqual(['model-a', 'model-b']);
  });

  /** The MODEL_QUERIES cache stores ids only, so a cache hit never invokes
   *  onModelData — that must degrade to "no filtering", not "no models". */
  it('keeps every model when the fetch was served from cache', async () => {
    fetchModels.mockImplementation(async () => catalogue.map((m) => m.id));

    const result = await load({ chatOnly: true });
    expect(result['Marketplace']).toHaveLength(catalogue.length);
  });
});
