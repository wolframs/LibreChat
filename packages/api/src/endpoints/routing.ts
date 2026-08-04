import type { ServerRequest } from '~/types';

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
