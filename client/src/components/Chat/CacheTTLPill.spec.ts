import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { isCacheTTLAnchor } from './CacheTTLPill';

const assistant = {
  messageId: 'assistant',
  conversationId: 'conversation',
  parentMessageId: 'user',
  text: 'Done',
  isCreatedByUser: false,
  cacheTTL: '5m',
} as TMessage;

describe('isCacheTTLAnchor', () => {
  it('accepts completed assistant responses with an explicit cache TTL', () => {
    expect(isCacheTTLAnchor(assistant)).toBe(true);
    expect(isCacheTTLAnchor({ ...assistant, cacheTTL: '1h' })).toBe(true);
  });

  it.each([
    ['a user tail', { ...assistant, isCreatedByUser: true }],
    ['a legacy response with unknown TTL', { ...assistant, cacheTTL: undefined }],
    ['an invalid cache TTL', { ...assistant, cacheTTL: '2h' }],
    ['an errored response', { ...assistant, error: true }],
    [
      'an error content response',
      {
        ...assistant,
        content: [{ type: ContentTypes.ERROR, [ContentTypes.ERROR]: 'provider failed' }],
      },
    ],
  ])('rejects %s', (_label, message) => {
    expect(isCacheTTLAnchor(message as TMessage)).toBe(false);
  });
});
