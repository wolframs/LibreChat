import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Image, { _resetImageCaches } from '../Image';

const mockShowToast = jest.fn();

jest.mock('~/utils', () => ({
  cn: (...classes: (string | boolean | undefined | null)[]) =>
    classes
      .flat(Infinity)
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .join(' '),
}));

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
  Skeleton: ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="skeleton" className={className} {...props} />
  ),
}));

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

jest.mock('../DialogImage', () => ({
  __esModule: true,
  default: ({
    isOpen,
    src,
    downloadImage,
  }: {
    isOpen: boolean;
    src: string;
    downloadImage: () => void;
  }) =>
    isOpen ? (
      <div data-testid="dialog-image" data-src={src}>
        <button data-testid="download-image" onClick={downloadImage} />
      </div>
    ) : null,
}));

describe('Image', () => {
  const defaultProps = {
    imagePath: '/images/test.png',
    altText: 'Test image',
  };

  beforeEach(() => {
    _resetImageCaches();
    jest.clearAllMocks();
    global.fetch = Object.assign(jest.fn(), { preconnect: jest.fn() });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('rendering without dimensions', () => {
    it('renders with max-h-[45vh] height constraint', () => {
      render(<Image {...defaultProps} />);
      const img = screen.getByRole('img');
      expect(img.className).toContain('max-h-[45vh]');
    });

    it('renders with max-w-full to prevent landscape clipping', () => {
      render(<Image {...defaultProps} />);
      const img = screen.getByRole('img');
      expect(img.className).toContain('max-w-full');
    });

    it('renders with w-auto and h-auto for natural aspect ratio', () => {
      render(<Image {...defaultProps} />);
      const img = screen.getByRole('img');
      expect(img.className).toContain('w-auto');
      expect(img.className).toContain('h-auto');
    });

    it('does not show skeleton without dimensions', () => {
      render(<Image {...defaultProps} />);
      expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    });

    it('does not apply heightStyle without dimensions', () => {
      render(<Image {...defaultProps} />);
      const button = screen.getByRole('button');
      expect(button.style.height).toBeFalsy();
    });
  });

  describe('rendering with dimensions', () => {
    it('shows skeleton behind image', () => {
      render(<Image {...defaultProps} width={1024} height={1792} />);
      expect(screen.getByTestId('skeleton')).toBeInTheDocument();
    });

    it('applies computed heightStyle to button', () => {
      render(<Image {...defaultProps} width={1024} height={1792} />);
      const button = screen.getByRole('button');
      expect(button.style.height).toBeTruthy();
      expect(button.style.height).toContain('min(45vh');
    });

    it('uses size-full object-contain on image when dimensions provided', () => {
      render(<Image {...defaultProps} width={768} height={916} />);
      const img = screen.getByRole('img');
      expect(img.className).toContain('size-full');
      expect(img.className).toContain('object-contain');
    });

    it('skeleton is absolute inset-0', () => {
      render(<Image {...defaultProps} width={512} height={512} />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton.className).toContain('absolute');
      expect(skeleton.className).toContain('inset-0');
    });

    it('marks URL as painted on load and skips skeleton on rerender', () => {
      const { rerender } = render(<Image {...defaultProps} width={512} height={512} />);
      const img = screen.getByRole('img');

      expect(screen.getByTestId('skeleton')).toBeInTheDocument();

      fireEvent.load(img);

      // Rerender same component — skeleton should not show (URL painted)
      rerender(<Image {...defaultProps} width={512} height={512} />);
      expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    });
  });

  describe('common behavior', () => {
    it('applies custom className to the button wrapper', () => {
      render(<Image {...defaultProps} className="mb-4" />);
      const button = screen.getByRole('button');
      expect(button.className).toContain('mb-4');
    });

    it('sets correct alt text', () => {
      render(<Image {...defaultProps} />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('alt', 'Test image');
    });

    it('has correct accessibility attributes on button', () => {
      render(<Image {...defaultProps} />);
      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-label', 'View Test image in dialog');
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    });
  });

  describe('dialog interaction', () => {
    it('opens dialog on button click', () => {
      render(<Image {...defaultProps} />);
      expect(screen.queryByTestId('dialog-image')).not.toBeInTheDocument();

      const button = screen.getByRole('button');
      fireEvent.click(button);

      expect(screen.getByTestId('dialog-image')).toBeInTheDocument();
    });

    it('dialog is always mounted (not gated by load state)', () => {
      render(<Image {...defaultProps} />);
      // DialogImage mock returns null when isOpen=false, but the component is in the tree
      // Clicking should immediately show it
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByTestId('dialog-image')).toBeInTheDocument();
    });
  });

  describe('image URL resolution', () => {
    it('passes /images/ paths through with base URL', () => {
      render(<Image {...defaultProps} imagePath="/images/test.png" />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', '/images/test.png');
    });

    it('passes absolute http URLs through unchanged', () => {
      render(<Image {...defaultProps} imagePath="https://example.com/photo.jpg" />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', 'https://example.com/photo.jpg');
    });

    it('passes data URIs through unchanged', () => {
      render(<Image {...defaultProps} imagePath="data:image/png;base64,abc" />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', 'data:image/png;base64,abc');
    });

    it('passes non-/images/ paths through unchanged', () => {
      render(<Image {...defaultProps} imagePath="/other/path.png" />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', '/other/path.png');
    });
  });

  describe('download feedback', () => {
    const download = () => {
      fireEvent.click(screen.getByRole('button', { name: 'View Test image in dialog' }));
      fireEvent.click(screen.getByTestId('download-image'));
    };

    it('downloads a fetched blob without an error toast', async () => {
      const createObjectURL = jest.fn().mockReturnValue('blob:test');
      const revokeObjectURL = jest.fn();
      window.URL.createObjectURL = createObjectURL;
      window.URL.revokeObjectURL = revokeObjectURL;
      jest
        .mocked(global.fetch)
        .mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) } as Response);
      render(<Image {...defaultProps} />);
      download();
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:test'));
      expect(mockShowToast).not.toHaveBeenCalled();
    });

    it('reports an HTTP failure without opening a misleading URL fallback', async () => {
      jest.mocked(global.fetch).mockResolvedValue({ ok: false, status: 404 } as Response);
      render(<Image {...defaultProps} />);
      download();
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith({
          status: 'error',
          message: 'com_ui_download_error',
        }),
      );
      expect(document.querySelector('a[href="/images/test.png"]')).toBeNull();
    });

    it('opens a cross-origin URL after fetch rejection and tells the user to save there', async () => {
      const openedLinks: Array<{ href: string; target: string; rel: string }> = [];
      jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        openedLinks.push({ href: this.href, target: this.target, rel: this.rel });
      });
      jest.mocked(global.fetch).mockRejectedValue(new TypeError('CORS blocked'));
      render(<Image {...defaultProps} imagePath="https://example.com/image.png" />);
      download();
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith({
          status: 'error',
          message: 'com_ui_image_download_opened',
        }),
      );
      expect(openedLinks).toEqual([
        {
          href: 'https://example.com/image.png',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      ]);
    });

    it('reports a same-origin fetch rejection without pretending to download', async () => {
      jest.mocked(global.fetch).mockRejectedValue(new TypeError('Network failed'));
      render(<Image {...defaultProps} />);
      download();
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith({
          status: 'error',
          message: 'com_ui_download_error',
        }),
      );
    });

    it.each([
      ['invalid URL', 'https://['],
      ['blob URL', 'blob:https://example.com/image'],
      ['custom scheme', 'custom://example.com/image'],
    ])('rejects an %s fallback instead of navigating', async (_label, imagePath) => {
      const open = jest
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined);
      jest.mocked(global.fetch).mockRejectedValue(new TypeError('Fetch failed'));
      render(<Image {...defaultProps} imagePath={imagePath} />);
      download();
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith({
          status: 'error',
          message: 'com_ui_download_error',
        }),
      );
      expect(open).not.toHaveBeenCalled();
    });
  });
});
