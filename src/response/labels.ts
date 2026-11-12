import type { HttpRequest } from '../http-file/model';
import { maskUrl, maskValues } from '../masking/masking';
import type { RunSnapshot } from '../runs/run';
import type { StreamFormat } from '../streaming/detect';
import type { BodyLanguage } from './format-body';

const units = ['KB', 'MB', 'GB'];
const unsafeFileCharacters = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const maxFileNameLength = 60;
const bodyExtensions: Record<BodyLanguage, string> = {
  json: '.json',
  xml: '.xml',
  html: '.html',
  javascript: '.js',
  css: '.css',
  plaintext: '.txt',
};
const saveExtensions: Record<string, string> = {
  'application/json': '.json',
  'application/x-ndjson': '.ndjson',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/html': '.html',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? ''}`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function requestLabel(request: HttpRequest): string {
  return (
    request.name ??
    request.title ??
    `${request.requestLine.method.toUpperCase()} ${maskUrl(request.requestLine.url)}`
  );
}

export function fileSafeName(label: string): string {
  return label.replace(unsafeFileCharacters, '_').slice(0, maxFileNameLength);
}

export function bodyExtension(languageId: BodyLanguage): string {
  return bodyExtensions[languageId];
}

export function saveExtension(contentType: string | undefined, format?: StreamFormat): string {
  if (format === 'ndjson' || format === 'sse') {
    return `.${format}`;
  }
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return saveExtensions[type] ?? (type.endsWith('+json') ? '.json' : '.bin');
}

export function describeOutcome(run: RunSnapshot): string {
  return maskValues(outcomeText(run), run.sensitiveValues);
}

export function eventCount(run: RunSnapshot): string | undefined {
  if (run.bodyKept || run.stream === undefined) {
    return undefined;
  }
  const count = run.stream.store.count;
  return `${String(count)} ${count === 1 ? 'event' : 'events'}`;
}

function outcomeText(run: RunSnapshot): string {
  const events = eventCount(run);
  switch (run.status) {
    case 'completed':
      return `${String(run.head?.status ?? '')} ${run.head?.statusText ?? ''} · ${events ?? formatBytes(run.body.length)} · ${formatDuration(run.elapsedMs)}`;
    case 'failed':
      return `Failed: ${run.failure?.message ?? ''}`;
    case 'cancelled':
      return `Cancelled after ${formatDuration(run.elapsedMs)}`;
    case 'blocked':
      return `Not sent: ${run.problems[0]?.message ?? ''}`;
    default:
      return events === undefined
        ? `Running · ${formatDuration(run.elapsedMs)}`
        : `Running · ${events} · ${formatDuration(run.elapsedMs)}`;
  }
}
