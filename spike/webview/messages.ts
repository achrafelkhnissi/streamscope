export type ViewName = 'events' | 'reply' | 'raw' | 'headers' | 'body' | 'checks';

export type StreamState = 'connecting' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface Row {
  index: number;
  time: string;
  label: string;
  preview: string;
}

export interface Captured {
  name: string;
  value: string | undefined;
}

export interface TextDelta {
  reset: boolean;
  text: string;
}

export interface UpdateMessage {
  type: 'update';
  reset: boolean;
  count: number;
  state: StreamState;
  status: string;
  running: boolean;
  captured: Captured[];
  rows: Row[];
  reply: TextDelta | undefined;
  raw: TextDelta | undefined;
  headers: { status: string; fields: [string, string][] } | undefined;
}

export type ToWebview =
  | UpdateMessage
  | { type: 'rows'; rows: Row[] }
  | { type: 'detail'; index: number; json: string }
  | { type: 'select'; view: ViewName }
  | { type: 'expand'; index: number }
  | { type: 'focusCapture' };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'window'; start: number; end: number; following: boolean }
  | { type: 'rendered'; newest: number }
  | { type: 'detail'; index: number }
  | { type: 'stop' }
  | { type: 'tab'; view: ViewName }
  | { type: 'capture'; index: number };
