import type { ServerRequest } from '~/types';
import type { StreamUsageSink } from '~/endpoints/anthropic/streamUsage';

/**
 * Records where a request is actually being sent, once its endpoint initializer
 * has resolved a base URL.
 *
 * Stamped whenever the destination is something other than the provider's own
 * API: every `endpoints.custom` row, and any built-in provider reached through
 * an env reverse proxy. An absent `routedVia` therefore means "went straight to
 * the provider", which is the only case where the model-name rate table is
 * unambiguously describing what was charged.
 *
 * Deliberately indifferent to *why* the URL differs. Earlier this was stamped
 * only when a user had actively redirected the endpoint, which left an
 * admin-configured gateway looking exactly like a direct call — the blind spot
 * this is meant to close. Where the spend went is a property of the request, not
 * of who chose the destination.
 *
 * Note that this is provenance, not a verdict on the price: a gateway may report
 * exact per-request costs (OpenRouter) or none at all. That judgement is made
 * downstream from `baseURL`, so adding a gateway never means changing this.
 */
export function markRequestRouting(
  req: ServerRequest | undefined,
  { endpoint, baseURL }: { endpoint?: string; baseURL?: string | null },
): void {
  if (!req || !baseURL) {
    return;
  }
  req.routedVia = { endpoint, baseURL };
}

/**
 * Attaches a per-request collector for token usage observed on the raw streamed
 * response, and returns the sink that fills it.
 *
 * Lives beside {@link markRequestRouting} because it solves the same shape of
 * problem: something only knowable while the request is being made, needed much
 * later by the code that prices it, with nothing but `req` connecting the two.
 *
 * Only worth attaching where the destination might report usage in a frame the
 * stream parser does not read — i.e. gateways, not the provider's own API. The
 * cost when it is attached is one `ReadableStream.tee()` per streamed request;
 * the cost of not attaching it, against such a gateway, is every request billing
 * as zero input tokens.
 */
export function attachStreamUsageSink(req: ServerRequest | undefined): StreamUsageSink | undefined {
  if (!req) {
    return undefined;
  }
  const observed = (req.observedStreamUsage ??= []);
  return (usage) => {
    observed.push(usage);
  };
}
