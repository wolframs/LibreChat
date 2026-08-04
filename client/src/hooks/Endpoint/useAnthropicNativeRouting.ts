import { useMemo } from 'react';
import {
  EModelEndpoint,
  isAnthropicNativeURL,
  DEFAULT_ENDPOINT_PROFILE_ID,
} from 'librechat-data-provider';
import { useEndpointProfilesQuery } from 'librechat-data-provider/react-query';

/**
 * Whether the Anthropic endpoint is currently routed to Anthropic's own API.
 *
 * True whenever the user has not switched to a named endpoint profile, so the
 * stock setup behaves exactly as it did before profiles existed — including an
 * admin-set `ANTHROPIC_REVERSE_PROXY`, which is a deliberate deployment choice
 * rather than something to second-guess from the browser. Only a profile the
 * user actively selected is inspected, and only its host decides.
 *
 * Used to gate prompt-cache TTL controls, which a gateway silently ignores.
 *
 * The underlying query is skipped entirely for non-Anthropic endpoints, so this
 * costs nothing on the paths that can never be affected.
 */
export default function useAnthropicNativeRouting(endpoint?: string | null): boolean {
  const isAnthropic = endpoint === EModelEndpoint.anthropic;
  const { data } = useEndpointProfilesQuery(EModelEndpoint.anthropic, { enabled: isAnthropic });

  return useMemo(() => {
    if (!isAnthropic || !data) {
      return true;
    }
    const activeId = data.active || DEFAULT_ENDPOINT_PROFILE_ID;
    if (activeId === DEFAULT_ENDPOINT_PROFILE_ID) {
      return true;
    }
    const active = data.profiles.find((profile) => profile.id === activeId);
    /** A dangling active id resolves to the default endpoint server-side. */
    if (!active) {
      return true;
    }
    return isAnthropicNativeURL(active.baseURL);
  }, [data, isAnthropic]);
}
