import { isAnthropicNativeURL } from './utils';

describe('isAnthropicNativeURL', () => {
  it('treats an absent URL as the endpoint default, which is Anthropic', () => {
    expect(isAnthropicNativeURL()).toBe(true);
    expect(isAnthropicNativeURL(undefined)).toBe(true);
    expect(isAnthropicNativeURL(null)).toBe(true);
    expect(isAnthropicNativeURL('')).toBe(true);
    expect(isAnthropicNativeURL('   ')).toBe(true);
  });

  it('accepts Anthropic’s own API regardless of path or casing', () => {
    expect(isAnthropicNativeURL('https://api.anthropic.com')).toBe(true);
    expect(isAnthropicNativeURL('https://api.anthropic.com/v1')).toBe(true);
    expect(isAnthropicNativeURL('https://API.Anthropic.COM/v1')).toBe(true);
    expect(isAnthropicNativeURL('  https://api.anthropic.com/v1  ')).toBe(true);
  });

  it('rejects gateways that merely speak the Messages API', () => {
    expect(isAnthropicNativeURL('https://api.surplusintelligence.ai/anthropic')).toBe(false);
    expect(isAnthropicNativeURL('https://openrouter.ai/api/v1')).toBe(false);
    expect(isAnthropicNativeURL('http://localhost:4000')).toBe(false);
  });

  it('rejects a look-alike host rather than matching on a substring', () => {
    expect(isAnthropicNativeURL('https://api.anthropic.com.evil.example')).toBe(false);
    expect(isAnthropicNativeURL('https://not-api.anthropic.com')).toBe(false);
    expect(isAnthropicNativeURL('https://evil.example/api.anthropic.com')).toBe(false);
  });

  it('rejects an unparseable URL instead of assuming the best', () => {
    expect(isAnthropicNativeURL('api.anthropic.com')).toBe(false);
    expect(isAnthropicNativeURL('not a url')).toBe(false);
  });
});
