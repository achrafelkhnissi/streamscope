export type StreamFormat = 'sse' | 'ndjson' | 'json' | 'text' | 'raw';
export type StreamDirective = StreamFormat | 'auto';

export interface FormatDecision {
  format: StreamFormat;
  reason: 'directive' | 'content-type' | 'detected';
  contentType: string | undefined;
}

const ndjsonTypes: ReadonlySet<string> = new Set([
  'application/x-ndjson',
  'application/jsonl',
  'application/json-lines',
  'application/stream+json',
]);
const sniffedTypes: ReadonlySet<string> = new Set([
  'application/json',
  'text/plain',
  'application/octet-stream',
]);
const formatNames: Readonly<Record<StreamFormat, string>> = {
  sse: 'SSE',
  ndjson: 'NDJSON',
  json: 'JSON',
  text: 'Text',
  raw: 'Raw',
};

export function mediaType(contentType: string | undefined): string | undefined {
  const media = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return media === '' ? undefined : media;
}

export function classifyContentType(
  contentType: string | undefined,
): 'sse' | 'ndjson' | 'text' | 'sniff' {
  const media = mediaType(contentType);
  if (media === undefined || sniffedTypes.has(media)) {
    return 'sniff';
  }
  if (media === 'text/event-stream') {
    return 'sse';
  }
  return ndjsonTypes.has(media) ? 'ndjson' : 'text';
}

export function formatLabel(decision: FormatDecision): string {
  const name = formatNames[decision.format];
  const server =
    decision.contentType === undefined ? 'no Content-Type' : `server said ${decision.contentType}`;
  switch (decision.reason) {
    case 'directive':
      return `${name} (# @stream ${decision.format})`;
    case 'content-type':
      return `${name} (${server})`;
    case 'detected':
      return `${name} (detected; ${server})`;
  }
}
