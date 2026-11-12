export type JsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type EventKind = 'json' | 'text' | 'malformed' | 'oversize' | 'comment';

export interface SseFields {
  event: string | undefined;
  id: string | undefined;
  retry: number | undefined;
}

export interface StreamEvent {
  index: number;
  time: number;
  offset: number;
  length: number;
  line: number;
  kind: EventKind;
  value: JsonValue;
  label: string | undefined;
  sse: SseFields | undefined;
  marker: 'done' | 'error' | undefined;
  error: string | undefined;
  unterminated: boolean;
}

export type ParsedEvent = Omit<StreamEvent, 'index' | 'time' | 'label'>;
