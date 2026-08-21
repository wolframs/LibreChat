import { AuthType, EModelEndpoint } from 'librechat-data-provider';
import type { TCustomEndpoints } from 'librechat-data-provider';
import { loadCustomEndpointsConfig } from './config';

const baseEndpoint = {
  apiKey: 'sk-test',
  baseURL: 'https://gateway.example.com',
  models: { default: ['claude-sonnet-4-5'] },
};

describe('loadCustomEndpointsConfig – native provider param set', () => {
  it('synthesizes defaultParamsEndpoint from provider so the UI shows the right params', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'Claude-Compatible', provider: EModelEndpoint.anthropic },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Claude-Compatible']?.customParams?.defaultParamsEndpoint).toBe(
      EModelEndpoint.anthropic,
    );
  });

  it('does not set defaultParamsEndpoint for endpoints without a provider', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'My-LLM' },
    ] as unknown as TCustomEndpoints);

    expect(config?.['My-LLM']?.customParams).toBeUndefined();
  });

  it('respects an explicit non-default defaultParamsEndpoint over the provider', () => {
    const config = loadCustomEndpointsConfig([
      {
        ...baseEndpoint,
        name: 'Claude-Compatible',
        provider: EModelEndpoint.anthropic,
        customParams: { defaultParamsEndpoint: EModelEndpoint.google },
      },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Claude-Compatible']?.customParams?.defaultParamsEndpoint).toBe(
      EModelEndpoint.google,
    );
  });
});

describe('loadCustomEndpointsConfig – user credential prompts', () => {
  it('requires a user key when the custom base URL is user-provided', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'User URL', baseURL: AuthType.USER_PROVIDED },
    ] as unknown as TCustomEndpoints);

    expect(config?.['User URL']).toEqual(
      expect.objectContaining({
        userProvide: true,
        userProvideURL: true,
      }),
    );
  });

  it('requires a user key when the custom API key is user-provided', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'User Key', apiKey: AuthType.USER_PROVIDED },
    ] as unknown as TCustomEndpoints);

    expect(config?.['User Key']).toEqual(
      expect.objectContaining({
        userProvide: true,
        userProvideURL: false,
      }),
    );
  });

  it('does not require a user key for admin-trusted credentials and base URL', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'Admin Trusted' },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Admin Trusted']).toEqual(
      expect.objectContaining({
        userProvide: false,
        userProvideURL: false,
      }),
    );
  });
});

describe('loadCustomEndpointsConfig – provider surfacing', () => {
  /**
   * The client needs to know which native client actually builds the request,
   * so a provider-specific control (the Anthropic prompt-cache pill) can render
   * on a gateway row. A custom row's endpoint *name* is admin-chosen and never
   * equals `anthropic`, so the name cannot answer this.
   */
  it('surfaces a declared provider', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'Marketplace', provider: EModelEndpoint.anthropic },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Marketplace']?.provider).toBe(EModelEndpoint.anthropic);
  });

  it('leaves provider undefined when the row declares none', () => {
    const config = loadCustomEndpointsConfig([
      { ...baseEndpoint, name: 'Plain' },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Plain']?.provider).toBeUndefined();
  });

  /**
   * `defaultParamsEndpoint` is derived from `provider` but is not a stand-in for
   * it: an admin can set it alone to borrow another endpoint's parameter panel,
   * and a control that keyed off it would then appear on a row whose requests
   * never reach that provider.
   */
  it('does not infer a provider from defaultParamsEndpoint alone', () => {
    const config = loadCustomEndpointsConfig([
      {
        ...baseEndpoint,
        name: 'Borrowed Params',
        customParams: { defaultParamsEndpoint: EModelEndpoint.anthropic },
      },
    ] as unknown as TCustomEndpoints);

    expect(config?.['Borrowed Params']?.customParams?.defaultParamsEndpoint).toBe(
      EModelEndpoint.anthropic,
    );
    expect(config?.['Borrowed Params']?.provider).toBeUndefined();
  });
});
