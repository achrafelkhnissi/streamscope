import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '../../../src/http-file/parse';
import { resolveRequest, type Resolution } from '../../../src/variables/resolve';
import type { CaptureLookupResult, VariableSources } from '../../../src/variables/sources';
import { inMemoryCaptures, sourced, testSources } from './sources';
import type { SystemContext } from '../../../src/variables/system';

function counter(): SystemContext {
  let next = 0;
  return {
    now: () => new Date('2026-11-11T10:20:30.456Z'),
    uuid: () => {
      next += 1;
      return `uuid-${String(next)}`;
    },
    randomInt: (minInclusive) => minInclusive,
  };
}

function resolveWith(sources: Partial<VariableSources>, ...lines: string[]): Resolution {
  const file = parseHttpFile(lines.join('\n'));
  const request = file.requests[0];
  if (!request) {
    throw new Error('expected a request');
  }
  return resolveRequest(file, request, testSources({ system: counter(), ...sources }));
}

function resolve(...lines: string[]): Resolution {
  const file = parseHttpFile(lines.join('\n'));
  const request = file.requests[0];
  if (!request) {
    throw new Error('expected a request');
  }
  return resolveRequest(file, request, testSources({ system: counter() }));
}

function resolved(...lines: string[]) {
  const result = resolve(...lines);
  if (!result.ok) {
    throw new Error(result.problems.map((problem) => problem.message).join('\n'));
  }
  return result;
}

function problems(...lines: string[]) {
  const result = resolve(...lines);
  if (result.ok) {
    throw new Error('expected problems');
  }
  return result.problems;
}

