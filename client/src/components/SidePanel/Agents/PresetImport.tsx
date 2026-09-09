import { useMemo } from 'react';
import { ControlCombobox } from '@librechat/client';
import { Tools } from 'librechat-data-provider';
import type { TPreset } from 'librechat-data-provider';
import type { AgentForm, StringOption } from '~/common';
import { useGetPresetsQuery } from '~/data-provider';
import { createProviderOption, getDefaultAgentFormValues } from '~/utils';
import { useLocalize } from '~/hooks';

const modelParameterKeys = [
  'temperature',
  'maxContextTokens',
  'maxOutputTokens',
  'max_tokens',
  'maxTokens',
  'top_p',
  'topP',
  'topK',
  'frequency_penalty',
  'presence_penalty',
  'reasoning_effort',
  'reasoning_summary',
  'verbosity',
  'useResponsesApi',
  'effort',
  'thinking',
  'thinkingBudget',
  'thinkingLevel',
  'thinkingDisplay',
  'promptCache',
  'promptCacheTtl',
  'web_search',
  'url_context',
  'disableStreaming',
  'region',
  'additionalModelRequestFields',
  'resendFiles',
  'fileTokenLimit',
  'stop',
] as const satisfies ReadonlyArray<keyof TPreset>;

const capabilityTools = new Set<string>([
  Tools.execute_code,
  Tools.file_search,
  Tools.web_search,
  Tools.memory,
]);

function getInstructions(preset: TPreset): string {
  const candidates = [preset.promptPrefix, preset.system, preset.instructions];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
}

function getModelParameters(preset: TPreset): AgentForm['model_parameters'] {
  return Object.fromEntries(
    modelParameterKeys.flatMap((key) => {
      const value = preset[key];
      return value == null ? [] : [[key, value]];
    }),
  ) as AgentForm['model_parameters'];
}

export function presetToAgentForm(preset: TPreset, fallbackName: string): AgentForm {
  const presetTools = Array.isArray(preset.tools)
    ? preset.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const selectedTools = new Set(presetTools);

  return {
    ...getDefaultAgentFormValues(),
    name: preset.title?.trim() || preset.model?.trim() || fallbackName,
    description: '',
    instructions: getInstructions(preset),
    provider: createProviderOption(preset.endpoint ?? ''),
    model: preset.model ?? '',
    model_parameters: getModelParameters(preset),
    tools: presetTools.filter((tool) => !capabilityTools.has(tool)),
    artifacts: preset.artifacts ?? '',
    execute_code: selectedTools.has(Tools.execute_code),
    file_search: selectedTools.has(Tools.file_search),
    web_search: selectedTools.has(Tools.web_search),
    memory: true,
  };
}

export default function PresetImport({
  providers,
  onImport,
}: {
  providers: StringOption[];
  onImport: (preset: TPreset) => void;
}) {
  const localize = useLocalize();
  const presetsQuery = useGetPresetsQuery();
  const supportedProviders = useMemo(
    () => new Set(providers.map((provider) => provider.value)),
    [providers],
  );
  const presets = useMemo(
    () =>
      (presetsQuery.data ?? []).filter(
        (preset) =>
          preset.presetId &&
          preset.endpoint &&
          preset.model &&
          supportedProviders.has(preset.endpoint),
      ),
    [presetsQuery.data, supportedProviders],
  );

  if (presetsQuery.isLoading || presets.length === 0) {
    return null;
  }

  const handleSelect = (presetId: string) => {
    const preset = presets.find((candidate) => candidate.presetId === presetId);
    if (preset) {
      onImport(preset);
    }
  };

  return (
    <div className="w-full">
      <ControlCombobox
        selectedValue=""
        displayValue=""
        selectPlaceholder={localize('com_agents_import_preset')}
        searchPlaceholder={localize('com_agents_search_presets')}
        setValue={handleSelect}
        items={presets.map((preset) => ({
          label: `${preset.title || preset.model} · ${preset.model}`,
          value: preset.presetId ?? '',
        }))}
        className="h-9 w-full rounded-lg border border-border-light bg-surface-secondary font-medium"
        ariaLabel={localize('com_agents_import_preset')}
        isCollapsed={false}
        showCarat={true}
      />
      <p className="mt-1 px-1 text-[11px] text-text-secondary">
        {localize('com_agents_import_preset_info')}
      </p>
    </div>
  );
}
