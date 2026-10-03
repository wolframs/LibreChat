import React, { useState, useRef, useMemo, useEffect } from 'react';
import { apiBaseUrl } from 'librechat-data-provider';
import { Skeleton, useToastContext } from '@librechat/client';
import { cn, toAbsoluteFilePath } from '~/utils';
import DialogImage from './DialogImage';
import { useLocalize } from '~/hooks';

/** Max display height for chat images (Tailwind JIT class) */
export const IMAGE_MAX_H = 'max-h-[45vh]' as const;
/** Matches the `max-w-lg` Tailwind class on the wrapper button (32rem = 512px at 16px base) */
const IMAGE_MAX_W_PX = 512;

/** Caches image dimensions by src so remounts can reserve space */
const dimensionCache = new Map<string, { width: number; height: number }>();
/** Tracks URLs that have been fully painted — skip skeleton on remount */
const paintedUrls = new Set<string>();

/** Test-only: resets module-level caches */
export function _resetImageCaches(): void {
  dimensionCache.clear();
  paintedUrls.clear();
}

function computeHeightStyle(w: number, h: number): React.CSSProperties {
  return { height: `min(45vh, ${(h / w) * 100}vw, ${(h / w) * IMAGE_MAX_W_PX}px)` };
}

const Image = ({
  imagePath,
  altText,
  className,
  alignRight = false,
  args,
  width,
  height,
}: {
  imagePath: string;
  altText: string;
  className?: string;
  alignRight?: boolean;
  args?: {
    prompt?: string;
    quality?: 'low' | 'medium' | 'high';
    size?: string;
    style?: string;
    [key: string]: unknown;
  };
  width?: number;
  height?: number;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const localize = useLocalize();
  const { showToast } = useToastContext();

  /** Root-relative server paths (`/images/...` static, `/api/...` downloads and
   *  share routes) are resolved against the API base so they load under a
   *  subpath deployment. */
  const absoluteImageUrl = useMemo(() => toAbsoluteFilePath(imagePath, apiBaseUrl()), [imagePath]);

  const downloadImage = async () => {
    let response: Response;
    try {
      response = await fetch(absoluteImageUrl);
    } catch (error) {
      console.error('Download failed:', error);
      let target: URL;
      try {
        target = new URL(absoluteImageUrl, window.location.href);
      } catch {
        showToast({ status: 'error', message: localize('com_ui_download_error') });
        return;
      }
      if (
        target.origin === window.location.origin ||
        (target.protocol !== 'http:' && target.protocol !== 'https:')
      ) {
        showToast({ status: 'error', message: localize('com_ui_download_error') });
        return;
      }

      const link = document.createElement('a');
      link.href = absoluteImageUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast({ status: 'error', message: localize('com_ui_image_download_opened') });
      return;
    }

    if (!response.ok) {
      showToast({ status: 'error', message: localize('com_ui_download_error') });
      return;
    }

    try {
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
      showToast({ status: 'error', message: localize('com_ui_download_error') });
    }
  };

  useEffect(() => {
    if (width && height && absoluteImageUrl) {
      dimensionCache.set(absoluteImageUrl, { width, height });
    }
  }, [absoluteImageUrl, width, height]);

  const dims = width && height ? { width, height } : dimensionCache.get(absoluteImageUrl);
  const hasDimensions = !!(dims?.width && dims?.height);
  const heightStyle = hasDimensions ? computeHeightStyle(dims.width, dims.height) : undefined;
  const showSkeleton = hasDimensions && !paintedUrls.has(absoluteImageUrl);

  return (
    <div className={alignRight ? 'ml-auto' : undefined}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`View ${altText} in dialog`}
        aria-haspopup="dialog"
        onClick={() => setIsOpen(true)}
        className={cn(
          'relative mt-1 w-full max-w-lg cursor-pointer overflow-hidden rounded-lg border border-border-light text-text-secondary-alt shadow-md transition-shadow',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary',
          className,
        )}
        style={heightStyle}
      >
        {showSkeleton && <Skeleton className="absolute inset-0" aria-hidden="true" />}
        <img
          alt={altText}
          src={absoluteImageUrl}
          onLoad={() => paintedUrls.add(absoluteImageUrl)}
          className={cn(
            'relative block text-transparent',
            hasDimensions
              ? 'size-full object-contain'
              : cn('h-auto w-auto max-w-full', IMAGE_MAX_H),
          )}
        />
      </button>
      <DialogImage
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        src={absoluteImageUrl}
        downloadImage={downloadImage}
        args={args}
        triggerRef={triggerRef}
      />
    </div>
  );
};

export default Image;
