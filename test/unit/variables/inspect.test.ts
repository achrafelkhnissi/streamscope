import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import {
  describeReference,
  secretCandidates,
  variableCompletions,
  variableDiagnostics,
} from '../../../src/variables/inspect';
import type { CaptureLookupResult, VariableSources } from '../../../src/variables/sources';
import { inMemoryCaptures, sourced, testSources } from './sources';

function file(...lines: string[]) {
  return parseHttpFile(lines.join('\n'));
}

function at(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

const producer = [
  '# @name startRun',
  '# @capture threadId = first(type == "RUN_STARTED").threadId',
  'POST https://x/run',
  '',
  '###',
];

function captured(
  text: string,
  options: { secret?: boolean; event?: number; path?: string; time?: number } = {},
): CaptureLookupResult {
  return {
    kind: 'value',
    text,
    secret: options.secret ?? false,
    label: 'startRun',
    provenance: {
      runId: 3,
      event: options.event,
      path: options.path ?? '',
      time: options.time ?? 0,
    },
  };
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

  it("describeReference shows a capture's value, masked when secret, with its provenance", () => {
    const time = new Date(2026, 10, 13, 10, 20, 30).getTime();
    const sources = testSources({
      captures: inMemoryCaptures({
        requests: {
          'startRun.threadId': captured('thread-1', { event: 5, path: 'threadId', time }),
        },
        bare: {
          sessionToken: captured('synthetic-session', {
            secret: true,
            path: '["x-session-token"]',
            time,
          }),
        },
      }),
    });
    const http = file(...producer, 'GET https://x/');

    expect(describeReference(http, 'startRun.threadId', sources)).toEqual({
      kind: 'value',
      value: 'thread-1',
      origin: 'startRun › threadId · run 3 · event 5 at threadId · 10:20:30',
      sensitive: false,
    });
    expect(describeReference(http, 'sessionToken', sources)).toEqual({
      kind: 'value',
      value: '••••••',
      origin: 'startRun › sessionToken · run 3 · at ["x-session-token"] · 10:20:30',
      sensitive: true,
    });
  });

  it('says when a capture is pending, failed or not run', () => {
    const sources = testSources({
      captures: inMemoryCaptures({
        bare: {
          threadId: {
            kind: 'pending',
            request: 'file:///agent.http\n@startRun',
            label: 'startRun',
            name: 'threadId',
          },
          messageId: { kind: 'failed', message: 'startRun › messageId failed: the stream ended.' },
        },
      }),
    });
    const http = file(...producer, 'GET https://x/');

    expect(describeReference(http, 'threadId', sources)).toEqual({
      kind: 'problem',
      message: 'startRun › threadId has not arrived yet.',
    });
    expect(describeReference(http, 'messageId', sources)).toEqual({
      kind: 'problem',
      message: 'startRun › messageId failed: the stream ended.',
    });
    expect(describeReference(http, 'startRun.threadId', testSources())).toEqual({
      kind: 'problem',
      message: '`{{startRun.threadId}}` comes from startRun, which has not run in this session.',
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

  it('no undefined-variable warning for a capture the file declares', () => {
    expect(
      variableDiagnostics(
        file(...producer, 'GET https://x/{{startRun.threadId}}/{{threadId}}/{{messageId}}'),
        testSources({
          captures: inMemoryCaptures({ bare: { messageId: captured('message-1') } }),
        }),
      ),
    ).toEqual([]);
  });

  it('a dotted file variable named after a request has no diagnostic', () => {
    expect(
      variableDiagnostics(
        file('@api.base = https://api.example.test', '# @name api', 'GET {{api.base}}/health'),
        testSources(),
      ),
    ).toEqual([]);
  });

  it('dotted environment and $shared variables named after a request have no diagnostic', () => {
    expect(
      variableDiagnostics(
        file('# @name api', 'GET {{api.base}}/{{api.path}}'),
        testSources({
          environmentName: 'dev',
          environment: sourced(
            { 'api.base': 'https://api.example.test' },
            'dev environment (settings)',
          ),
          shared: sourced({ 'api.path': 'health' }, '$shared (settings)'),
        }),
      ),
    ).toEqual([]);
  });

  it('an unknown capture on a named request is an error', () => {
    expect(
      variableDiagnostics(file(...producer, 'GET https://x/{{startRun.threadI}}'), testSources()),
    ).toEqual([
      {
        code: 'undefined-variable',
        severity: 'error',
        message: 'startRun has no capture named threadI.',
        range: at(5, 14, 34),
      },
    ]);
  });

  it("a response reference's JSONPath is checked", () => {
    expect(
      variableDiagnostics(
        file(
          ...producer,
          'GET https://x/{{startRun.response.body.$.a[}}',
          'X-Token: {{startRun.response.body.$.token}}',
        ),
        testSources(),
      ),
    ).toEqual([
      {
        code: 'invalid-variable',
        severity: 'error',
        message: '`{{startRun.response.body.$.a[}}`: The JSONPath ends unexpectedly.',
        range: at(5, 14, 45),
      },
    ]);
  });

  it('request references and XPath are errors', () => {
    expect(
      variableDiagnostics(
        file(
          ...producer,
          'GET https://x/{{startRun.request.headers.A}}',
          'X-Token: {{startRun.response.body.token}}',
        ),
        testSources(),
      ),
    ).toEqual([
      {
        code: 'invalid-variable',
        severity: 'error',
        message:
          'Request references such as `{{startRun.request.headers.A}}` are not supported; use `{{startRun.response.…}}`.',
        range: at(5, 14, 44),
      },
      {
        code: 'invalid-variable',
        severity: 'error',
        message:
          'XPath is not supported in `{{startRun.response.body…}}`; use a JSONPath starting with `$`.',
        range: at(6, 9, 41),
      },
    ]);
  });

  it('checks response-reference JSONPaths within a 10 ms budget per pass', () => {
    let now = 0;
    const clock = (): number => {
      now += 20;
      return now;
    };
    const http = file(
      ...producer,
      'GET https://x/{{startRun.response.body.$.budgetOne[}}/{{startRun.response.body.$.budgetTwo[}}',
    );

    const first = variableDiagnostics(http, testSources(), clock);
    const second = variableDiagnostics(http, testSources(), clock);

    expect(first.map((diagnostic) => diagnostic.message)).toEqual([
      '`{{startRun.response.body.$.budgetOne[}}`: The JSONPath ends unexpectedly.',
    ]);
    expect(second.map((diagnostic) => diagnostic.message)).toEqual([
      '`{{startRun.response.body.$.budgetOne[}}`: The JSONPath ends unexpectedly.',
      '`{{startRun.response.body.$.budgetTwo[}}`: The JSONPath ends unexpectedly.',
    ]);
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
