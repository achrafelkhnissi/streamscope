import { describe, expect, it } from 'vitest';
import {
  classifyContentType,
  formatLabel,
  mediaType,
  type FormatDecision,
  type StreamFormat,
} from '../../../src/streaming/detect';

type ContentTypeClass = ReturnType<typeof classifyContentType>;

function decision(
  format: StreamFormat,
  reason: FormatDecision['reason'],
  contentType: string | undefined,
): FormatDecision {
  return { format, reason, contentType };
}

describe('mediaType', () => {
  it('lowercases the value and drops parameters', () => {
    expect(mediaType('Application/JSON; charset=utf-8')).toBe('application/json');
    expect(mediaType('text/event-stream;charset=UTF-8')).toBe('text/event-stream');
    expect(mediaType('TEXT/PLAIN')).toBe('text/plain');
    expect(mediaType('multipart/form-data; boundary=a; charset=b')).toBe('multipart/form-data');
  });

  it('trims whitespace around the media type', () => {
    expect(mediaType('  text/plain  ; charset=utf-8')).toBe('text/plain');
  });

  it('returns undefined when the value is absent or empty', () => {
    expect(mediaType(undefined)).toBeUndefined();
    expect(mediaType('')).toBeUndefined();
    expect(mediaType('   ')).toBeUndefined();
  });
});

describe('classifyContentType', () => {
  it('classifies content types', () => {
    const cases: readonly (readonly [string | undefined, ContentTypeClass])[] = [
      ['text/event-stream', 'sse'],
      ['application/x-ndjson', 'ndjson'],
      ['application/jsonl', 'ndjson'],
      ['application/json-lines', 'ndjson'],
      ['application/stream+json', 'ndjson'],
      ['application/json', 'sniff'],
      ['text/plain', 'sniff'],
      ['application/octet-stream', 'sniff'],
      [undefined, 'sniff'],
      ['', 'sniff'],
      ['Application/JSON; charset=utf-8', 'sniff'],
      ['text/plain; charset=utf-8', 'sniff'],
      ['Text/Event-Stream; charset=utf-8', 'sse'],
      ['APPLICATION/X-NDJSON', 'ndjson'],
      ['application/jsonl; charset=utf-8', 'ndjson'],
      ['text/html', 'text'],
      ['text/html; charset=utf-8', 'text'],
      ['text/csv', 'text'],
      ['application/xml', 'text'],
      ['image/png', 'text'],
    ];
    for (const [contentType, expected] of cases) {
      expect(classifyContentType(contentType), String(contentType)).toBe(expected);
    }
  });
});

describe('formatLabel', () => {
  it('labels decisions', () => {
    expect(formatLabel(decision('sse', 'directive', undefined))).toBe('SSE (# @stream sse)');
    expect(formatLabel(decision('sse', 'content-type', 'text/event-stream'))).toBe(
      'SSE (server said text/event-stream)',
    );
    expect(formatLabel(decision('ndjson', 'detected', 'application/json'))).toBe(
      'NDJSON (detected; server said application/json)',
    );
    expect(formatLabel(decision('text', 'detected', undefined))).toBe(
      'Text (detected; no Content-Type)',
    );
  });

  it('names every format', () => {
    const names: readonly (readonly [StreamFormat, string])[] = [
      ['sse', 'SSE'],
      ['ndjson', 'NDJSON'],
      ['json', 'JSON'],
      ['text', 'Text'],
      ['raw', 'Raw'],
    ];
    for (const [format, name] of names) {
      expect(formatLabel(decision(format, 'directive', undefined))).toBe(
        `${name} (# @stream ${format})`,
      );
      expect(formatLabel(decision(format, 'content-type', 'text/html'))).toBe(
        `${name} (server said text/html)`,
      );
      expect(formatLabel(decision(format, 'detected', 'text/plain'))).toBe(
        `${name} (detected; server said text/plain)`,
      );
      expect(formatLabel(decision(format, 'detected', undefined))).toBe(
        `${name} (detected; no Content-Type)`,
      );
    }
  });

  it('ignores the content type for directives', () => {
    expect(formatLabel(decision('ndjson', 'directive', 'text/event-stream'))).toBe(
      'NDJSON (# @stream ndjson)',
    );
  });
});
