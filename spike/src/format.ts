import type { JsonValue, StreamEvent } from '../../src/events/model';
import type { EventStore } from '../../src/events/store';
import { formatLabel } from '../../src/streaming/detect';
import type { SpikeStream } from './stream';

import type { ViewName } from '../webview/messages';

export type { ViewName };

export const viewNames: readonly ViewName[] = [
  'events',
  'reply',
  'raw',
  'headers',
  'body',
  'checks',
];

const previewLength = 200;

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function json(value: JsonValue | undefined, indent?: number): string {
  return value === undefined ? '' : JSON.stringify(value, replacer, indent);
}

export function eventText(event: StreamEvent, indent?: number): string {
  return typeof event.value === 'string' ? event.value : json(event.value, indent);
}

export function clock(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = (ms % 60_000) / 1000;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(3).padStart(6, '0')}`;
}

export function preview(event: StreamEvent | undefined): string {
  if (event === undefined) {
    return '';
  }
  const text = eventText(event);
  return text.length > previewLength ? `${text.slice(0, previewLength)}…` : text;
}

export function eventLine(
  store: EventStore,
  index: number,
  event: StreamEvent | undefined,
): string {
  const summary = store.summary(index);
  const label = summary?.label ?? summary?.kind ?? '';
  return `[${String(index).padStart(6, '0')}]  +${clock(summary?.time ?? 0)}  ${label}  ${preview(event)}`;
}

export function statusText(stream: SpikeStream): string {
  const count = stream.session?.store.count ?? 0;
  const format = stream.session?.format;
  const state = {
    connecting: 'Connecting',
    streaming: 'Streaming',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Stopped',
  }[stream.status];
  const parts = [
    state,
    `${count.toLocaleString('en-US')} events`,
    clock(stream.elapsedMs),
    ...(format === undefined ? [] : [formatLabel(format)]),
  ];
  return parts.join(' · ');
}

export function headersText(stream: SpikeStream): string {
  const head = stream.head;
  if (head === undefined) {
    return 'Waiting for the response headers…';
  }
  return [
    `HTTP/${head.httpVersion} ${String(head.status)} ${head.statusText}`,
    ...head.headers.map(([name, value]) => `${name}: ${value}`),
  ].join('\n');
}

export function replyText(stream: SpikeStream): string {
  const reply = stream.session?.reply;
  if (reply === undefined) {
    return '';
  }
  return reply.truncated ? `${reply.text()}\n\n(truncated)` : reply.text();
}

export const bodyText = 'This response is a stream. Its body is shown in Raw.';
export const checksText = 'No checks: # @expect lines arrive in milestone M9.';
