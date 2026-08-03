import React from 'react';
import { Trash2 } from 'lucide-react';
import { Button, Dropdown, Label } from '@librechat/client';
import { alternateName, DEFAULT_ENDPOINT_PROFILE_ID } from 'librechat-data-provider';
import type useEndpointProfiles from './useEndpointProfiles';
import InputWithLabel from './InputWithLabel';
import { useLocalize } from '~/hooks';

const ADD_PROFILE_VALUE = '__add_endpoint__';

type ProfilesState = ReturnType<typeof useEndpointProfiles>;

/**
 * Endpoint switcher for the API-key dialog: picks between the provider's
 * default base URL and any number of user-defined OpenAI-compatible endpoints.
 *
 * Selecting `Default` hands rendering back to the provider-specific config
 * component, so Azure/Bedrock/Google keep their bespoke fields untouched.
 */
export default function EndpointProfiles({
  endpoint,
  state,
}: {
  endpoint: string;
  state: ProfilesState;
}) {
  const localize = useLocalize();
  const {
    profiles,
    selected,
    selectedId,
    isDefaultSelected,
    defaultBaseURL,
    select,
    addProfile,
    updateSelected,
    deleteSelected,
  } = state;

  const defaultLabel = defaultBaseURL
    ? `${localize('com_endpoint_profile_default')} (${defaultBaseURL})`
    : localize('com_endpoint_profile_default');

  const options = [
    { value: DEFAULT_ENDPOINT_PROFILE_ID, label: defaultLabel },
    ...profiles.map((profile) => ({
      value: profile.id,
      label: profile.name || localize('com_endpoint_profile_untitled'),
    })),
    { divider: true as const },
    { value: ADD_PROFILE_VALUE, label: localize('com_endpoint_profile_add') },
  ];

  const handleChange = (value: string) => {
    if (value === ADD_PROFILE_VALUE) {
      addProfile();
      return;
    }
    select(value);
  };

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`endpoint-profile-${endpoint}`} className="text-left text-sm font-medium">
        {localize('com_endpoint_profile_label')}
      </Label>
      <Dropdown
        testId="endpoint-profile-select"
        value={selectedId}
        onChange={handleChange}
        options={options}
        sizeClasses="w-full"
        className="w-full"
        ariaLabel={localize('com_endpoint_profile_label')}
        portal={false}
      />

      {!isDefaultSelected && selected && (
        <>
          <InputWithLabel
            id={`profile-name-${selected.id}`}
            value={selected.name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              updateSelected({ name: e.target.value })
            }
            label={localize('com_endpoint_profile_name')}
            labelClassName="mb-1"
            inputClassName="mb-2"
          />
          <InputWithLabel
            id={`profile-url-${selected.id}`}
            value={selected.baseURL}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              updateSelected({ baseURL: e.target.value })
            }
            label={localize('com_endpoint_profile_base_url')}
            labelClassName="mb-1"
            inputClassName="mb-2"
          />
          <InputWithLabel
            id={`profile-key-${selected.id}`}
            value={selected.apiKey}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              updateSelected({ apiKey: e.target.value })
            }
            label={`${alternateName[endpoint] ?? endpoint} ${localize('com_endpoint_config_key_name')}`}
            subLabel={
              selected.hasApiKey
                ? localize('com_endpoint_profile_key_stored', { 0: selected.apiKeyHint ?? '' })
                : undefined
            }
            labelClassName="mb-1"
            secret
          />
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-text-secondary">
              {localize('com_endpoint_profile_key_optional')}
            </p>
            <Button
              variant="outline"
              onClick={deleteSelected}
              className="flex items-center gap-1.5 text-text-secondary"
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {localize('com_ui_delete')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
