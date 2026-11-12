import type { SourcedValue } from '../../../src/environments/model';
import type { VariableSources } from '../../../src/variables/sources';

export function sourced(
  values: Record<string, string>,
  origin: string,
): ReadonlyMap<string, SourcedValue> {
  return new Map(Object.entries(values).map(([name, value]) => [name, { value, origin }]));
}

export function testSources(overrides: Partial<VariableSources> = {}): VariableSources {
  return {
    system: {
      now: () => new Date('2026-11-11T10:20:30.456Z'),
      uuid: () => '00000000-0000-4000-8000-000000000001',
      randomInt: (minInclusive) => minInclusive,
    },
    restricted: false,
    environmentName: undefined,
    environment: new Map(),
    shared: new Map(),
    secrets: new Map(),
    dotenv: { kind: 'missing' },
    processEnv: {},
    privateFileIgnored: false,
    ...overrides,
  };
}
