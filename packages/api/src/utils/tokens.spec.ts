import { EModelEndpoint } from 'librechat-data-provider';
import type { EndpointTokenConfig } from '~/types';
import { getModelMaxTokens, getModelMaxOutputTokens } from './tokens';

describe('getModelMaxTokens partial-override fallback', () => {
  const partialOverride: EndpointTokenConfig = {
    'custom-model': { prompt: 1, completion: 2, context: 32000, output: 4096 },
  };

  it('uses the override for a listed model', () => {
    expect(getModelMaxTokens('custom-model', EModelEndpoint.openAI, partialOverride)).toBe(32000);
  });

  it('falls back to the built-in map for a model absent from a partial override', () => {
    const fallback = getModelMaxTokens('gpt-4o', EModelEndpoint.openAI, partialOverride);
    const builtin = getModelMaxTokens('gpt-4o', EModelEndpoint.openAI);
    expect(fallback).toBe(builtin);
    expect(fallback).toBeGreaterThan(100000);
  });
});

describe('getModelMaxOutputTokens partial-override fallback', () => {
  const partialOverride: EndpointTokenConfig = {
    'custom-model': { prompt: 1, completion: 2, context: 32000, output: 4096 },
  };

  it('falls back to the built-in map for a model absent from a partial override', () => {
    const fallback = getModelMaxOutputTokens('gpt-4o', EModelEndpoint.openAI, partialOverride);
    const builtin = getModelMaxOutputTokens('gpt-4o', EModelEndpoint.openAI);
    expect(fallback).toBe(builtin);
    expect(fallback).toBeGreaterThan(0);
  });
});

describe('Dotted gateway model ids resolve to the same limits as hyphenated ids', () => {
  /** Gateways serve `claude-opus-4.8`; Anthropic serves `claude-opus-4-8`. Substring
   * matching means an unlisted dotted id silently degrades — `claude-opus-4.8` matched
   * `claude-opus-4` and got a 200k window instead of 1M. */
  const pairs = [
    ['claude-haiku-4.5', 'claude-haiku-4-5'],
    ['claude-sonnet-4.5', 'claude-sonnet-4-5'],
    ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
    ['claude-opus-4.5', 'claude-opus-4-5'],
    ['claude-opus-4.6', 'claude-opus-4-6'],
    ['claude-opus-4.7', 'claude-opus-4-7'],
    ['claude-opus-4.8', 'claude-opus-4-8'],
  ] as const;

  it.each(pairs)('gives %s the context window of %s', (dotted, hyphenated) => {
    expect(getModelMaxTokens(dotted, EModelEndpoint.anthropic)).toBe(
      getModelMaxTokens(hyphenated, EModelEndpoint.anthropic),
    );
  });

  it.each(pairs)('gives %s the max output of %s', (dotted, hyphenated) => {
    expect(getModelMaxOutputTokens(dotted, EModelEndpoint.anthropic)).toBe(
      getModelMaxOutputTokens(hyphenated, EModelEndpoint.anthropic),
    );
  });

  it('applies the same limits on a custom (gateway) endpoint', () => {
    // A `provider: anthropic` yaml row routes through EModelEndpoint.custom.
    expect(getModelMaxTokens('claude-opus-4.8', EModelEndpoint.custom)).toBe(
      getModelMaxTokens('claude-opus-4-8', EModelEndpoint.custom),
    );
    expect(getModelMaxTokens('claude-opus-4.8', EModelEndpoint.custom)).toBe(1000000);
  });

  /** `-fast` is a gateway routing tier over the same model, so the window must
   *  not degrade to a shorter legacy key. */
  const fastVariants = [
    ['claude-opus-4.6-fast', 'claude-opus-4-6'],
    ['claude-opus-4-7-fast', 'claude-opus-4-7'],
    ['claude-opus-4-8-fast', 'claude-opus-4-8'],
    ['claude-opus-5-fast', 'claude-opus-5'],
  ] as const;

  it.each(fastVariants)('gives %s the context window of %s', (variant, base) => {
    expect(getModelMaxTokens(variant, EModelEndpoint.custom)).toBe(
      getModelMaxTokens(base, EModelEndpoint.custom),
    );
  });

  /** Every Claude id the Surplus catalogue serves, as of 2026-08-04. `claude-`
   *  alone is 100k, which is what an unlisted id degrades to. */
  const gatewayClaudeIds = [
    'claude-fable-5',
    'claude-haiku-4.5',
    'claude-opus-4-7-fast',
    'claude-opus-4-8-fast',
    'claude-opus-4.5',
    'claude-opus-4.6',
    'claude-opus-4.6-fast',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'claude-opus-5',
    'claude-opus-5-fast',
    'claude-sonnet-4.5',
    'claude-sonnet-4.6',
    'claude-sonnet-5',
  ];

  it.each(gatewayClaudeIds)('gives %s at least a 200k window', (model) => {
    expect(getModelMaxTokens(model, EModelEndpoint.custom)).toBeGreaterThanOrEqual(200000);
  });
});
