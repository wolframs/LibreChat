import { useQuery } from '@tanstack/react-query';

/**
 * Names of the custom endpoints the cost-dashboard sidecar recognises as
 * inference marketplaces, from `/cost/markets/endpoints`.
 *
 * The sidecar decides this by reading the bind-mounted `librechat.yaml` and
 * matching each custom row's baseURL host against the same host set that
 * governs exact-vs-nominal pricing (`routing.py`). Keeping the judgement there
 * means a renamed yaml row, or a second marketplace, needs no client change and
 * nothing marketplace-specific is compiled into the api image.
 *
 * Fails closed to an empty list: on a missing or unparseable yaml, or a sidecar
 * that is down, callers simply see no marketplace endpoints. Every consumer so
 * far uses this to *add* a caveat or a control, so absence degrades to the
 * plain non-marketplace rendering rather than to a broken one.
 */
export default function useMarketplaceEndpoints(): string[] {
  const { data } = useQuery<string[]>({
    queryKey: ['surplus-market-endpoints'],
    queryFn: async () => {
      const res = await fetch('/cost/markets/endpoints');
      if (!res.ok) {
        throw new Error(`endpoints fetch failed: ${res.status}`);
      }
      return (await res.json()).endpoints ?? [];
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  return data ?? [];
}
