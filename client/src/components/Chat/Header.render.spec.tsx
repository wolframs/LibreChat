/* eslint-disable i18next/no-literal-string */
import { render, screen } from '@testing-library/react';
import Header from './Header';

let mockSidebarExpanded = false;

jest.mock('recoil', () => ({ useRecoilValue: () => mockSidebarExpanded }));
jest.mock('~/store', () => ({
  sidebarExpanded: 'sidebar',
  isSubmittingFamily: () => 'submitting',
}));
jest.mock('react-router-dom', () => ({ useParams: () => ({ conversationId: 'new' }) }));
jest.mock('./Trace', () => ({ useTraceControl: () => ({ show: false }), TraceButton: () => null }));
jest.mock('./BackgroundTasks', () => ({ BackgroundTasksButton: () => null }));
jest.mock('./SubagentThreadLink', () => () => null);
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: { interface: { modelSelect: true, presets: true }, sharedLinksEnabled: true },
  }),
}));
jest.mock('~/hooks', () => ({
  useHasAccess: () => true,
  useLocalize: () => (key: string) => key,
}));
jest.mock('./Menus/Endpoints/ModelSelector', () => () => (
  <button data-testid="model-selector-button">Very long saved Agent name</button>
));
jest.mock('./MarketPricePopover', () => () => <button>Market prices</button>);
jest.mock('./Menus', () => ({
  OpenSidebar: () => <button>Open sidebar</button>,
  PresetsMenu: () => <button>Presets</button>,
  NewChat: () => <button>New chat</button>,
  HeaderMenu: () => <button>Chat menu</button>,
}));
jest.mock('./Menus/BookmarkMenu', () => () => <button>Bookmarks</button>);
jest.mock('./AddMultiConvo', () => () => <button>Multi conversation</button>);
jest.mock('./ExportAndShareMenu', () => () => <button>Share</button>);
jest.mock('./TemporaryChat', () => ({
  TemporaryChat: () => <button>Temporary chat</button>,
  TemporaryChatIndicator: () => null,
}));

describe('Header narrow layout', () => {
  beforeEach(() => {
    mockSidebarExpanded = false;
  });

  it('keeps the market control visible beside the model while secondary actions move into the mobile menu', () => {
    render(<Header />);
    const model = screen.getByTestId('model-selector-button');
    const market = screen.getByRole('button', { name: 'Market prices' });
    const presets = screen.getByRole('button', { name: 'Presets' });
    expect(model.parentElement).toHaveClass('min-w-0', 'flex-1');
    expect(market.parentElement).toHaveClass('shrink-0');
    expect(market.compareDocumentPosition(presets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(presets.parentElement).toHaveClass('hidden', 'md:flex');
    expect(screen.getByRole('button', { name: 'Chat menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bookmarks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Multi conversation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Temporary chat' })).toBeInTheDocument();
  });

  it('preserves the desktop action grouping', () => {
    render(<Header />);
    expect(screen.getByRole('button', { name: 'Market prices' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open sidebar' }).parentElement).toHaveClass(
      'md:hidden',
    );
    expect(screen.getByRole('button', { name: 'Presets' }).parentElement).not.toHaveClass(
      'overflow-x-auto',
    );
  });
});