function at(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

describe('resolveRequest', () => {
  it('resolves file variables in the url, header names and values, and body text', () => {
    const { request } = resolved(
      '@host = api.example.test',
      '@header = X-Trace',
      '@token = synthetic-token',
      '@name = Ada',
      'POST https://{{host}}/items',
      '{{header}}: {{token}}',
      '',
      '{"name": "{{name}}"}',
    );

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example.test/items');
    expect(request.urlRange).toEqual(at(4, 5, 27));
    expect(request.headers).toEqual([{ name: 'X-Trace', value: 'synthetic-token' }]);
    expect(request.body).toEqual([{ kind: 'text', lines: ['{"name": "Ada"}'] }]);
  });

  it('unescapes \\n, \\r, \\t and other escaped characters in file variable values', () => {
    const { request } = resolved(
      String.raw`@text = a\nb\tc\\d\qe\rf`,
      'POST https://api.example.test/items',
      '',
      '{{text}}',
    );

    expect(request.body).toEqual([{ kind: 'text', lines: ['a\nb\tc\\dqe\rf'] }]);
  });

  it('uses the last definition of a file variable', () => {
    const { request } = resolved(
      '@host = first.example.test',
      'GET https://{{host}}/items',
      '',
      '###',
      '@host = second.example.test',
    );

    expect(request.url).toBe('https://second.example.test/items');
  });

  it('resolves file variables that refer to later file variables and to system variables', () => {
    const { request } = resolved(
      '@base = https://{{host}}/v{{$randomInt 1 3}}',
      '@host = api.example.test',
      'GET {{base}}/items',
    );

    expect(request.url).toBe('https://api.example.test/v1/items');
  });

  it('evaluates a system variable inside a file variable once per send', () => {
    const { request } = resolved(
      '@id = {{$guid}}',
      'GET https://api.example.test/items/{{id}}',
      'X-Id: {{id}}',
    );

    expect(request.url).toBe('https://api.example.test/items/uuid-1');
    expect(request.headers).toEqual([{ name: 'X-Id', value: 'uuid-1' }]);
  });

  it('evaluates each system variable in the request separately', () => {
    const { request } = resolved('GET https://api.example.test/items/{{$guid}}', 'X-Id: {{$guid}}');

    expect(request.url).toBe('https://api.example.test/items/uuid-1');
    expect(request.headers).toEqual([{ name: 'X-Id', value: 'uuid-2' }]);
  });

  it('trims whitespace inside braces', () => {
    const { request } = resolved('@host = api.example.test', 'GET https://{{  host }}/items');

    expect(request.url).toBe('https://api.example.test/items');
  });

  it('does not re-scan inserted values', () => {
    const { request } = resolved(
      '@open = {{',
      '@raw = {{open}}host}}',
      '@host = api.example.test',
      'POST https://api.example.test/items',
      '',
      '{{raw}}',
    );

    expect(request.body).toEqual([{ kind: 'text', lines: ['{{host}}'] }]);
  });

  it('reports an undefined variable at every place it is used', () => {
    expect(problems('GET https://{{host}}/items', 'X-Host: {{host}}')).toEqual([
      {
        message: '`{{host}}` is not defined in this file or `$shared` (no environment selected).',
        range: at(0, 12, 20),
      },
      {
        message: '`{{host}}` is not defined in this file or `$shared` (no environment selected).',
        range: at(1, 8, 16),
      },
    ]);
  });

  it('reports an undefined variable inside a file variable at its value', () => {
    expect(problems('@base = https://{{host}}', 'GET {{base}}/items', 'X-Base: {{base}}')).toEqual([
      {
        message: '`{{host}}` is not defined in this file or `$shared` (no environment selected).',
        range: at(0, 8, 24),
      },
    ]);
  });

  it('reports file variables that refer to each other', () => {
    expect(problems('@a = {{b}}', '@b = {{a}}', 'GET https://api.example.test/{{a}}')).toEqual([
      { message: '`{{a}}` and `{{b}}` refer to each other.', range: at(0, 5, 10) },
    ]);
  });

  it('reports a file variable that refers to itself', () => {
    expect(problems('@a = x{{a}}', 'GET https://api.example.test/{{a}}')).toEqual([
      { message: '`{{a}}` refers to itself.', range: at(0, 5, 11) },
    ]);
  });

  it('reports system variable problems where they are used', () => {
    expect(problems('GET https://api.example.test/{{$aadToken}}')).toEqual([
      { message: '`{{$aadToken}}` is not supported yet.', range: at(0, 29, 42) },
    ]);
  });

  it('resolves variables in body file paths and keeps the file part', () => {
    const { request } = resolved(
      '@dir = fixtures',
      'POST https://api.example.test/upload',
      '',
      '<@latin1 ./{{dir}}/payload.json',
    );

    expect(request.body).toEqual([
      {
        kind: 'file',
        path: './fixtures/payload.json',
        processVariables: true,
        encoding: 'latin1',
        pathRange: at(3, 9, 31),
      },
    ]);
  });

  it('scope.resolveText resolves file and system variables in file contents', () => {
    const { scope } = resolved('@name = Ada', 'POST https://api.example.test/items');

    expect(scope.resolveText('{"name": "{{name}}",\n"id": "{{$guid}}"}')).toEqual({
      ok: true,
      text: '{"name": "Ada",\n"id": "uuid-1"}',
    });
    expect(scope.resolveText('{{missing}}')).toEqual({
      ok: false,
      problems: [
        {
          message:
            '`{{missing}}` is not defined in this file or `$shared` (no environment selected).',
        },
      ],
      waits: [],
    });
  });

  it('prefers a file variable over the environment and the environment over $shared', () => {
    const result = resolveWith(
      {
        environmentName: 'dev',
        environment: sourced({ a: 'environment', b: 'environment' }, 'dev environment (settings)'),
        shared: sourced({ a: 'shared', b: 'shared', c: 'shared' }, '$shared (settings)'),
      },
      '@a = file',
      'GET https://api.example.test/{{a}}/{{b}}/{{c}}',
    );

    expect(result.ok && result.request.url).toBe(
      'https://api.example.test/file/environment/shared',
    );
  });

  it('resolves environment values that reference other variables and $shared', () => {
    const result = resolveWith(
      {
        environmentName: 'dev',
        environment: sourced(
          { base: 'environment', path: '{{$shared base}}/x', other: '{{base}}-2' },
          'dev environment (settings)',
        ),
        shared: sourced({ base: 'shared' }, '$shared (settings)'),
      },
      'GET https://api.example.test/{{path}}/{{other}}',
    );

    expect(result.ok && result.request.url).toBe('https://api.example.test/shared/x/environment-2');
  });

  it('reports a cycle across file and environment variables', () => {
    const result = resolveWith(
      {
        environmentName: 'dev',
        environment: sourced({ b: '{{a}}' }, 'dev environment (settings)'),
      },
      '@a = {{b}}',
      'GET https://api.example.test/{{a}}',
    );

    expect(!result.ok && result.problems).toEqual([
      { message: '`{{a}}` and `{{b}}` refer to each other.', range: at(0, 5, 10) },
    ]);
  });

  it('names the environment and $shared when a variable is undefined', () => {
    const withEnvironment = resolveWith(
      { environmentName: 'dev' },
      'GET https://api.example.test/{{host}}',
    );
    const without = resolveWith({}, 'GET https://api.example.test/{{host}}');

    expect(!withEnvironment.ok && withEnvironment.problems[0]?.message).toBe(
      '`{{host}}` is not defined in this file, the `dev` environment or `$shared`.',
    );
    expect(!without.ok && without.problems[0]?.message).toBe(
      '`{{host}}` is not defined in this file or `$shared` (no environment selected).',
    );
  });

  it('reports a problem inside an environment value at the reference that used it', () => {
    const result = resolveWith(
      {
        environmentName: 'dev',
        environment: sourced({ token: '{{missing}}' }, 'dev environment (http-client.env.json)'),
      },
      'GET https://api.example.test/{{token}}',
    );

    expect(!result.ok && result.problems).toEqual([
      {
        message:
          'In `{{token}}` from dev environment (http-client.env.json): `{{missing}}` is not defined in this file, the `dev` environment or `$shared`.',
        range: at(0, 29, 38),
      },
    ]);
  });

  it('reports a $shared reference that $shared does not define', () => {
    const result = resolveWith({}, 'GET https://api.example.test/{{$shared base}}');

    expect(!result.ok && result.problems[0]?.message).toBe(
      '`{{$shared base}}` is not defined in `$shared`.',
    );
  });

  it('reports values from credential-named variables as sensitive', () => {
    const result = resolveWith(
      {
        environmentName: 'dev',
        environment: sourced(
          { apiKey: 'synthetic-key', host: 'api.example.test' },
          'dev environment (settings)',
        ),
      },
      '@accessToken = synthetic-token',
      'GET https://{{host}}/items',
      'Authorization: Bearer {{accessToken}}',
      'X-Key: {{apiKey}}',
    );

    expect(result.ok && result.sensitiveValues).toEqual(['synthetic-token', 'synthetic-key']);
  });

  it('adds the restricted-workspace hint to undefined variables', () => {
    const result = resolveWith(
      { environmentName: 'dev', restricted: true },
      'GET https://api.example.test/{{token}}',
    );

    expect(!result.ok && result.problems[0]?.message).toBe(
      '`{{token}}` is not defined in this file, the `dev` environment or `$shared`. A restricted workspace does not read http-client.private.env.json or environments from your user settings.',
    );
  });
});

const producer = [
  '### Start agent run',
  '# @name startRun',
  '# @capture threadId = first(type == "RUN_STARTED").threadId',
  '# @capture secret sessionToken = headers["x-session-token"]',
  'POST https://api.example.test/agent/run',
  '',
  '###',
];
const producerKey = 'file:///agent.http\n@startRun';

function captured(text: string, secret = false, label = 'startRun'): CaptureLookupResult {
  return {
    kind: 'value',
    text,
    secret,
    sensitive: [],
    label,
    provenance: { runId: 1, event: 1, path: 'threadId', time: 0 },
  };
}

function followUp(sources: Partial<VariableSources>, ...lines: string[]): Resolution {
  const file = parseHttpFile([...producer, ...lines].join('\n'));
  const request = file.requests.at(-1);
  if (!request) {
    throw new Error('expected a request');
  }
  return resolveRequest(file, request, testSources({ system: counter(), ...sources }));
}

describe('resolveRequest with captures', () => {
  it('a bare name reads a capture before a file variable of the same name', () => {
    const result = followUp(
      {
        captures: inMemoryCaptures({ bare: { threadId: captured('thread-1') } }),
        environmentName: 'dev',
        environment: sourced({ threadId: 'environment' }, 'dev environment (settings)'),
        shared: sourced({ threadId: 'shared' }, '$shared (settings)'),
      },
      '@threadId = file',
      'GET https://api.example.test/threads/{{threadId}}',
    );

    expect(result.ok && result.request.url).toBe('https://api.example.test/threads/thread-1');
  });

  it("`{{startRun.threadId}}` reads that request's capture", () => {
    const result = followUp(
      {
        captures: inMemoryCaptures({
          requests: { 'startRun.threadId': captured('thread-1') },
          bare: { threadId: captured('thread-2', false, 'otherRun') },
        }),
      },
      'GET https://api.example.test/threads/{{startRun.threadId}}',
    );

    expect(result.ok && result.request.url).toBe('https://api.example.test/threads/thread-1');
  });

  it('a pending capture yields a wait, not a problem', () => {
    const pending: CaptureLookupResult = {
      kind: 'pending',
      request: producerKey,
      label: 'startRun',
      name: 'threadId',
    };
    const result = followUp(
      {
        captures: inMemoryCaptures({
          requests: { 'startRun.threadId': pending },
          bare: { threadId: pending },
        }),
      },
      '@thread = {{threadId}}',
      'GET https://api.example.test/threads/{{startRun.threadId}}',
      'X-Thread: {{thread}}',
    );

    expect(result).toEqual({
      ok: false,
      problems: [],
      waits: [{ kind: 'capture', request: producerKey, name: 'threadId', label: 'startRun' }],
    });
  });

  it('a failed capture blocks with startRun › threadId failed: …', () => {
    const message =
      'startRun › threadId failed: no event matched first(type == "RUN_STARTED") (12 events, 1 malformed).';
    const result = followUp(
      {
        captures: inMemoryCaptures({
          requests: { 'startRun.threadId': { kind: 'failed', message } },
        }),
      },
      'GET https://api.example.test/threads/{{startRun.threadId}}',
    );

    expect(result).toEqual({
      ok: false,
      problems: [{ message, range: at(7, 37, 58) }],
      waits: [],
    });
  });

  it('a producer that never ran blocks with the decision 10 message and its producer name', () => {
    const bare = followUp(
      {
        captures: inMemoryCaptures({
          bare: { threadId: { kind: 'not-run', label: 'startRun', producerName: 'startRun' } },
        }),
      },
      'GET https://api.example.test/threads/{{threadId}}',
    );
    const named = followUp({}, 'GET https://api.example.test/threads/{{startRun.threadId}}');

    expect(bare).toEqual({
      ok: false,
      problems: [
        {
          message: '`{{threadId}}` comes from startRun, which has not run in this session.',
          range: at(7, 37, 49),
          producer: 'startRun',
        },
      ],
      waits: [],
    });
    expect(named).toEqual({
      ok: false,
      problems: [
        {
          message:
            '`{{startRun.threadId}}` comes from startRun, which has not run in this session.',
          range: at(7, 37, 58),
          producer: 'startRun',
        },
      ],
      waits: [],
    });
  });

  it('a name no request captures falls back to file, environment and $shared', () => {
    const result = followUp(
      {
        captures: inMemoryCaptures({ bare: { threadId: captured('thread-1') } }),
        environmentName: 'dev',
        environment: sourced({ a: 'environment', b: 'environment' }, 'dev environment (settings)'),
        shared: sourced({ a: 'shared', b: 'shared', c: 'shared' }, '$shared (settings)'),
      },
      '@a = file',
      'GET https://api.example.test/{{a}}/{{b}}/{{c}}',
    );

    expect(result.ok && result.request.url).toBe(
      'https://api.example.test/file/environment/shared',
    );
  });

  it('`{{startRun.threadI}}` blocks with startRun has no capture named threadI.', () => {
    const result = followUp(
      { captures: inMemoryCaptures({ requests: { 'startRun.threadI': captured('stale') } }) },
      'GET https://api.example.test/threads/{{startRun.threadI}}',
    );

    expect(result).toEqual({
      ok: false,
      problems: [{ message: 'startRun has no capture named threadI.', range: at(7, 37, 57) }],
      waits: [],
    });
  });

  it('response references read through the lookup and wait when needed', () => {
    const lines = [
      'POST https://api.example.test/agent/continue',
      'X-Session: {{startRun.response.headers.X-Session}}',
      '',
      '{"token": "{{startRun.response.body.$.token}}"}',
    ];
    const header = { 'startRun.response.headers.X-Session': captured('session-1') };
    const waiting = followUp({ captures: inMemoryCaptures({ responses: header }) }, ...lines);
    const done = followUp(
      {
        captures: inMemoryCaptures({
          responses: { ...header, 'startRun.response.body.$.token': captured('token-1') },
        }),
      },
      ...lines,
    );

    expect(waiting).toEqual({
      ok: false,
      problems: [],
      waits: [{ kind: 'response', requestName: 'startRun', reference: 'response.body.$.token' }],
    });
    expect(done.ok && done.request.headers).toEqual([{ name: 'X-Session', value: 'session-1' }]);
    expect(done.ok && done.request.body).toEqual([
      { kind: 'text', lines: ['{"token": "token-1"}'] },
    ]);
  });

  it('`{{x.request.headers.A}}` and XPath block with the decision 10 messages', () => {
    const file = parseHttpFile(
      [
        '# @name x',
        'GET https://api.example.test/x',
        '',
        '###',
        'GET https://api.example.test/{{x.request.headers.A}}',
        'X-Token: {{x.response.body.token}}',
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
            'Request references such as `{{x.request.headers.A}}` are not supported; use `{{x.response.…}}`.',
          range: at(4, 29, 52),
        },
        {
          message:
            'XPath is not supported in `{{x.response.body…}}`; use a JSONPath starting with `$`.',
          range: at(5, 9, 34),
        },
      ],
      waits: [],
    });
  });

  it('a response reference with an invalid JSONPath blocks without waiting', () => {
    expect(followUp({}, 'GET https://api.example.test/{{startRun.response.body.$.a[}}')).toEqual({
      ok: false,
      problems: [
        {
          message: '`{{startRun.response.body.$.a[}}`: The JSONPath ends unexpectedly.',
          range: at(7, 29, 60),
        },
      ],
      waits: [],
    });
  });

  it('a response reference to a request the file does not name blocks', () => {
    expect(followUp({}, 'GET https://api.example.test/{{login.response.body.$.token}}')).toEqual({
      ok: false,
      problems: [
        {
          message: '`{{login.response.body.$.token}}`: no request in this file is named login.',
          range: at(7, 29, 60),
        },
      ],
      waits: [],
    });
  });

  it("a secret capture's value joins sensitiveValues", () => {
    const result = followUp(
      {
        captures: inMemoryCaptures({
          bare: { threadId: captured('synthetic-thread', true), cursor: captured('cursor-1') },
        }),
      },
      'GET https://api.example.test/threads/{{threadId}}?after={{cursor}}',
    );

    expect(result.ok && result.request.url).toBe(
      'https://api.example.test/threads/synthetic-thread?after=cursor-1',
    );
    expect(result.ok && result.sensitiveValues).toEqual(['synthetic-thread']);
  });

  it('a large integer capture is inserted with every digit', () => {
    const result = followUp(
      {
        captures: inMemoryCaptures({
          requests: { 'startRun.threadId': captured('123456789012345678901234567890') },
        }),
      },
      'POST https://api.example.test/agent/continue',
      '',
      '{"threadId": {{startRun.threadId}}}',
    );

    expect(result.ok && result.request.body).toEqual([
      { kind: 'text', lines: ['{"threadId": 123456789012345678901234567890}'] },
    ]);
  });

  it('a captured value is inserted as it is, never scanned for references', () => {
    const result = followUp(
      {
        captures: inMemoryCaptures({ bare: { threadId: captured('{{$secret apiToken}}') } }),
        secrets: new Map([['apiToken', 'synthetic-token']]),
      },
      'POST https://api.example.test/agent/continue',
      '',
      '{"threadId": "{{threadId}}"}',
    );

    expect(result.ok && result.request.body).toEqual([
      { kind: 'text', lines: ['{"threadId": "{{$secret apiToken}}"}'] },
    ]);
    expect(result.ok && result.sensitiveValues).toEqual([]);
  });
});

