import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import {
  describeReference,
  secretCandidates,
  variableCompletions,
  variableDiagnostics,
} from '../../../src/variables/inspect';
import type { VariableSources } from '../../../src/variables/sources';
import { sourced, testSources } from './sources';

function file(...lines: string[]) {
  return parseHttpFile(lines.join('\n'));
}

const environment: Partial<VariableSources> = {
  environmentName: 'dev',
  environment: sourced(
    { host: 'dev.example.test', apiKey: 'synthetic-key' },
    'dev environment (http-client.env.json)',
  ),
  shared: sourced({ version: 'v1', host: 'shared.example.test' }, '$shared (settings)'),
};

describe('describeReference', () => {
  it('describes a file variable with its origin', () => {
    expect(
      describeReference(file('@base = /v1', 'GET https://x/{{base}}'), 'base', testSources()),
    ).toEqual({
      kind: 'value',
      value: '/v1',
      origin: 'file variable',
      sensitive: false,
    });
  });

  it('describes an environment value with its environment and file', () => {
    expect(
      describeReference(file('GET https://{{host}}/'), 'host', testSources(environment)),
    ).toEqual({
      kind: 'value',
      value: 'dev.example.test',
      origin: 'dev environment (http-client.env.json)',
      sensitive: false,
    });
    expect(
      describeReference(file('GET https://x/'), '$shared version', testSources(environment)),
    ).toEqual({
      kind: 'value',
      value: 'v1',
      origin: '$shared (settings)',
      sensitive: false,
    });
  });

  it('marks a credential-named value as sensitive', () => {
    const description = describeReference(
      file('GET https://x/'),
      'apiKey',
      testSources(environment),
    );

    expect(description).toMatchObject({ kind: 'value', sensitive: true });
  });

  it('never evaluates generated variables', () => {
    const sources = testSources({
      system: {
        now: () => {
          throw new Error('evaluated now');
        },
        uuid: () => {
          throw new Error('evaluated uuid');
        },
        randomInt: () => {
          throw new Error('evaluated randomInt');
        },
      },
    });

    for (const expression of [
      '$guid',
      '$timestamp',
      '$datetime iso8601',
      '$localDatetime rfc1123',
      '$randomInt 1 9',
    ]) {
      expect(describeReference(file('GET https://x/'), expression, sources).kind, expression).toBe(
        'generated',
      );
    }
    expect(describeReference(file('GET https://x/'), '$timestamp 1 x', sources)).toMatchObject({
      kind: 'problem',
    });
  });

  it('says whether a secret is stored without revealing it', () => {
    const sources = testSources({ secrets: new Map([['apiToken', 'synthetic-token']]) });

    expect(describeReference(file('GET https://x/'), '$secret apiToken', sources)).toEqual({
      kind: 'secret',
      name: 'apiToken',
      stored: true,
    });
    expect(describeReference(file('GET https://x/'), '$secret other', sources)).toEqual({
      kind: 'secret',
      name: 'other',
      stored: false,
    });
  });

  it('describes an undefined variable as a problem', () => {
    expect(describeReference(file('GET https://x/'), 'missing', testSources())).toEqual({
      kind: 'problem',
      message: '`{{missing}}` is not defined in this file or `$shared` (no environment selected).',
    });
  });
});

describe('variableDiagnostics', () => {
  it('warns about undefined variables and errors on malformed system variables', () => {
    const diagnostics = variableDiagnostics(
      file('GET https://{{host}}/{{missing}}/{{$timestamp 1 x}}'),
      testSources(environment),
    );

    expect(
      diagnostics.map(({ code, severity, range }) => [code, severity, range.start.character]),
    ).toEqual([
      ['undefined-variable', 'warning', 21],
      ['invalid-variable', 'error', 33],
    ]);
  });

  it('does not check secret, .env and process values or request references', () => {
    expect(
      variableDiagnostics(
        file(
          'GET https://x/{{$secret apiToken}}/{{$dotenv KEY}}/{{$processEnv KEY}}',
          'X-Token: {{login.response.body.$.token}}',
        ),
        testSources(),
      ),
    ).toEqual([]);
  });

  it('reports malformed secret, .env and process variables', () => {
    expect(
      variableDiagnostics(file('GET https://x/{{$secret}}/{{$dotenv a b}}'), testSources()).map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(['invalid-variable', 'invalid-variable']);
  });
});

describe('variableCompletions', () => {
  it('lists file, environment and $shared variables, then system variables', () => {
    const labels = variableCompletions(
      file('@base = /v1', '@host = file', 'GET https://x/'),
      testSources(environment),
    ).map((completion) => completion.label);

    expect(labels).toEqual([
      'base',
      'host',
      'apiKey',
      'version',
      '$guid',
      '$timestamp',
      '$datetime',
      '$localDatetime',
      '$randomInt',
      '$processEnv',
      '$dotenv',
      '$secret',
      '$shared',
    ]);
  });
});

describe('secretCandidates', () => {
  it('finds literal values of credential-named file variables', () => {
    expect(
      secretCandidates(
        file('@apiToken = synthetic-token', '@password = {{$secret pw}}', '@host = x', '@secret ='),
      ).map((variable) => variable.name),
    ).toEqual(['apiToken']);
  });
});
