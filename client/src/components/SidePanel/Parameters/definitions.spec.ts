import type { SettingDefinition } from 'librechat-data-provider';
import { mergeParameterDefinitions } from './definitions';

const ttl: SettingDefinition = {
  key: 'promptCacheTtl',
  type: 'enum',
  component: 'dropdown',
  label: 'Cache TTL',
  options: ['5m', '1h'],
  default: '5m',
};

describe('mergeParameterDefinitions', () => {
  it('retains control metadata when a sparse override marks the setting readonly', () => {
    expect(
      mergeParameterDefinitions(
        [ttl],
        [{ key: 'promptCacheTtl', readonly: true, description: 'Gateway enforces 5m' }],
      ),
    ).toEqual([{ ...ttl, readonly: true, description: 'Gateway enforces 5m' }]);
  });

  it('lets explicit override fields replace defaults without mutating the base setting', () => {
    expect(mergeParameterDefinitions([ttl], [{ key: 'promptCacheTtl', default: '1h' }])[0]).toEqual(
      {
        ...ttl,
        default: '1h',
      },
    );
    expect(ttl.default).toBe('5m');
  });

  it('ignores unmatched overrides and preserves unmodified setting identity', () => {
    expect(mergeParameterDefinitions([ttl], [{ key: 'other', readonly: true }])[0]).toBe(ttl);
  });
});
