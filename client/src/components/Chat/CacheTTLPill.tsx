import { memo, useEffect, useMemo, useState } from 'react';
import { useRecoilState } from 'recoil';
import { EModelEndpoint, Constants, ContentTypes, isAgentsEndpoint } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useGetAgentByIdQuery, useGetEndpointsQuery } from '~/data-provider';
import { useLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { useMarketplaceEndpoints } from '~/hooks/Chat';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const TTL_MS: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

export const isCacheTTLAnchor = (message: TMessage): boolean =>
  message.isCreatedByUser !== true &&
  message.error !== true &&
  (message.cacheTTL === '5m' || message.cacheTTL === '1h') &&
  !message.content?.some((part) => part.type === ContentTypes.ERROR);

/** Formats remaining ms: "59m" style above 10 minutes, else "mm:ss". */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds > 600) {
    return `${Math.ceil(totalSeconds / 60)}m`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Subtle overlay pill fixed above the font-switcher "Aa" button. Shows a live
 * countdown of the current Anthropic prompt-cache TTL for the active chat
 * (refreshed on every API call), and one-shot arms a 1-hour TTL for the next
 * message on click. Only rendered for Anthropic conversations with prompt
 * caching enabled (the default).
 *
 * The countdown reflects the TTL the LAST prompt was ACTUALLY sent with, read
 * back from the response message's persisted `cacheTTL` field, never the
 * current toggle state. Messages predating that field have unknown TTL and
 * cannot start a countdown; user/error tails retain the last valid ancestor.
 */
function CacheTTLPill() {
  const localize = useLocalize();
  const { conversation } = useChatContext();
  const conversationId = conversation?.conversationId ?? '';
  const armKey = conversationId || Constants.NEW_CONVO;

  const [armed, setArmed] = useRecoilState(store.armedCacheTTLByConvoId(armKey));
  const [showReadoutHint, setShowReadoutHint] = useState(false);

  const { data: endpointsConfig } = useGetEndpointsQuery();
  const agentId = isAgentsEndpoint(conversation?.endpoint) ? conversation?.agent_id : null;
  const { data: agent } = useGetAgentByIdQuery(agentId);
  const endpoint = agent?.provider ?? conversation?.endpoint ?? '';
  /**
   * Anthropic's own endpoint, or a custom row declaring `provider: anthropic` —
   * the latter is a gateway or marketplace reached through the same native
   * client, so `cache_control` is genuinely sent and the countdown is genuinely
   * about a cache. A custom row's `endpoint` is its admin-chosen name, never the
   * literal `anthropic`, so the name alone cannot answer this.
   */
  const isAnthropic =
    endpoint === EModelEndpoint.anthropic ||
    endpointsConfig?.[endpoint]?.provider === EModelEndpoint.anthropic;
  /** `promptCache` defaults to true when unset (anthropicSettings). */
  const cacheEnabled =
    (agent?.model_parameters?.promptCache ?? conversation?.promptCache) !== false;
  const visible = isAnthropic && cacheEnabled;
  /**
   * Whether arming 1h is worth offering. A gateway may rewrite `cache_control`
   * for the seller it picks — Surplus stamps its own 5m marker on the system
   * block, discarding ours — so the server clamps 1h to 5m off Anthropic's own
   * API. Offering a button that the server then downgrades would put a number
   * on screen that was never sent.
   *
   * The built-in Anthropic endpoint is assumed native, which an admin-set
   * `ANTHROPIC_REVERSE_PROXY` would falsify; that case still clamps server-side
   * (and logs it), it just isn't reflected here.
   */
  const canExtend =
    endpoint === EModelEndpoint.anthropic || endpointsConfig?.[endpoint]?.extendedCacheTTL === true;
  /**
   * On a marketplace the seller is chosen per request, so a cache written on
   * one turn is only read on the next if the same seller answers. The countdown
   * is then the window we asked for, not one we know exists — say so rather
   * than letting a ticking clock imply a certainty we don't have.
   */
  const isMarketplace = useMarketplaceEndpoints().includes(endpoint);

  /** Follow the branch currently selected in the message UI. A chronological
   *  max over every cached message can select a newer sibling branch and show
   *  its TTL while the user is reading an older branch. */
  const anchor = useLatestMessage(0, conversationId, isCacheTTLAnchor);
  const anchorId = anchor?.messageId;
  /** Arrival-time stand-in for anchors that haven't been persisted yet. */
  const [seenAt, setSeenAt] = useState(() => Date.now());
  useEffect(() => {
    setSeenAt(Date.now());
  }, [anchorId]);
  const anchorTime = useMemo(() => {
    if (anchor == null) {
      return null;
    }
    const raw = anchor.createdAt ?? anchor.updatedAt;
    const time = raw != null ? new Date(raw).getTime() : NaN;
    return Number.isFinite(time) && time <= Date.now() ? time : seenAt;
  }, [anchor, seenAt]);
  const lastTTL = anchor?.cacheTTL;

  /** Re-render each second so the countdown ticks. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible) {
    return null;
  }

  const remaining =
    anchorTime != null && lastTTL != null ? anchorTime + TTL_MS[lastTTL] - now : null;
  const expired = remaining != null && remaining <= 0;

  /**
   * Cycle: idle -> arm 1h -> arm 5m -> idle. Where 1h cannot survive the trip,
   * there is nothing left to cycle through — arming 5m only ever meant "undo
   * the 1h", and 5m is already what gets sent — so the pill stays a readout.
   */
  const onToggle = () => {
    if (!canExtend) {
      return;
    }
    setArmed((prev) => {
      if (prev == null) return '1h';
      return prev === '1h' ? '5m' : null;
    });
  };

  /**
   * A stale arm from before the endpoint changed (the recoil atom is keyed by
   * conversation, not by endpoint) must not keep claiming 1h once 1h is off the
   * table — the request would go out at 5m regardless.
   */
  const effectiveArmed = canExtend ? armed : null;

  let label: string;
  let title: string;
  if (effectiveArmed === '1h') {
    label = localize('com_ui_cache_ttl_armed_short');
    title = localize('com_ui_cache_ttl_armed');
  } else if (effectiveArmed === '5m') {
    label = localize('com_ui_cache_ttl_armed_5m_short');
    title = localize('com_ui_cache_ttl_armed_5m');
  } else {
    const hint = canExtend
      ? localize('com_ui_cache_ttl_arm_hint')
      : localize('com_ui_cache_ttl_fixed_5m');
    if (remaining == null) {
      label = localize('com_ui_cache_ttl_idle');
      title = hint;
    } else if (expired) {
      label = localize('com_ui_cache_ttl_expired');
      title = hint;
    } else {
      label = formatRemaining(remaining);
      title = `${localize('com_ui_cache_ttl_remaining', { time: label })} · ${hint}`;
    }
  }
  if (isMarketplace) {
    title = `${title} · ${localize('com_ui_cache_ttl_marketplace')}`;
  }

  let pillClass = cn(
    'bg-surface-secondary border-border-light text-text-secondary',
    canExtend && 'hover:bg-surface-tertiary',
  );
  let dotClass = 'bg-emerald-500';
  if (effectiveArmed === '1h') {
    pillClass = 'border-amber-400/60 bg-amber-400/20 text-amber-700 dark:text-amber-300';
    dotClass = 'bg-amber-500';
  } else if (effectiveArmed === '5m') {
    pillClass = 'border-sky-400/60 bg-sky-400/20 text-sky-700 dark:text-sky-300';
    dotClass = 'bg-sky-500';
  } else if (expired || remaining == null) {
    pillClass = 'bg-surface-secondary border-border-light text-text-secondary';
    dotClass = 'bg-text-secondary';
  }

  const className = cn(
    'fixed bottom-[156px] right-[10px] flex min-h-8 items-center gap-1 rounded-full border px-2 py-1 text-xs',
    'shadow-sm backdrop-blur transition-colors md:bottom-[50px] md:right-[14px]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary',
    !canExtend && 'cursor-default',
    pillClass,
  );
  const content = (
    <>
      <span aria-hidden="true" className={cn('inline-block h-1.5 w-1.5 rounded-full', dotClass)} />
      <span className="tabular-nums">{label}</span>
    </>
  );

  if (!canExtend) {
    return (
      <div
        role="timer"
        aria-live="off"
        tabIndex={0}
        title={title}
        aria-label={title}
        onTouchStart={() => setShowReadoutHint((previous) => !previous)}
        onBlur={() => setShowReadoutHint(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.currentTarget.blur();
          }
        }}
        style={{ zIndex: 2147482000 }}
        className={cn('group', className)}
      >
        {content}
        <span
          aria-hidden="true"
          className={cn(
            'absolute bottom-full right-0 mb-2 hidden w-[min(236px,calc(100vw-20px))] rounded-lg border border-border-light bg-surface-primary p-2 text-left text-xs leading-snug text-text-primary shadow-lg',
            'group-hover:block group-focus:block',
            showReadoutHint && 'block',
          )}
        >
          {title}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-pressed={effectiveArmed != null}
      style={{ zIndex: 2147482000 }}
      className={className}
    >
      {content}
    </button>
  );
}

export default memo(CacheTTLPill);
