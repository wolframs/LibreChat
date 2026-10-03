import { formatMarketDiscount } from './MarketPricePopover';

describe('formatMarketDiscount', () => {
  it('does not present a nonzero $0.023 / $5 offer as 100% below list', () => {
    expect(formatMarketDiscount((1 - 0.023 / 5) * 100)).toBe('99.5');
  });

  it.each([
    [0, '0'],
    [51.8, '51.8'],
    [99.99, '99.9'],
    [100, '100'],
  ])('formats %s percent as %s', (percent, expected) => {
    expect(formatMarketDiscount(percent)).toBe(expected);
  });
});
