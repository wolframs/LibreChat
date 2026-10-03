import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MarketPricePopover from './MarketPricePopover';

let mockConversation = { endpoint: 'market', model: 'direct-model', agent_id: '' };
let mockAgent: { provider: string; model: string } | undefined;
let mockMarketplaceEndpoints = ['market'];

jest.mock('recoil', () => ({ useRecoilValue: () => mockConversation }));
jest.mock('~/store', () => ({ conversationByIndex: () => null }));
jest.mock('~/data-provider', () => ({ useGetAgentByIdQuery: () => ({ data: mockAgent }) }));
jest.mock('~/hooks/Chat', () => ({ useMarketplaceEndpoints: () => mockMarketplaceEndpoints }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: { percent?: string }) =>
    values?.percent == null ? key : `${values.percent} ${key}`,
}));
jest.mock('@librechat/client', () => ({
  Spinner: () => <span data-testid="market-spinner" />,
  TooltipAnchor: ({ render: anchor }: { render: React.ReactNode }) => anchor,
}));

const marketRow = {
  model: 'direct-model',
  best: { input: 0.023, output: 0.023, cacheRead: null, cacheWrite: null },
  direct: {
    input: 5,
    output: 5,
    source: 'provider',
    marketplaceInput: 5,
    marketplaceOutput: 5,
  },
  discountPct: 99.54,
  trend: null,
  sellers: [],
  healthySellers: 0,
  requests24h: 0,
};

function renderPopover() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MarketPricePopover />
    </QueryClientProvider>,
  );
}

describe('MarketPricePopover', () => {
  beforeEach(() => {
    global.fetch = Object.assign(jest.fn(), { preconnect: jest.fn() });
    mockConversation = { endpoint: 'market', model: 'direct-model', agent_id: '' };
    mockAgent = undefined;
    mockMarketplaceEndpoints = ['market'];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows loading then market prices for the conversation model', async () => {
    let respond: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    jest.mocked(global.fetch).mockReturnValue(pending);
    renderPopover();
    fireEvent.click(screen.getByTestId('market-prices-button'));
    expect(await screen.findByTestId('market-spinner')).toBeInTheDocument();
    respond({ ok: true, json: async () => marketRow } as Response);
    expect(await screen.findByText('99.5 com_ui_market_below_list')).toBeInTheDocument();
    expect(screen.getAllByText('$0.023')).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledWith('/cost/markets?model=direct-model');
  });

  it('shows a network error', async () => {
    jest.mocked(global.fetch).mockResolvedValue({ ok: false, status: 502 } as Response);
    renderPopover();
    fireEvent.click(screen.getByTestId('market-prices-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent('com_ui_market_error');
  });

  it('uses the saved Agent provider and model instead of the conversation fallback', async () => {
    mockConversation = { endpoint: 'agents', model: 'stale-model', agent_id: 'saved-agent' };
    mockAgent = { provider: 'market', model: 'saved-model' };
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ...marketRow, model: 'saved-model' }),
    } as Response);
    renderPopover();
    fireEvent.click(screen.getByTestId('market-prices-button'));
    expect(await screen.findByTitle('saved-model')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/cost/markets?model=saved-model');
  });

  it('does not show a market button for another provider', () => {
    mockMarketplaceEndpoints = ['other'];
    renderPopover();
    expect(screen.queryByTestId('market-prices-button')).not.toBeInTheDocument();
  });

  it('renders above-list discounts with an amber warning', async () => {
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ...marketRow, discountPct: -12.5 }),
    } as Response);
    renderPopover();
    fireEvent.click(screen.getByTestId('market-prices-button'));
    expect(await screen.findByText('12.5 com_ui_market_above_list')).toHaveClass('text-amber-600');
  });

  it('closes with Escape after keyboard opening', async () => {
    jest
      .mocked(global.fetch)
      .mockResolvedValue({ ok: true, json: async () => marketRow } as Response);
    renderPopover();
    const button = screen.getByTestId('market-prices-button');
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(await screen.findByText('99.5 com_ui_market_below_list')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByText('99.5 com_ui_market_below_list')).not.toBeInTheDocument(),
    );
  });
});
