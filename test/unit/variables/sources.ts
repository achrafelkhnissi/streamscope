import type { SourcedValue } from '../../../src/environments/model';
import {
  emptyCaptureLookup,
  type CaptureLookup,
  type CaptureLookupResult,
  type VariableSources,
} from '../../../src/variables/sources';

export function sourced(
  values: Record<string, string>,
  origin: string,
): ReadonlyMap<string, SourcedValue> {
  return new Map(Object.entries(values).map(([name, value]) => [name, { value, origin }]));
}

export function inMemoryCaptures(results: {
  requests?: Record<string, CaptureLookupResult>;
  bare?: Record<string, CaptureLookupResult>;
  elsewhere?: Record<string, CaptureLookupResult>;
  responses?: Record<string, CaptureLookupResult>;
}): CaptureLookup {
  const requests = new Map(Object.entries(results.requests ?? {}));
  const bare = new Map(Object.entries(results.bare ?? {}));
  const elsewhere = new Map(Object.entries(results.elsewhere ?? {}));
  const responses = new Map(Object.entries(results.responses ?? {}));
  return {
    request: (requestName, captureName) => requests.get(`${requestName}.${captureName}`),
    bare: (captureName) => bare.get(captureName),
    elsewhere: (captureName) => elsewhere.get(captureName),
    response: (requestName, reference) => responses.get(`${requestName}.${reference}`),
  };
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
    captures: emptyCaptureLookup,
    ...overrides,
  };
}
