import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import { resolveRequest, type Resolution } from '../../../src/variables/resolve';
import { referencedSecrets } from '../../../src/variables/secrets';
import type { VariableSources } from '../../../src/variables/sources';
import { sourced, testSources } from './sources';

function resolve(sources: Partial<VariableSources>, ...lines: string[]): Resolution {
  const file = parseHttpFile(lines.join('\n'));
  const request = file.requests[0];
  if (!request) {
    throw new Error('expected a request');
  }
  return resolveRequest(file, request, testSources(sources));
}

function url(sources: Partial<VariableSources>, ...lines: string[]): string {
  const result = resolve(sources, ...lines);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result.request.url;
}

function problem(sources: Partial<VariableSources>, ...lines: string[]): string {
  const result = resolve(sources, ...lines);
  if (result.ok) {
    throw new Error(`expected a problem, got ${result.request.url}`);
  }
  return result.problems[0]?.message ?? '';
}

const dotenvPath = path.join('w', '.env');
const loaded = {
  dotenv: { kind: 'loaded', values: new Map([['API_KEY', 'synthetic-key']]), path: dotenvPath },
} as const;

describe('secret, .env and process variables', () => {
  it('resolves $secret from the provided secrets and marks it sensitive', () => {
    const result = resolve(
      { secrets: new Map([['apiToken', 'synthetic-token']]) },
      'GET https://api.example.test/items',
      'Authorization: Bearer {{$secret apiToken}}',
    );

    expect(result.ok && result.request.headers[0]?.value).toBe('Bearer synthetic-token');
    expect(result.ok && result.sensitiveValues).toEqual(['synthetic-token']);
  });

  it('blocks a $secret with no stored value', () => {
    expect(problem({}, 'GET https://api.example.test/{{$secret apiToken}}')).toBe(
      '`{{$secret apiToken}}` has no stored value.',
    );
  });

  it('resolves $processEnv and its % indirection through the environment', () => {
    const sources = {
      processEnv: { API_KEY: 'from-process' },
      environmentName: 'dev',
      environment: sourced({ keyName: 'API_KEY' }, 'dev environment (settings)'),
    };

    expect(url(sources, 'GET https://api.example.test/{{$processEnv API_KEY}}')).toBe(
      'https://api.example.test/from-process',
    );
    expect(url(sources, 'GET https://api.example.test/{{$processEnv %keyName}}')).toBe(
      'https://api.example.test/from-process',
    );
  });

  it('blocks an unset process variable instead of sending an empty value', () => {
    expect(problem({}, 'GET https://api.example.test/{{$processEnv API_KEY}}')).toBe(
      "`{{$processEnv API_KEY}}`: API_KEY is not set in VS Code's environment.",
    );
  });

  it('resolves $dotenv, with %, from the loaded file', () => {
    const sources = {
      ...loaded,
      environmentName: 'dev',
      environment: sourced({ keyName: 'API_KEY' }, 'dev environment (settings)'),
    };

    expect(url(sources, 'GET https://api.example.test/{{$dotenv API_KEY}}')).toBe(
      'https://api.example.test/synthetic-key',
    );
    expect(url(sources, 'GET https://api.example.test/{{$dotenv %keyName}}')).toBe(
      'https://api.example.test/synthetic-key',
    );
  });

  it('blocks $dotenv when no file was found or the key is missing', () => {
    expect(problem({}, 'GET https://api.example.test/{{$dotenv API_KEY}}')).toBe(
      '`{{$dotenv API_KEY}}`: no .env file was found next to the .http file or above it in the workspace.',
    );
    expect(problem(loaded, 'GET https://api.example.test/{{$dotenv OTHER}}')).toBe(
      `\`{{$dotenv OTHER}}\`: OTHER is not in ${dotenvPath}.`,
    );
  });

  it('blocks $secret, $dotenv and $processEnv in a restricted workspace', () => {
    const restricted = {
      restricted: true,
      secrets: new Map([['apiToken', 'synthetic-token']]),
      processEnv: { API_KEY: 'from-process' },
      dotenv: { kind: 'restricted' },
    } as const;

    for (const expression of ['$secret apiToken', '$dotenv API_KEY', '$processEnv API_KEY']) {
      expect(problem(restricted, `GET https://api.example.test/{{${expression}}}`)).toBe(
        `\`{{${expression}}}\` is not available in a restricted workspace. Trust the workspace to use it.`,
      );
    }
  });

  it('marks credential-named .env and process values as sensitive', () => {
    const result = resolve(
      { ...loaded, processEnv: { HOST_NAME: 'api.example.test', API_TOKEN: 'synthetic-token' } },
      'GET https://{{$processEnv HOST_NAME}}/{{$dotenv API_KEY}}/{{$processEnv API_TOKEN}}',
    );

    expect(result.ok && result.sensitiveValues).toEqual(['synthetic-key', 'synthetic-token']);
  });

  it('reports malformed arguments with the expected format', () => {
    expect(problem({}, 'GET https://api.example.test/{{$secret}}')).toContain('`$secret <name>`');
    expect(problem({}, 'GET https://api.example.test/{{$dotenv a b}}')).toContain(
      '`$dotenv [%]<name>`',
    );
    expect(problem({}, 'GET https://api.example.test/{{$processEnv a-b}}')).toContain(
      '`$processEnv [%]<name>`',
    );
  });

  it('lists the secrets a request needs through file and environment variables', () => {
    const file = parseHttpFile(
      [
        '@auth = Bearer {{$secret apiToken}}',
        'GET https://api.example.test/{{$secret pathKey}}',
        'Authorization: {{auth}}',
        'X-Other: {{other}} {{$secret apiToken}}',
      ].join('\n'),
    );
    const request = file.requests[0];
    if (!request) {
      throw new Error('expected a request');
    }

    expect(
      referencedSecrets(
        file,
        request,
        testSources({
          environmentName: 'dev',
          environment: sourced({ other: '{{$secret envKey}}' }, 'dev environment (settings)'),
        }),
      ),
    ).toEqual(['pathKey', 'apiToken', 'envKey']);
  });

  it('never repeats a looked-up name when % indirection fails', () => {
    const sources = {
      ...loaded,
      environmentName: 'dev',
      environment: sourced({ apiToken: 'synthetic-token-value' }, 'dev environment (settings)'),
    };

    const processMessage = problem(
      sources,
      'GET https://api.example.test/{{$processEnv %apiToken}}',
    );
    const dotenvMessage = problem(sources, 'GET https://api.example.test/{{$dotenv %apiToken}}');

    expect(processMessage).toBe(
      "`{{$processEnv %apiToken}}`: the variable named by `{{apiToken}}` is not set in VS Code's environment.",
    );
    expect(dotenvMessage).toBe(
      `\`{{$dotenv %apiToken}}\`: the key named by \`{{apiToken}}\` is not in ${dotenvPath}.`,
    );
  });

  it('with no captures in the session, a response reference blocks as not run', () => {
    const file = parseHttpFile(
      [
        '# @name login',
        'POST https://api.example.test/login',
        '',
        '###',
        'GET https://api.example.test/items',
        'Authorization: Bearer {{login.response.body.$.token}}',
      ].join('\n'),
    );
    const request = file.requests[1];
    if (!request) {
      throw new Error('expected a request');
    }

    expect(resolveRequest(file, request, testSources())).toEqual({
      ok: false,
      problems: [
        {
          message:
            '`{{login.response.body.$.token}}` comes from login, which has not run in this session.',
          range: {
            start: { line: 5, character: 22 },
            end: { line: 5, character: 53 },
          },
          producer: 'login',
        },
      ],
      waits: [],
    });
  });

  it('keeps $aadToken unsupported', () => {
    expect(problem({}, 'GET https://api.example.test/{{$aadToken}}')).toContain(
      'not supported yet',
    );
  });
});
