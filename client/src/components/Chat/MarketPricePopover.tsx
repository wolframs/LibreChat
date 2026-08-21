import { memo, useRef } from 'react';
import * as Ariakit from '@ariakit/react';
import { useQuery } from '@tanstack/react-query';
import { useRecoilValue } from 'recoil';
import { ShieldCheck, Store, TrendingDown, TrendingUp } from 'lucide-react';
import { Spinner, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { useMarketplaceEndpoints } from '~/hooks/Chat';
import { cn } from '~/utils';
import store from '~/store';

interface MarketSeller {
  provider: string;
  trusted: boolean;
  healthy: number;
  input: number | null;
  output: number | null;
}

interface MarketTrend {
  direction: string | null;
  currentPct: number | null;
  previousPct: number | null;
  buckets: Array<number | null>;
}

interface MarketRow {
  model: string;
  best: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
  direct: {
    input: number | null;
    output: number | null;
    /** `provider` — the rate LibreChat would have billed a direct request at.
     *  `marketplace` — no such rate, so the marketplace's own reference. */
    source: 'provider' | 'marketplace';
    marketplaceInput: number | null;
    marketplaceOutput: number | null;
  };
  discountPct: number | null;
  trend: MarketTrend | null;
  sellers: MarketSeller[];
  healthySellers: number;
  requests24h: number;
}

/** Dollars per 1M tokens. Sub-dollar rates keep a third digit so cheap
 *  models don't all round to the same figure. */
function formatPer1M(value: number | null | undefined): string {
  if (value == null) {
    return '—';
  }
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

function PriceRow({
  label,
  best,
  list,
}: {
  label: string;
  best: number | null;
  list?: number | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="tabular-nums">
        <span className="font-medium text-text-primary">{formatPer1M(best)}</span>
        {list != null && (
          <span className="ml-1.5 text-xs text-text-secondary line-through">
            {formatPer1M(list)}
          </span>
        )}
      </span>
    </div>
  );
}

/** 24 hourly buckets of the discount on requests that actually settled —
 *  the realized spread, unlike the offer-book figures above it. Negative
 *  buckets (paid above list) render as amber baseline stubs. */
function TrendSparkline({ trend }: { trend: MarketTrend }) {
  return (
    <div className="flex h-5 items-end gap-px" aria-hidden="true">
      {trend.buckets.map((pct, i) => (
        <div
          key={i}
          className={cn(
            'w-1 rounded-sm',
            pct == null
              ? 'h-px bg-border-medium'
              : pct < 0
                ? 'h-0.5 bg-amber-500'
                : 'bg-emerald-500/70',
          )}
          style={pct != null && pct >= 0 ? { height: `${2 + (Math.min(pct, 100) / 100) * 18}px` } : undefined}
        />
      ))}
    </div>
  );
}

function PopoverBody({ model }: { model: string }) {
  const localize = useLocalize();
  const { data, isLoading, isError } = useQuery<MarketRow | null>({
    queryKey: ['surplus-market', model],
    queryFn: async () => {
      const res = await fetch(`/cost/markets?model=${encodeURIComponent(model)}`);
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`markets fetch failed: ${res.status}`);
      }
      return res.json();
    },
    /** The sidecar caches upstream for 30 s; matching it here makes reopening
     *  the popover free without ever showing older data than the proxy would. */
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex w-72 justify-center py-6">
        <Spinner className="text-text-secondary" />
      </div>
    );
  }
  if (isError) {
    return <div className="w-72 text-sm text-text-secondary">{localize('com_ui_market_error')}</div>;
  }
  if (data == null) {
    return (
      <div className="w-72 text-sm text-text-secondary">
        {localize('com_ui_market_not_listed')}
      </div>
    );
  }

  const hasListPrice = data.direct.input != null || data.direct.output != null;
  const deepening = data.trend?.direction === 'deepening';
  /** Only worth a line when the two baselines actually disagree — otherwise
   *  it's a footnote saying two identical numbers are identical. */
  const referenceGap =
    data.direct.source === 'provider' &&
    data.direct.marketplaceInput != null &&
    (data.direct.marketplaceInput !== data.direct.input ||
      data.direct.marketplaceOutput !== data.direct.output);

  return (
    <div className="w-72 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-text-secondary">{data.model}</span>
        {data.discountPct != null ? (
          <span className="whitespace-nowrap rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {localize('com_ui_market_below_list', { percent: String(Math.round(data.discountPct)) })}
          </span>
        ) : (
          <span className="whitespace-nowrap text-xs text-text-secondary">
            {localize('com_ui_market_no_list_price')}
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between text-xs font-medium text-text-secondary">
          <span>{localize('com_ui_market_per_million')}</span>
          {hasListPrice && <span>{localize('com_ui_market_best_vs_list')}</span>}
        </div>
        <PriceRow label={localize('com_ui_input')} best={data.best.input} list={data.direct.input} />
        <PriceRow
          label={localize('com_ui_output')}
          best={data.best.output}
          list={data.direct.output}
        />
        {data.best.cacheRead != null && (
          <PriceRow label={localize('com_ui_market_cache_read')} best={data.best.cacheRead} />
        )}
        {data.best.cacheWrite != null && (
          <PriceRow label={localize('com_ui_market_cache_write')} best={data.best.cacheWrite} />
        )}
        {referenceGap && (
          <div className="pt-0.5 text-[11px] leading-snug text-text-secondary">
            {localize('com_ui_market_reference_note', {
              input: formatPer1M(data.direct.marketplaceInput),
              output: formatPer1M(data.direct.marketplaceOutput),
            })}
          </div>
        )}
      </div>

      {data.trend != null && data.trend.buckets.length > 0 && (
        <div className="space-y-1 border-t border-border-light pt-2">
          <div className="flex items-center justify-between text-xs text-text-secondary">
            <span>{localize('com_ui_market_realized_24h')}</span>
            {data.trend.direction != null && (
              <span
                className={cn(
                  'flex items-center gap-1',
                  deepening ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
                )}
              >
                {deepening ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {data.trend.currentPct != null && `${Math.round(data.trend.currentPct)}%`}
              </span>
            )}
          </div>
          <TrendSparkline trend={data.trend} />
        </div>
      )}

      {data.sellers.length > 0 && (
        <div className="space-y-1 border-t border-border-light pt-2">
          <div className="text-xs font-medium text-text-secondary">
            {localize('com_ui_market_sellers', { healthy: String(data.healthySellers) })}
          </div>
          <div className="max-h-36 space-y-0.5 overflow-y-auto">
            {data.sellers.map((seller) => (
              <div
                key={seller.provider}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-1 text-text-primary">
                  <span className="truncate">{seller.provider}</span>
                  {seller.trusted && (
                    <ShieldCheck
                      className="h-3.5 w-3.5 flex-shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-label={localize('com_ui_market_trusted')}
                    />
                  )}
                </span>
                <span className="whitespace-nowrap text-xs tabular-nums text-text-secondary">
                  {formatPer1M(seller.input)} / {formatPer1M(seller.output)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Header icon that opens live Surplus marketplace prices for the current
 * conversation's model — what a request would cost right now vs provider
 * list. `/cost` answers "what did I spend"; this answers "what would it cost
 * me", so the two stay separate views.
 *
 * Rendered only on custom endpoints whose baseURL the cost-dashboard sidecar
 * recognizes as a marketplace (`/cost/markets/endpoints`), so a renamed yaml
 * row needs no client change and the built-in providers never show it.
 */
function MarketPricePopover() {
  const localize = useLocalize();
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const popover = Ariakit.usePopoverStore({ placement: 'bottom-start' });
  const open = Ariakit.useStoreState(popover, 'open');
  const disclosureRef = useRef<HTMLButtonElement>(null);

  const marketEndpoints = useMarketplaceEndpoints();

  const endpoint = conversation?.endpoint;
  const model = conversation?.model ?? '';
  if (endpoint == null || model === '' || !marketEndpoints.includes(endpoint)) {
    return null;
  }

  return (
    <>
      <TooltipAnchor
        description={localize('com_ui_market_prices')}
        render={
          <Ariakit.PopoverDisclosure
            ref={disclosureRef}
            store={popover}
            type="button"
            data-testid="market-prices-button"
            aria-label={localize('com_ui_market_prices')}
            aria-haspopup="dialog"
            className="inline-flex size-9 flex-shrink-0 items-center justify-center rounded-xl border border-border-light bg-presentation text-text-primary transition-all ease-in-out hover:bg-surface-tertiary disabled:pointer-events-none disabled:opacity-50 radix-state-open:bg-surface-tertiary"
          >
            <Store className="icon-sm" aria-hidden="true" />
          </Ariakit.PopoverDisclosure>
        }
      />
      <Ariakit.Popover
        store={popover}
        gutter={8}
        portal
        unmountOnHide
        finalFocus={disclosureRef}
        aria-label={localize('com_ui_market_prices')}
        className="z-[200] rounded-xl border border-border-medium bg-surface-secondary p-3 shadow-lg focus:outline-none"
      >
        {open && <PopoverBody model={model} />}
      </Ariakit.Popover>
    </>
  );
}

export default memo(MarketPricePopover);
