import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_ENDPOINT_PROFILE_ID } from 'librechat-data-provider';
import {
  useEndpointProfilesQuery,
  useUpdateEndpointProfilesMutation,
} from 'librechat-data-provider/react-query';

export interface DraftProfile {
  id: string;
  name: string;
  baseURL: string;
  /** Newly typed key. Empty means "keep whatever the server already has". */
  apiKey: string;
  /** Whether the server holds a key for this profile. */
  hasApiKey: boolean;
  apiKeyHint?: string;
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Client state for a provider's endpoint profiles.
 *
 * Server data is authoritative until the user touches something — after that
 * the local draft wins, so a background refetch can't discard half-typed input.
 */
export default function useEndpointProfiles(endpoint: string) {
  const { data, isLoading } = useEndpointProfilesQuery(endpoint, { enabled: !!endpoint });
  const updateProfiles = useUpdateEndpointProfilesMutation();

  const [profiles, setProfiles] = useState<DraftProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_ENDPOINT_PROFILE_ID);
  const isDirtyRef = useRef(false);

  useEffect(() => {
    if (!data || isDirtyRef.current) {
      return;
    }
    setProfiles(
      data.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        baseURL: profile.baseURL,
        apiKey: '',
        hasApiKey: profile.hasApiKey,
        apiKeyHint: profile.apiKeyHint,
      })),
    );
    setSelectedId(data.active || DEFAULT_ENDPOINT_PROFILE_ID);
  }, [data]);

  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId),
    [profiles, selectedId],
  );

  const isDefaultSelected = selectedId === DEFAULT_ENDPOINT_PROFILE_ID;

  const addProfile = useCallback(() => {
    isDirtyRef.current = true;
    const profile: DraftProfile = {
      id: newId(),
      name: '',
      baseURL: '',
      apiKey: '',
      hasApiKey: false,
    };
    setProfiles((current) => [...current, profile]);
    setSelectedId(profile.id);
  }, []);

  const updateSelected = useCallback(
    (patch: Partial<Pick<DraftProfile, 'name' | 'baseURL' | 'apiKey'>>) => {
      isDirtyRef.current = true;
      setProfiles((current) =>
        current.map((profile) => (profile.id === selectedId ? { ...profile, ...patch } : profile)),
      );
    },
    [selectedId],
  );

  const deleteSelected = useCallback(() => {
    isDirtyRef.current = true;
    setProfiles((current) => current.filter((profile) => profile.id !== selectedId));
    setSelectedId(DEFAULT_ENDPOINT_PROFILE_ID);
  }, [selectedId]);

  const select = useCallback((id: string) => {
    isDirtyRef.current = true;
    setSelectedId(id);
  }, []);

  /**
   * Persists the whole set and makes `selectedId` active. Profiles with a blank
   * key field are sent without one so the server keeps the stored value.
   *
   * A half-filled new profile is dropped rather than rejected: it only exists
   * because the user clicked "Add" and then changed their mind.
   */
  const save = useCallback(async () => {
    const complete = profiles.filter(
      (profile) => profile.name.trim() !== '' && profile.baseURL.trim() !== '',
    );
    const active = complete.some((profile) => profile.id === selectedId)
      ? selectedId
      : DEFAULT_ENDPOINT_PROFILE_ID;

    const result = await updateProfiles.mutateAsync({
      name: endpoint,
      active,
      profiles: complete.map((profile) => ({
        id: profile.id,
        name: profile.name.trim(),
        baseURL: profile.baseURL.trim(),
        ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      })),
    });

    isDirtyRef.current = false;
    return result;
  }, [endpoint, profiles, selectedId, updateProfiles]);

  /** Switches the active endpoint without touching the profile list. */
  const activate = useCallback(
    async (id: string) => {
      setSelectedId(id);
      isDirtyRef.current = false;
      return updateProfiles.mutateAsync({ name: endpoint, active: id });
    },
    [endpoint, updateProfiles],
  );

  return {
    profiles,
    selected,
    selectedId,
    isDefaultSelected,
    isLoading,
    isSaving: updateProfiles.isLoading,
    activeId: data?.active ?? DEFAULT_ENDPOINT_PROFILE_ID,
    defaultBaseURL: data?.defaultBaseURL,
    select,
    activate,
    addProfile,
    updateSelected,
    deleteSelected,
    save,
  };
}
