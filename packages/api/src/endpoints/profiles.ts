import { ErrorTypes, DEFAULT_ENDPOINT_PROFILE_ID } from 'librechat-data-provider';
import type { TEndpointProfile, TUserEndpointProfiles } from 'librechat-data-provider';
import type { UserKeyValues, EndpointDbMethods } from '~/types';
import { validateEndpointURL } from '~/auth';

/**
 * Endpoint profiles let a user point a provider at their own OpenAI-compatible
 * base URL without losing the admin/env default.
 *
 * The distinction that matters: the pre-existing `user_provided` sentinel on a
 * `baseURL` makes a user-supplied URL *mandatory* — the admin default is
 * discarded and initialization fails outright when the user hasn't set one.
 * Profiles are additive instead. `active: 'default'` (or no profile set at all)
 * resolves to exactly what the caller would have used before, so a stored blob
 * written by an older build keeps working untouched.
 */

/**
 * Reads a decrypted user-key blob into structured values.
 *
 * Two historical shapes exist. Endpoints that route through `OtherConfig` in the
 * UI (Anthropic, Google) store the API key as a bare string; everything else
 * stores a JSON object. Anything non-JSON is therefore treated as a bare key
 * rather than an error — unlike `getUserKeyValues`, which throws on it.
 */
export function parseUserKeyBlob(raw?: string | null): UserKeyValues | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    return { apiKey: trimmed };
  }
  try {
    return JSON.parse(trimmed) as UserKeyValues;
  } catch {
    /** Malformed JSON that still looks like an object is a real corruption, not
     *  a legacy bare key — surface it the way `getUserKeyValues` does. */
    throw new Error(JSON.stringify({ type: ErrorTypes.INVALID_USER_KEY }));
  }
}

/**
 * Fetches a user's key blob without requiring one to exist.
 *
 * Profiles are usable even when the admin supplies the API key (i.e. the
 * endpoint is not `user_provided`), so a missing key must not be fatal here the
 * way it is on the credential path.
 */
export async function getUserKeyValuesSafe({
  db,
  userId,
  name,
}: {
  db: Partial<EndpointDbMethods>;
  userId: string;
  name: string;
}): Promise<UserKeyValues | null> {
  if (!userId) {
    return null;
  }
  try {
    /**
     * `getUserKey` is preferred because it returns the raw blob, letting
     * `parseUserKeyBlob` accept the bare-string shape that `getUserKeyValues`
     * rejects. Fall back to `getUserKeyValues` when only that is injected.
     */
    if (typeof db.getUserKey === 'function') {
      return parseUserKeyBlob(await db.getUserKey({ userId, name }));
    }
    if (typeof db.getUserKeyValues === 'function') {
      return await db.getUserKeyValues({ userId, name });
    }
    return null;
  } catch (error) {
    /** No stored key, or a legacy blob this read can't interpret — neither is
     *  fatal, since profiles are optional on top of the credential path. */
    const message = error instanceof Error ? error.message : '';
    if (message.includes(ErrorTypes.NO_USER_KEY) || message.includes(ErrorTypes.INVALID_USER_KEY)) {
      return null;
    }
    throw error;
  }
}

/** The profile named by `active`, or undefined when the default is selected. */
export function getActiveProfile(
  profiles?: TUserEndpointProfiles | null,
): TEndpointProfile | undefined {
  const activeId = profiles?.active;
  if (!activeId || activeId === DEFAULT_ENDPOINT_PROFILE_ID) {
    return undefined;
  }
  return profiles?.profiles?.find((profile) => profile.id === activeId);
}

export interface ResolveUserEndpointParams {
  /** Parsed key blob for this provider, if the user has one. */
  userValues?: UserKeyValues | null;
  /** The API key the caller would use with no profile selected. */
  fallbackApiKey?: string | null;
  /** The base URL the caller would use with no profile selected. */
  fallbackBaseURL?: string | null;
  /** Whether that fallback URL is itself user-supplied (`user_provided` sentinel). */
  fallbackURLIsUserProvided?: boolean;
  /** Endpoint name, for error messages. */
  endpoint: string;
  /** Admin exemptions from the private-address block. */
  allowedAddresses?: string[] | null;
}

export interface ResolvedUserEndpoint {
  apiKey?: string;
  baseURL?: string;
  /** Drives the SSRF-safe agent and the withholding of configured headers. */
  baseURLIsUserProvided: boolean;
  /** Set only when a non-default profile won. */
  activeProfile?: TEndpointProfile;
}

/**
 * Resolves the effective `{ apiKey, baseURL }` for a request, letting an active
 * endpoint profile override the admin/env values.
 *
 * When no profile is active the fallbacks pass through unchanged, which is why
 * callers compute them exactly as they did before this existed.
 *
 * A profile's URL is user-controlled by definition, so it is validated against
 * the SSRF guard here — centralizing the check that `initializeCustom`
 * previously performed inline.
 */
export async function resolveUserEndpoint({
  userValues,
  fallbackApiKey,
  fallbackBaseURL,
  fallbackURLIsUserProvided = false,
  endpoint,
  allowedAddresses,
}: ResolveUserEndpointParams): Promise<ResolvedUserEndpoint> {
  const activeProfile = getActiveProfile(userValues?.endpointProfiles);

  if (!activeProfile?.baseURL) {
    /**
     * Default path — deliberately byte-identical to pre-profile behavior,
     * including *not* validating a `user_provided` fallback URL here. Callers
     * that already validate it (`initializeCustom`) keep doing so inline;
     * moving that check in would silently tighten the built-in OpenAI path,
     * which is a separate decision from adding profiles.
     */
    return {
      apiKey: fallbackApiKey ?? undefined,
      baseURL: fallbackBaseURL ?? undefined,
      baseURLIsUserProvided: fallbackURLIsUserProvided,
    };
  }

  await validateEndpointURL(activeProfile.baseURL, endpoint, allowedAddresses);

  /**
   * A profile without its own key falls back to the provider-level key. That is
   * the useful default for a gateway that proxies to the same account (e.g. a
   * LiteLLM instance fronting Anthropic), and it keeps the "add a URL, reuse my
   * key" case from requiring the key to be typed twice.
   */
  return {
    apiKey: activeProfile.apiKey || fallbackApiKey || undefined,
    baseURL: activeProfile.baseURL,
    baseURLIsUserProvided: true,
    activeProfile,
  };
}
