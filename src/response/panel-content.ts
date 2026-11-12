import type { JsonValue, StreamEvent } from '../events/model';
import { maskValues } from '../masking/masking';
import type { RawData, RunSnapshot } from '../runs/run';
import { formatLabel } from '../streaming/detect';
import { formatBody } from './format-body';
import { formatBytes, formatDuration } from './labels';
import { panelLimits, type PanelBody, type PanelStatus } from './panel-protocol';

type JsonObject = { readonly [key: string]: JsonValue };

interface Frame {
  depth: number;
  close: string;
  at: number;
  items: readonly JsonValue[] | undefined;
  object: JsonObject | undefined;
  keys: readonly string[];
}

const rawNotes: Record<RawData, string | undefined> = {
  saved: undefined,
  stopped: 'raw data no longer saved',
  removed: 'raw data removed',
  unsaved: 'raw data not saved',
};
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const { rawJSON } = JSON as unknown as { rawJSON: (text: string) => unknown };
const indentUnit = '  ';
const newline = 0x0a;
const highSurrogateAtEnd = /[\uD800-\uDBFF]$/;

function isList(node: readonly JsonValue[] | JsonObject): node is readonly JsonValue[] {
  return Array.isArray(node);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function isEventStream(run: RunSnapshot): boolean {
  return !run.bodyKept;
}

export function panelStatus(run: RunSnapshot): PanelStatus {
  const stream = run.stream;
  const events = stream?.store.count ?? 0;
  const streaming = isEventStream(run);
  const parts: string[] = [];
  if (run.head !== undefined) {
    parts.push(`${String(run.head.status)} ${run.head.statusText}`.trim());
  }
  if (streaming) {
    parts.push(plural(events, 'event'));
  }
  if (run.head !== undefined) {
    parts.push(formatBytes(run.receivedBytes));
  }
  parts.push(formatDuration(run.elapsedMs));
  const reason =
    run.status === 'failed'
      ? run.failure?.message
      : run.status === 'blocked'
        ? run.problems[0]?.message
        : undefined;
  if (reason !== undefined && reason !== '') {
    parts.push(reason);
  }
  const note = streaming ? rawNotes[run.rawData] : undefined;
  if (note !== undefined) {
    parts.push(note);
  }
  return {
    state: run.status,
    text: maskValues(parts.join(' · '), run.sensitiveValues),
    running: run.status === 'sending' || run.status === 'receiving',
    events,
    warnings: stream?.warnings.length ?? 0,
    format: stream?.format === undefined ? undefined : formatLabel(stream.format),
    reply: stream?.reply.adapter !== undefined,
    replyCut: stream?.reply.truncated ?? false,
    released: run.released,
    rawGone: run.rawSource === 'gone',
    replyGone: run.replySource === 'gone',
  };
}

function characterStart(bytes: Uint8Array, at: number): number {
  let end = at;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return end;
}

export function panelBody(
  content: Uint8Array,
  language: string,
  totalBytes: number,
  partial = false,
): PanelBody {
  const limit = panelLimits.inlineBodyBytes;
  if (!partial && content.length <= limit) {
    return { kind: 'text', language, text: decoder.decode(content) };
  }
  let lines = 0;
  let end = characterStart(content, limit);
  for (let at = content.indexOf(newline); at !== -1 && at < limit;) {
    lines += 1;
    if (lines === panelLimits.previewLines) {
      end = at;
      break;
    }
    at = content.indexOf(newline, at + 1);
  }
  return { kind: 'preview', language, text: decoder.decode(content.subarray(0, end)), totalBytes };
}

export function previewBody(
  bytes: Uint8Array,
  contentType: string | undefined,
  totalBytes: number,
): PanelBody {
  const partial = bytes.length < totalBytes;
  const formatted = formatBody(bytes, contentType, partial ? { totalBytes } : undefined);
  return panelBody(
    encoder.encode(formatted.text),
    formatted.languageId,
    totalBytes,
    partial && !formatted.binary,
  );
}

class BoundedText {
  private readonly parts: string[] = [];
  private size = 0;
  full = false;

  constructor(private readonly maxChars: number) {}

  get room(): number {
    return this.maxChars - this.size;
  }

  write(piece: string): void {
    if (this.full) {
      return;
    }
    if (this.size + piece.length > this.maxChars) {
      this.parts.push(piece.slice(0, this.maxChars - this.size).replace(highSurrogateAtEnd, ''));
      this.size = this.maxChars;
      this.full = true;
      return;
    }
    this.parts.push(piece);
    this.size += piece.length;
  }

  get text(): string {
    return this.parts.join('');
  }
}

function prettyJson(value: JsonValue, maxChars: number): { text: string; truncated: boolean } {
  const out = new BoundedText(maxChars);
  const indents: string[] = [];
  const indent = (depth: number): string => (indents[depth] ??= indentUnit.repeat(depth));
  const stack: Frame[] = [];
  const open = (node: JsonValue, depth: number): void => {
    if (typeof node === 'bigint') {
      out.write(node.toString());
    } else if (typeof node === 'string') {
      out.write(JSON.stringify(node.length > out.room ? node.slice(0, out.room + 1) : node));
    } else if (node === null || typeof node !== 'object') {
      out.write(JSON.stringify(node));
    } else if (isList(node)) {
      if (node.length === 0) {
        out.write('[]');
      } else {
        out.write('[');
        stack.push({ depth, close: ']', at: 0, items: node, object: undefined, keys: [] });
      }
    } else {
      const keys = Object.keys(node);
      if (keys.length === 0) {
        out.write('{}');
      } else {
        out.write('{');
        stack.push({ depth, close: '}', at: 0, items: undefined, object: node, keys });
      }
    }
  };
  open(value, 0);
  for (let frame = stack.at(-1); frame !== undefined && !out.full; frame = stack.at(-1)) {
    const length = frame.items?.length ?? frame.keys.length;
    if (frame.at >= length) {
      stack.pop();
      out.write(`\n${indent(frame.depth)}${frame.close}`);
      continue;
    }
    out.write(frame.at === 0 ? '\n' : ',\n');
    out.write(indent(frame.depth + 1));
    let next: JsonValue | undefined;
    if (frame.items !== undefined) {
      next = frame.items[frame.at];
    } else {
      const key = frame.keys[frame.at] ?? '';
      out.write(`${JSON.stringify(key)}: `);
      next = frame.object?.[key];
    }
    frame.at += 1;
    open(next ?? null, frame.depth + 1);
  }
  return { text: out.text, truncated: out.full };
}

export function eventText(
  event: StreamEvent,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (typeof event.value === 'string' && event.kind !== 'json') {
    if (event.value.length <= maxChars) {
      return { text: event.value, truncated: false };
    }
    return {
      text: event.value.slice(0, maxChars).replace(highSurrogateAtEnd, ''),
      truncated: true,
    };
  }
  return prettyJson(event.value, maxChars);
}

function keepLargeInteger(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? rawJSON(value.toString()) : value;
}

export function compactEventJson(value: JsonValue): string {
  return JSON.stringify(value, keepLargeInteger);
}

export function eventNote(
  event: StreamEvent,
  index: number,
  truncated: boolean,
): string | undefined {
  if (event.kind === 'oversize') {
    return `Event ${String(index)} is larger than streamscope.stream.maxEventSize, so only its beginning was kept.`;
  }
  return truncated
    ? `Event ${String(index)} is too large to show in full here; this is its beginning.`
    : undefined;
}

export function capTail(text: string, maxBytes: number): { text: string; cut: boolean } {
  let excess = Buffer.byteLength(text) - maxBytes;
  if (excess <= 0) {
    return { text, cut: false };
  }
  let start = Math.max(0, text.length - maxBytes);
  let kept = text;
  for (;;) {
    if (isLowSurrogate(text.charCodeAt(start))) {
      start += 1;
    }
    kept = text.slice(start);
    excess = Buffer.byteLength(kept) - maxBytes;
    if (excess <= 0) {
      return { text: kept, cut: true };
    }
    start += Math.max(1, Math.ceil(excess / 3));
  }
}
