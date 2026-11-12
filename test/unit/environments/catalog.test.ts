import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { environmentCatalog, originLabel } from '../../../src/environments/catalog';
import type { EnvironmentLayer, EnvironmentOrigin } from '../../../src/environments/model';

const settingsOrigin: EnvironmentOrigin = { kind: 'settings' };
const fileOrigin: EnvironmentOrigin = {
  kind: 'file',
  path: path.join('w', 'http-client.env.json'),
};
const privateOrigin: EnvironmentOrigin = {
  kind: 'private-file',
  path: path.join('w', 'http-client.private.env.json'),
};

function layer(
  origin: EnvironmentOrigin,
  environments: Record<string, Record<string, string>>,
  insecure: string[] = [],
): EnvironmentLayer {
  return {
    origin,
    environments: new Map(
      Object.entries(environments).map(([name, values]) => [name, new Map(Object.entries(values))]),
    ),
    insecure: new Set(insecure),
  };
}

function values(map: ReadonlyMap<string, { value: string }>) {
  return Object.fromEntries([...map].map(([name, entry]) => [name, entry.value]));
}

describe('environmentCatalog', () => {
  it('lets the private file win over the public file, and both over settings', () => {
    const catalog = environmentCatalog(
      [
        layer(settingsOrigin, { dev: { a: 'settings', b: 'settings', c: 'settings' } }),
        layer(fileOrigin, { dev: { b: 'file', c: 'file' } }),
        layer(privateOrigin, { dev: { c: 'private' } }),
      ],
      'dev',
    );

    expect(values(catalog.variables)).toEqual({ a: 'settings', b: 'file', c: 'private' });
  });

  it('keeps $shared values apart from the active environment', () => {
    const catalog = environmentCatalog(
      [layer(settingsOrigin, { $shared: { version: 'v1', host: 'shared' }, dev: { host: 'dev' } })],
      'dev',
    );

    expect(values(catalog.variables)).toEqual({ host: 'dev' });
    expect(values(catalog.shared)).toEqual({ version: 'v1', host: 'shared' });
  });

  it('uses only $shared when no environment is active', () => {
    const catalog = environmentCatalog(
      [layer(fileOrigin, { $shared: { version: 'v1' }, dev: { host: 'dev' } })],
      undefined,
    );

    expect(catalog.active).toBeUndefined();
    expect(catalog.variables.size).toBe(0);
    expect(values(catalog.shared)).toEqual({ version: 'v1' });
  });

  it('lists environment names from every layer without $shared', () => {
    const catalog = environmentCatalog(
      [
        layer(settingsOrigin, { $shared: {}, prod: {}, dev: {} }),
        layer(fileOrigin, { dev: {}, staging: {} }),
      ],
      undefined,
    );

    expect(catalog.names).toEqual(['dev', 'prod', 'staging']);
  });

  it('labels each value with its environment and origin', () => {
    const catalog = environmentCatalog(
      [layer(settingsOrigin, { dev: { a: '1' } }), layer(privateOrigin, { $shared: { b: '2' } })],
      'dev',
    );

    expect(catalog.variables.get('a')?.origin).toBe('dev environment (settings)');
    expect(catalog.shared.get('b')?.origin).toBe('$shared (http-client.private.env.json)');
    expect(originLabel(fileOrigin, 'dev')).toBe('dev environment (http-client.env.json)');
  });

  it('marks the active environment insecure when any layer does', () => {
    expect(environmentCatalog([layer(privateOrigin, { dev: {} }, ['dev'])], 'dev').insecure).toBe(
      true,
    );
    expect(environmentCatalog([layer(privateOrigin, { dev: {} }, ['dev'])], 'prod').insecure).toBe(
      false,
    );
  });
});
