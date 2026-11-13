import type { EventKind, JsonValue, StreamEvent } from '../events/model';
import type { EventStore } from '../events/store';
import { maxLabelLength } from '../streaming/limits';
import type { PanelRow } from './panel-protocol';

const previewLength = 200;
const scanFactor = 8;
const minimumScan = 256;
const lineBreak = /[\n\r\u0085\u2028\u2029]/;
const hiddenCharacter =
  /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

type JsonObject = { readonly [key: string]: JsonValue };

const markedKinds: Partial<Record<EventKind, string>> = {
  malformed: 'malformed',
  oversize: 'oversize',
};

function isList(node: readonly JsonValue[] | JsonObject): node is readonly JsonValue[] {
  return Array.isArray(node);
}

export function displayText(text: string, maxLength: number): string {
  const scanLimit = Math.max(maxLength * scanFactor, minimumScan);
  let scanned = 0;
  let shown = '';
  let afterBreak = false;
  for (const character of text) {
    scanned += character.length;
    if (scanned > scanLimit) {
      break;
    }
    const isBreak = lineBreak.test(character);
    if (isBreak && afterBreak) {
      continue;
    }
    afterBreak = isBreak;
    if (!isBreak && hiddenCharacter.test(character)) {
      continue;
    }
    const kept = isBreak ? ' ' : character;
    if (shown.length + kept.length > maxLength) {
      break;
    }
    shown += kept;
  }
  return shown;
}

function compactJson(value: JsonValue, limit: number): string {
  let out = '';
  const visit = (node: JsonValue): void => {
    if (typeof node === 'string') {
      out += JSON.stringify(node.slice(0, limit));
    } else if (typeof node === 'bigint') {
      out += node.toString();
    } else if (node === null || typeof node !== 'object') {
      out += String(node);
    } else if (isList(node)) {
      out += '[';
      for (let at = 0; at < node.length && out.length < limit; at += 1) {
        out += at === 0 ? '' : ',';
        visit(node[at] as JsonValue);
      }
      out += ']';
    } else {
      out += '{';
      let first = true;
      for (const key in node) {
        if (out.length >= limit) {
          break;
        }
        out += `${first ? '' : ','}${JSON.stringify(key.slice(0, limit))}:`;
        first = false;
        visit(node[key] as JsonValue);
      }
      out += '}';
    }
  };
  visit(value);
  return out;
}

function previewText(event: StreamEvent): string {
  return typeof event.value === 'string' && event.kind !== 'json'
    ? event.value
    : compactJson(event.value, previewLength);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function elapsed(milliseconds: number): string {
  const total = Math.round(milliseconds);
  return `${pad(Math.floor(total / 60_000), 2)}:${pad(Math.floor(total / 1000) % 60, 2)}.${pad(total % 1000, 3)}`;
}

export function panelRow(
  store: EventStore,
  index: number,
  event: StreamEvent | undefined,
): PanelRow {
  const summary = store.summary(index);
  const time = summary?.time ?? event?.time;
  const kind = summary?.kind ?? event?.kind ?? 'text';
  return {
    index,
    time: time === undefined ? '' : elapsed(time),
    label: displayText(summary?.label ?? event?.label ?? markedKinds[kind] ?? '', maxLabelLength),
    preview: event === undefined ? '' : displayText(previewText(event), previewLength),
    kind,
  };
}

export function capRows(rows: readonly PanelRow[], maxBytes: number): PanelRow[] {
  let size = 2;
  let from = rows.length;
  while (from > 0) {
    const separator = from === rows.length ? 0 : 1;
    const next = size + separator + Buffer.byteLength(JSON.stringify(rows[from - 1]));
    if (next > maxBytes) {
      break;
    }
    size = next;
    from -= 1;
  }
  return rows.slice(from);
}

export function capText(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) {
    return { text, cut: false };
  }
  const bytes = Buffer.from(text.slice(0, maxBytes));
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: bytes.toString('utf8', 0, end), cut: true };
}
