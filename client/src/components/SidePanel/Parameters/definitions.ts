import type { SettingDefinition } from 'librechat-data-provider';

export function mergeParameterDefinitions(
  defaults: SettingDefinition[],
  overrides: Partial<SettingDefinition>[],
): SettingDefinition[] {
  const byKey = new Map(
    overrides
      .filter((override) => override.key != null)
      .map((override) => [override.key, override]),
  );
  return defaults.map((definition) => {
    const override = byKey.get(definition.key);
    return override == null ? definition : { ...definition, ...override };
  });
}
