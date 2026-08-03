import { useMemo } from 'react';
import { Globe, Check } from 'lucide-react';
import { VisuallyHidden } from '@ariakit/react';
import { DEFAULT_ENDPOINT_PROFILE_ID } from 'librechat-data-provider';
import {
  useEndpointProfilesQuery,
  useUpdateEndpointProfilesMutation,
} from 'librechat-data-provider/react-query';
import { CustomMenuItem as MenuItem, CustomMenuSeparator } from '../CustomMenu';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * Small "via <endpoint>" tag for a provider row pointed at a custom base URL.
 *
 * The query lives here rather than in the parent row so that providers without
 * custom-base-URL support — and rows that aren't the selected one — mount no
 * query at all. The picker renders a row per provider, and hoisting this would
 * mean one request per provider on every mount.
 */
export function EndpointProfileBadge({ endpoint }: { endpoint: string }) {
  const localize = useLocalize();
  const { data } = useEndpointProfilesQuery(endpoint, { enabled: !!endpoint });

  const active = useMemo(() => {
    if (!data || data.active === DEFAULT_ENDPOINT_PROFILE_ID) {
      return undefined;
    }
    return data.profiles.find((profile) => profile.id === data.active);
  }, [data]);

  if (!active) {
    return null;
  }

  return (
    <span
      className="flex min-w-0 items-center gap-1 rounded-md bg-surface-tertiary px-1.5 py-0.5 text-xs text-text-secondary"
      title={localize('com_endpoint_profile_using', { 0: active.name })}
    >
      <Globe className="size-3 shrink-0" aria-hidden="true" />
      <span className="max-w-24 truncate">{active.name}</span>
    </span>
  );
}

/**
 * Switcher rows at the top of a provider's submenu: the admin/env default plus
 * every custom endpoint the user has saved. Switching here writes only the
 * `active` selection, leaving the stored URLs and keys untouched.
 *
 * Rendered inside the lazily-mounted submenu content, so the profile request
 * happens when a provider is actually opened rather than on picker mount.
 */
export default function EndpointProfileItems({ endpoint }: { endpoint: string }) {
  const localize = useLocalize();
  const { data } = useEndpointProfilesQuery(endpoint, { enabled: !!endpoint });
  const updateProfiles = useUpdateEndpointProfilesMutation();

  /** Nothing to switch between until at least one custom endpoint exists. */
  if (!data || data.profiles.length === 0) {
    return null;
  }

  const active = data.active || DEFAULT_ENDPOINT_PROFILE_ID;

  const entries = [
    {
      id: DEFAULT_ENDPOINT_PROFILE_ID,
      label: localize('com_endpoint_profile_default'),
      hint: data.defaultBaseURL,
    },
    ...data.profiles.map((profile) => ({
      id: profile.id,
      label: profile.name,
      hint: profile.baseURL,
    })),
  ];

  return (
    <>
      <div className="cursor-default px-2 py-1 text-xs font-medium text-text-secondary">
        {localize('com_endpoint_profile_label')}
      </div>
      {entries.map((entry) => {
        const isActive = entry.id === active;
        return (
          <MenuItem
            key={`profile-${entry.id}`}
            hideOnClick={false}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (isActive) {
                return;
              }
              updateProfiles.mutate({ name: endpoint, active: entry.id });
            }}
            className="flex w-full cursor-pointer items-center justify-between gap-2 py-1.5 text-sm"
          >
            <div className="flex min-w-0 flex-col">
              <span className={cn('truncate', isActive && 'font-medium')}>{entry.label}</span>
              {entry.hint && (
                <span className="truncate text-xs text-text-secondary">{entry.hint}</span>
              )}
            </div>
            {isActive && (
              <>
                <Check className="size-4 shrink-0 text-text-primary" aria-hidden="true" />
                <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
              </>
            )}
          </MenuItem>
        );
      })}
      <CustomMenuSeparator />
    </>
  );
}
