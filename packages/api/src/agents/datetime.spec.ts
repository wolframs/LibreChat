import { ContentTypes } from 'librechat-data-provider';
import type { FormattedMessageWithContent } from './client';
import {
  DATETIME_CONTEXT_GAP_MS,
  createDatetimeFormatter,
  formatDatetimeContext,
  prependDatetimeContext,
  shouldStampDatetime,
  toMessageDate,
} from './datetime';

const T0 = new Date('2026-09-09T12:03:00.000Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const utc = createDatetimeFormatter({});

describe('createDatetimeFormatter', () => {
  it('renders in DATETIME_CONTEXT_TIMEZONE when set', () => {
    const berlin = createDatetimeFormatter({ DATETIME_CONTEXT_TIMEZONE: 'Europe/Berlin' });
    expect(berlin.format(T0)).toContain('14:03');
    expect(berlin.resolvedOptions().timeZone).toBe('Europe/Berlin');
  });

  it('falls back to TZ, then UTC', () => {
    expect(createDatetimeFormatter({ TZ: 'Asia/Tokyo' }).resolvedOptions().timeZone).toBe(
      'Asia/Tokyo',
    );
    expect(utc.resolvedOptions().timeZone).toBe('UTC');
  });

  it('survives an unknown zone name', () => {
    const formatter = createDatetimeFormatter({ DATETIME_CONTEXT_TIMEZONE: 'Mars/Olympus' });
    expect(formatter.resolvedOptions().timeZone).toBe('UTC');
  });
});

describe('formatDatetimeContext', () => {
  it('carries weekday, date, 24h time and zone', () => {
    const line = formatDatetimeContext(T0, utc);
    expect(line).toMatch(/^\[Current date and time: Wednesday,? 9 September 2026.*12:03.*UTC\]$/);
  });
});

describe('toMessageDate', () => {
  it('accepts Date, ISO string and epoch; rejects garbage and null', () => {
    expect(toMessageDate(T0)?.getTime()).toBe(T0.getTime());
    expect(toMessageDate(T0.toISOString())?.getTime()).toBe(T0.getTime());
    expect(toMessageDate(T0.getTime())?.getTime()).toBe(T0.getTime());
    expect(toMessageDate('not a date')).toBeUndefined();
    expect(toMessageDate(null)).toBeUndefined();
    expect(toMessageDate(undefined)).toBeUndefined();
  });
});

describe('shouldStampDatetime', () => {
  const user = { isCreatedByUser: true };

  it('stamps the opening user turn', () => {
    expect(shouldStampDatetime(user, undefined, T0)).toBe(true);
  });

  it('never stamps assistant turns or summaries', () => {
    expect(shouldStampDatetime({ isCreatedByUser: false }, undefined, T0)).toBe(false);
    expect(shouldStampDatetime({ ...user, role: 'system' }, undefined, T0)).toBe(false);
  });

  it('stamps only after more than ten minutes since the previous turn', () => {
    const previous = { createdAt: T0, isCreatedByUser: false };
    expect(shouldStampDatetime(user, previous, plus(DATETIME_CONTEXT_GAP_MS))).toBe(false);
    expect(shouldStampDatetime(user, previous, plus(DATETIME_CONTEXT_GAP_MS + 1))).toBe(true);
    expect(shouldStampDatetime(user, previous, plus(10 * 60 * 60 * 1000))).toBe(true);
  });

  it('does not stamp when the previous turn has no usable timestamp', () => {
    expect(shouldStampDatetime(user, { createdAt: null }, plus(DATETIME_CONTEXT_GAP_MS * 2))).toBe(
      false,
    );
    expect(
      shouldStampDatetime(user, { createdAt: 'junk' }, plus(DATETIME_CONTEXT_GAP_MS * 2)),
    ).toBe(false);
  });
});

describe('prependDatetimeContext', () => {
  it('prepends the stamp above the text of a qualifying user turn and reports it', () => {
    const formattedMessage: FormattedMessageWithContent = { content: 'hello' };
    const stamped = prependDatetimeContext({
      formattedMessage,
      message: { isCreatedByUser: true, createdAt: T0 },
      previous: undefined,
      formatter: utc,
    });

    expect(stamped).toBe(true);
    expect(formattedMessage.content).toBe(`${formatDatetimeContext(T0, utc)}\nhello`);
  });

  it('uses the persisted createdAt, not the clock, for historical turns', () => {
    const formattedMessage: FormattedMessageWithContent = { content: 'hello' };
    prependDatetimeContext({
      formattedMessage,
      message: { isCreatedByUser: true, createdAt: T0.toISOString() },
      previous: undefined,
      formatter: utc,
      now: plus(48 * 60 * 60 * 1000),
    });

    expect(formattedMessage.content).toContain('9 September 2026');
  });

  it('uses the clock for a fresh turn that has no createdAt yet', () => {
    const formattedMessage: FormattedMessageWithContent = { content: 'hello' };
    const now = plus(24 * 60 * 60 * 1000);
    prependDatetimeContext({
      formattedMessage,
      message: { isCreatedByUser: true },
      previous: { createdAt: T0, isCreatedByUser: false },
      formatter: utc,
      now,
    });

    expect(formattedMessage.content).toContain('10 September 2026');
  });

  it('leaves a quick follow-up untouched', () => {
    const formattedMessage: FormattedMessageWithContent = { content: 'and this?' };
    const stamped = prependDatetimeContext({
      formattedMessage,
      message: { isCreatedByUser: true, createdAt: plus(60 * 1000) },
      previous: { createdAt: T0, isCreatedByUser: false },
      formatter: utc,
    });

    expect(stamped).toBe(false);
    expect(formattedMessage.content).toBe('and this?');
  });

  it('stamps the text part of array content, leaving images alone', () => {
    const formattedMessage: FormattedMessageWithContent = {
      content: [
        { type: ContentTypes.IMAGE_URL, image_url: { url: 'data:image/png;base64,abc' } },
        { type: ContentTypes.TEXT, text: 'what is this?' },
      ],
    };
    prependDatetimeContext({
      formattedMessage,
      message: { isCreatedByUser: true, createdAt: T0 },
      previous: undefined,
      formatter: utc,
    });

    if (!Array.isArray(formattedMessage.content)) {
      throw new Error('Expected array content');
    }
    expect(formattedMessage.content[0].type).toBe(ContentTypes.IMAGE_URL);
    expect(formattedMessage.content[1].text).toBe(
      `${formatDatetimeContext(T0, utc)}\nwhat is this?`,
    );
  });
});
