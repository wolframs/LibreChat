import * as mockReact from 'react';
import { fireEvent, render, screen, act } from '@testing-library/react';
import CacheTTLPill from './CacheTTLPill';

let mockConversation = { endpoint: 'anthropic', conversationId: 'conversation', agent_id: '' };
let mockAgent: { provider: string; model_parameters?: { promptCache?: boolean } } | undefined;
let mockAnchor: { messageId: string; cacheTTL: '5m' | '1h'; createdAt: string } | null = null;
let mockEndpoints: { [key: string]: { provider?: string; extendedCacheTTL?: boolean } } = {};

jest.mock('recoil', () => ({ useRecoilState: () => mockReact.useState(null) }));
jest.mock('~/store', () => ({ armedCacheTTLByConvoId: () => 'arm' }));
jest.mock('~/Providers', () => ({ useChatContext: () => ({ conversation: mockConversation }) }));
jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: () => ({ data: mockAgent }),
  useGetEndpointsQuery: () => ({ data: mockEndpoints }),
}));
jest.mock('~/hooks/Messages/useLatestMessage', () => ({ useLatestMessage: () => mockAnchor }));
jest.mock('~/hooks/Chat', () => ({ useMarketplaceEndpoints: () => [] }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: { time?: string }) =>
    values?.time == null ? key : `${key} ${values.time}`,
}));

describe('CacheTTLPill', () => {
  beforeEach(() => {
    mockConversation = { endpoint: 'anthropic', conversationId: 'conversation', agent_id: '' };
    mockAgent = undefined;
    mockAnchor = null;
    mockEndpoints = {};
  });

  it('cycles the next-message cache arm while leaving the current timer unchanged', () => {
    mockAnchor = {
      messageId: 'assistant',
      cacheTTL: '5m',
      createdAt: new Date(Date.now()).toISOString(),
    };
    render(<CacheTTLPill />);
    const pill = screen.getByRole('button');
    expect(pill).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pill);
    expect(pill).toHaveTextContent('com_ui_cache_ttl_armed_short');
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pill);
    expect(pill).toHaveTextContent('com_ui_cache_ttl_armed_5m_short');
    fireEvent.click(pill);
    expect(pill).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the native idle readout opaque and unfaded', () => {
    render(<CacheTTLPill />);
    const pill = screen.getByRole('button');
    expect(pill).toHaveClass('bg-surface-secondary', 'text-text-secondary');
    expect(pill).not.toHaveClass('opacity-60', 'bg-surface-secondary/70');
  });

  it('uses a saved Agent provider and prompt-cache setting', () => {
    mockConversation = {
      endpoint: 'agents',
      conversationId: 'conversation',
      agent_id: 'saved-agent',
    };
    mockAgent = { provider: 'custom-anthropic', model_parameters: { promptCache: true } };
    mockEndpoints = { 'custom-anthropic': { provider: 'anthropic', extendedCacheTTL: false } };
    render(<CacheTTLPill />);
    const readout = screen.getByRole('timer');
    expect(readout).toHaveClass('bg-surface-secondary', 'text-text-secondary');
    expect(readout).not.toHaveClass('opacity-60', 'bg-surface-secondary/70');
    expect(readout).toHaveAttribute('aria-live', 'off');
    expect(readout).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const tooltip = readout.querySelector('span[aria-hidden="true"]:last-child');
    expect(tooltip).toHaveClass('hidden');
    fireEvent.touchStart(readout);
    expect(tooltip).toHaveClass('block');
    readout.focus();
    fireEvent.keyDown(readout, { key: 'Escape' });
    expect(readout).not.toHaveFocus();
    expect(tooltip).toHaveClass('hidden');
  });

  it('hides when the saved Agent disables prompt caching', () => {
    mockConversation = {
      endpoint: 'agents',
      conversationId: 'conversation',
      agent_id: 'saved-agent',
    };
    mockAgent = { provider: 'anthropic', model_parameters: { promptCache: false } };
    render(<CacheTTLPill />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });

  it('counts down from the current branch anchor', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    mockAnchor = { messageId: 'assistant', cacheTTL: '5m', createdAt: '2026-09-15T11:59:00Z' };
    render(<CacheTTLPill />);
    expect(screen.getByRole('button')).toHaveTextContent('4:00');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('button')).toHaveTextContent('3:59');
    jest.useRealTimers();
  });
});