describe('dotted variables named after a request', () => {
  function resolveLast(sources: Partial<VariableSources>, ...lines: string[]): Resolution {
    const file = parseHttpFile(lines.join('\n'));
    const request = file.requests.at(-1);
    if (!request) {
      throw new Error('expected a request');
    }
    return resolveRequest(file, request, testSources({ system: counter(), ...sources }));
  }

  it('a dotted file variable named after a request resolves to the variable', () => {
    const result = resolveLast(
      {},
      '@api.base = https://api.example.test',
      '# @name api',
      'GET {{api.base}}/health',
    );

    expect(result.ok && result.request.url).toBe('https://api.example.test/health');
  });

  it('dotted environment and $shared variables named after a request resolve to the variable', () => {
    const result = resolveLast(
      {
        environmentName: 'dev',
        environment: sourced(
          { 'api.base': 'https://api.example.test' },
          'dev environment (settings)',
        ),
        shared: sourced({ 'api.path': 'health' }, '$shared (settings)'),
      },
      '# @name api',
      'GET {{api.base}}/{{api.path}}',
    );

    expect(result.ok && result.request.url).toBe('https://api.example.test/health');
  });

  it('a declared capture wins over a dotted variable of the same name', () => {
    const result = resolveLast(
      {
        captures: inMemoryCaptures({
          requests: { 'api.base': captured('https://captured.example.test', false, 'api') },
        }),
        environmentName: 'dev',
        environment: sourced(
          { 'api.base': 'https://environment.example.test' },
          'dev environment (settings)',
        ),
      },
      '@api.base = https://file.example.test',
      '# @name api',
      '# @capture base = body.base',
      'GET https://api.example.test/start',
      '',
      '###',
      'GET {{api.base}}/health',
    );

    expect(result.ok && result.request.url).toBe('https://captured.example.test/health');
  });
});
