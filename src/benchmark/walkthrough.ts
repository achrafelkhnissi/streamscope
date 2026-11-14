function shortStream(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('seconds', '1');
  return parsed.toString();
}

export function walkthroughRequest(url: string): string {
  return [
    '# @name walkthrough',
    '# @capture threadId = first(type == "RUN_STARTED").threadId',
    '# @expect status == 200',
    '# @expect status == 201',
    `GET ${url}`,
    '',
  ].join('\n');
}

export function walkthroughTestFile(url: string): string {
  const short = shortStream(url);
  return [
    '### Passing',
    '# @name passing',
    '# @expect status == 200',
    `GET ${short}`,
    '',
    '### Failing',
    '# @name failing',
    '# @expect status == 201',
    `GET ${short}`,
    '',
    '### Refused',
    '# @name refused',
    '# @capture threadId = first(type == "RUN_STARTED").threadId',
    'GET http://127.0.0.1:1/',
    '',
    '### Dependant',
    '# @name dependant',
    `GET ${short}`,
    'X-Thread: {{refused.threadId}}',
    '',
  ].join('\n');
}
