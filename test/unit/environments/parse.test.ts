import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnvironmentFile, parseSettingsEnvironments } from '../../../src/environments/parse';
import type { EnvironmentLayer } from '../../../src/environments/model';

const file = { kind: 'file', path: path.join('w', 'http-client.env.json') } as const;

function layer(text: string): EnvironmentLayer {
  const result = parseEnvironmentFile(text, file);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.layer;
}

function plain(map: ReadonlyMap<string, ReadonlyMap<string, string>>) {
  return Object.fromEntries([...map].map(([name, values]) => [name, Object.fromEntries(values)]));
}

describe('environment parsing', () => {
  it('reads REST Client environments including $shared', () => {
    const settings = parseSettingsEnvironments({
      $shared: { version: 'v1' },
      dev: { host: 'dev.example.test' },
    });

    expect(settings.origin).toEqual({ kind: 'settings' });
    expect(plain(settings.environments)).toEqual({
      $shared: { version: 'v1' },
      dev: { host: 'dev.example.test' },
    });
  });

  it('reads an environment file and stringifies numbers and booleans', () => {
    expect(
      plain(layer('{"dev":{"port":8080,"debug":true,"host":"dev.example.test"}}').environments),
    ).toEqual({
      dev: { port: '8080', debug: 'true', host: 'dev.example.test' },
    });
  });

  it('skips objects, arrays and null values', () => {
    expect(
      plain(layer('{"dev":{"tls":{"a":1},"list":[1],"none":null,"host":"h"}}').environments),
    ).toEqual({
      dev: { host: 'h' },
    });
  });

  it('marks environments that set streamscope.insecure to true', () => {
    const parsed = layer(
      '{"dev":{"streamscope.insecure":true,"host":"h"},"prod":{"streamscope.insecure":"true"}}',
    );

    expect([...parsed.insecure]).toEqual(['dev']);
    expect(plain(parsed.environments)).toEqual({ dev: { host: 'h' }, prod: {} });
  });

  it('reports invalid JSON with the file name', () => {
    const result = parseEnvironmentFile('{"dev":', file);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('http-client.env.json');
  });

  it('never repeats file contents in a JSON error', () => {
    const result = parseEnvironmentFile('{"dev":{"token": synthetic-secret}}', file);

    expect(!result.ok && result.message).not.toContain('synthetic');
    expect(!result.ok && result.message).not.toContain('token');
  });

  it('gives the line and column of a JSON error when the parser reports one', () => {
    const result = parseEnvironmentFile('{\n  "dev": {"a": "b",}\n}', file);

    expect(!result.ok && result.message).toBe(
      'http-client.env.json is not valid JSON (line 2, column 20).',
    );
  });

  it('reports a file that is not an object of environments', () => {
    const result = parseEnvironmentFile('["dev"]', file);

    expect(!result.ok && result.message).toContain('http-client.env.json');
  });

  it('treats a settings value that is not an object as no environments', () => {
    expect(parseSettingsEnvironments(undefined).environments.size).toBe(0);
    expect(parseSettingsEnvironments('dev').environments.size).toBe(0);
    expect(parseSettingsEnvironments({ dev: 'host' }).environments.size).toBe(0);
  });
});
