/**
 * Token accounting, which is the figure that actually means something here.
 *
 * Claude Code reports `total_cost_usd`, and on a subscription that is not a bill:
 * `modelUsage[…].costBasis` says `"list"`, i.e. what this work would have cost
 * at API list price had it gone through a key. Leading with it invites reading a
 * number as money that was never spent, and a $8 figure on a job the operator
 * pays nothing extra for is worse than no figure at all.
 *
 * What a subscription actually consumes is tokens, and they are not one number:
 * output is generation, cache-write is new context being laid down, cache-read
 * is context reused at a tenth the weight. A run that looks enormous by
 * cache-read is usually cheap; one heavy on cache-write is not.
 */

const fmt = (n) => {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
};

export function tokensFrom(usage) {
  if (!usage) return null;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** Running totals, summed across the session's assistant messages. */
export function addTokens(acc, usage) {
  const t = tokensFrom(usage);
  if (!t) return acc;
  const base = acc ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0 };
  for (const k of Object.keys(base)) base[k] += t[k] ?? 0;
  return base;
}

/** One line, tokens first, the notional price last and labelled as notional. */
export function describeTokens(t, { cost, model } = {}) {
  if (!t) return cost != null ? `list-price equivalent $${Number(cost).toFixed(2)}` : '';
  const parts = [
    `${fmt(t.output)} out`,
    t.thinking ? `${fmt(t.thinking)} thinking` : null,
    `${fmt(t.cacheWrite)} cache-write`,
    `${fmt(t.cacheRead)} cache-read`,
    t.input ? `${fmt(t.input)} in` : null,
  ].filter(Boolean);
  const tail =
    cost != null
      ? ` · list-price equivalent $${Number(cost).toFixed(2)}, not a charge on a subscription`
      : '';
  return `${parts.join(' / ')} tokens${model ? ` · ${model}` : ''}${tail}`;
}
