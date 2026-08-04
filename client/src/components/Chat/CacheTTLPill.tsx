import { memo, useEffect, useMemo, useState } from 'react';
import { useRecoilState } from 'recoil';
import { EModelEndpoint, Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useGetMessagesByConvoId } from '~/data-provider';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const TTL_MS: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

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
 * Newest message — anchors the cache window. Prefers the latest timestamp,
 * but a message with NO timestamp is treated as newest: a just-streamed
 * response hasn't been refetched from the DB yet and briefly lacks
 * `createdAt`, and skipping it would anchor the countdown on the previous
 * turn's TTL (its arrival time is substituted for the timestamp downstream).
 */
function getAnchorMessage(messages: TMessage[] | undefined): TMessage | undefined {
  if (!messages || messages.length === 0) {
    return undefined;
  }
  let anchor: TMessage | undefined;
  let anchorTime = -Infinity;
  for (const message of messages) {
    const raw = message.createdAt ?? message.updatedAt;
    const time = raw != null ? new Date(raw).getTime() : Infinity;
    if (!Number.isNaN(time) && time >= anchorTime) {
      anchorTime = time;
      anchor = message;
    }
  }
  return anchor;
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
 * current toggle state. Messages predating that field fall back to '5m' (the
 * pre-native-TTL default); new turns always carry the recorded value.
 */
function CacheTTLPill() {
  const localize = useLocalize();
  const { conversation } = useChatContext();
  const conversationId = conversation?.conversationId ?? '';
  const armKey = conversationId || Constants.NEW_CONVO;

  const [armed, setArmed] = useRecoilState(store.armedCacheTTLByConvoId(armKey));

  const isAnthropic = conversation?.endpoint === EModelEndpoint.anthropic;
  /** `promptCache` defaults to true when unset (anthropicSettings). */
  const cacheEnabled = conversation?.promptCache !== false;
  const visible = isAnthropic && cacheEnabled;

  const { data: messages } = useGetMessagesByConvoId(conversationId, {
    enabled: visible && !!conversationId,
  });

  const anchor = useMemo(() => getAnchorMessage(messages), [messages]);
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
    return Number.isNaN(time) ? seenAt : time;
  }, [anchor, seenAt]);
  const lastTTL: '5m' | '1h' = anchor?.cacheTTL === '1h' ? '1h' : '5m';

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
    anchorTime != null ? anchorTime + (TTL_MS[lastTTL] ?? TTL_MS['5m']) - now : null;
  const expired = remaining != null && remaining <= 0;

  /** Cycle: idle -> arm 1h -> arm 5m -> idle. */
  const onToggle = () =>
    setArmed((prev) => (prev == null ? '1h' : prev === '1h' ? '5m' : null));

  let label: string;
  let title: string;
  if (armed === '1h') {
    label = localize('com_ui_cache_ttl_armed_short');
    title = localize('com_ui_cache_ttl_armed');
  } else if (armed === '5m') {
    label = localize('com_ui_cache_ttl_armed_5m_short');
    title = localize('com_ui_cache_ttl_armed_5m');
  } else if (remaining == null) {
    label = localize('com_ui_cache_ttl_idle');
    title = localize('com_ui_cache_ttl_arm_hint');
  } else if (expired) {
    label = localize('com_ui_cache_ttl_expired');
    title = localize('com_ui_cache_ttl_arm_hint');
  } else {
    label = formatRemaining(remaining);
    title = `${localize('com_ui_cache_ttl_remaining', { time: label })} · ${localize(
      'com_ui_cache_ttl_arm_hint',
    )}`;
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-pressed={armed != null}
      style={{ zIndex: 2147482000 }}
      className={cn(
        'fixed bottom-[156px] right-[10px] flex items-center gap-1 rounded-full border px-2 py-1 text-xs',
        'shadow-sm backdrop-blur transition-colors md:bottom-[50px] md:right-[14px]',
        armed === '1h'
          ? 'border-amber-400/60 bg-amber-400/20 text-amber-700 dark:text-amber-300'
          : armed === '5m'
            ? 'border-sky-400/60 bg-sky-400/20 text-sky-700 dark:text-sky-300'
            : expired || remaining == null
            ? 'border-border-light bg-surface-secondary/70 text-text-secondary opacity-60 hover:opacity-100'
            : 'border-border-light bg-surface-secondary/70 text-text-secondary hover:bg-surface-tertiary',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          armed === '1h'
            ? 'bg-amber-500'
            : armed === '5m'
              ? 'bg-sky-500'
              : expired || remaining == null
              ? 'bg-text-secondary'
              : 'bg-emerald-500',
        )}
      />
      <span className="tabular-nums">{label}</span>
    </button>
  );
}

export default memo(CacheTTLPill);
