import { memo, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { ChevronRight } from 'lucide-react';
import { useMediaQuery } from '@librechat/client';
import { getConfigDefaults, PermissionTypes, Permissions } from 'librechat-data-provider';
import ModelSelector from './Menus/Endpoints/ModelSelector';
import { useGetStartupConfig } from '~/data-provider';
import ExportAndShareMenu from './ExportAndShareMenu';
import { OpenSidebar, PresetsMenu } from './Menus';
import BookmarkMenu from './Menus/BookmarkMenu';
import MarketPricePopover from './MarketPricePopover';
import { TemporaryChat } from './TemporaryChat';
import AddMultiConvo from './AddMultiConvo';
import { useHasAccess, useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const defaultInterface = getConfigDefaults().interface;

function Header() {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const navVisible = useRecoilValue(store.sidebarExpanded);

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });

  const hasAccessToMultiConvo = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });

  const hasAccessToTemporaryChat = useHasAccess({
    permissionType: PermissionTypes.TEMPORARY_CHAT,
    permission: Permissions.USE,
  });

  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const secondaryControlCount =
    Number(interfaceConfig.presets === true && interfaceConfig.modelSelect) +
    Number(hasAccessToBookmarks === true) +
    Number(hasAccessToMultiConvo === true) +
    Number(isSmallScreen) +
    Number(isSmallScreen && hasAccessToTemporaryChat === true);

  return (
    <div className="via-presentation/70 md:from-presentation/80 md:via-presentation/50 2xl:from-presentation/0 absolute top-0 z-10 flex h-[52px] w-full items-center justify-between bg-gradient-to-b from-presentation to-transparent p-2 font-semibold text-text-primary 2xl:via-transparent">
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <div className="mx-1 flex min-w-0 flex-1 items-center">
          {isSmallScreen ? <OpenSidebar /> : null}
          {!(navVisible && isSmallScreen) && (
            <div
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 pl-2',
                !isSmallScreen ? 'transition-all duration-200 ease-in-out' : '',
              )}
            >
              <div
                className={cn('flex min-w-0 items-center', isSmallScreen ? 'flex-1' : 'shrink-0')}
              >
                <ModelSelector startupConfig={startupConfig} />
              </div>
              {isSmallScreen && (
                <div className="shrink-0">
                  <MarketPricePopover />
                </div>
              )}
              <div className="relative shrink-0">
                <div
                  role={isSmallScreen ? 'group' : undefined}
                  aria-label={isSmallScreen ? localize('com_ui_more_options') : undefined}
                  tabIndex={isSmallScreen ? 0 : undefined}
                  className={cn(
                    'flex items-center gap-2',
                    isSmallScreen &&
                      'max-w-[88px] overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary sm:max-w-[144px]',
                  )}
                >
                  {interfaceConfig.presets === true && interfaceConfig.modelSelect && (
                    <PresetsMenu />
                  )}
                  {hasAccessToBookmarks === true && <BookmarkMenu />}
                  {hasAccessToMultiConvo === true && <AddMultiConvo />}
                  {!isSmallScreen && <MarketPricePopover />}
                  {isSmallScreen && (
                    <>
                      <ExportAndShareMenu
                        isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
                      />
                      {hasAccessToTemporaryChat === true && <TemporaryChat />}
                    </>
                  )}
                </div>
                {isSmallScreen && secondaryControlCount > 2 && (
                  <ChevronRight
                    aria-hidden="true"
                    className="pointer-events-none absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-presentation text-text-secondary"
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {!isSmallScreen && (
          <div className="flex shrink-0 items-center gap-2">
            <ExportAndShareMenu
              isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
            />
            {hasAccessToTemporaryChat === true && <TemporaryChat />}
          </div>
        )}
      </div>
      {/* Empty div for spacing */}
      <div />
    </div>
  );
}

const MemoizedHeader = memo(Header);
MemoizedHeader.displayName = 'Header';

export default MemoizedHeader;
