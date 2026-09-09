import { logger } from '@librechat/data-schemas';
import type { FormattedMessageWithContent } from './client';
import { prependFileContext } from './client';

/** Gap between consecutive turns after which the model is re-oriented in time. */
export const DATETIME_CONTEXT_GAP_MS: number = 10 * 60 * 1000;

const DATETIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short',
};

/** The persisted row carries a `Date`; the wire type says `string`; a fresh turn has neither. */
type DatetimeSource = {
  createdAt?: Date | string | null;
  isCreatedByUser?: boolean;
  role?: string;
};

function buildFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { ...DATETIME_FORMAT_OPTIONS, timeZone });
}

/**
 * Resolves the zone the stamp is rendered in: `DATETIME_CONTEXT_TIMEZONE`, then the
 * process `TZ`, then UTC. An unknown zone name falls back to UTC rather than throwing
 * on every turn.
 */
export function createDatetimeFormatter(env: NodeJS.ProcessEnv = process.env): Intl.DateTimeFormat {
  const timeZone = env.DATETIME_CONTEXT_TIMEZONE?.trim() || env.TZ?.trim() || 'UTC';
  try {
    return buildFormatter(timeZone);
  } catch (error) {
    logger.warn(
      `[datetime] Unknown time zone "${timeZone}" for DATETIME_CONTEXT_TIMEZONE; using UTC`,
      error,
    );
    return buildFormatter('UTC');
  }
}

export function toMessageDate(value: Date | string | number | undefined | null): Date | undefined {
  if (value == null) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * A user turn gets a stamp when it opens the conversation, or when more than
 * {@link DATETIME_CONTEXT_GAP_MS} passed since the turn before it. The decision is
 * made from persisted `createdAt` values so a historical turn renders identically
 * on every request, which keeps the provider's prompt-cache prefix stable.
 */
export function shouldStampDatetime(
  message: DatetimeSource,
  previous: DatetimeSource | undefined,
  messageDate: Date,
): boolean {
  if (message.isCreatedByUser !== true || message.role === 'system') {
    return false;
  }
  if (previous == null) {
    return true;
  }
  const previousDate = toMessageDate(previous.createdAt);
  if (previousDate == null) {
    return false;
  }
  return messageDate.getTime() - previousDate.getTime() > DATETIME_CONTEXT_GAP_MS;
}

export function formatDatetimeContext(date: Date, formatter: Intl.DateTimeFormat): string {
  return `[Current date and time: ${formatter.format(date)}]`;
}

/**
 * Prepends the date/time line to the model-facing copy of a user turn when the turn
 * qualifies. Returns whether a stamp was added so the caller can recount tokens.
 */
export function prependDatetimeContext({
  formattedMessage,
  message,
  previous,
  formatter,
  now = new Date(),
}: {
  formattedMessage: FormattedMessageWithContent;
  message: DatetimeSource;
  previous: DatetimeSource | undefined;
  formatter: Intl.DateTimeFormat;
  now?: Date;
}): boolean {
  const messageDate = toMessageDate(message.createdAt) ?? now;
  if (!shouldStampDatetime(message, previous, messageDate)) {
    return false;
  }
  prependFileContext(formattedMessage, formatDatetimeContext(messageDate, formatter));
  return true;
}
