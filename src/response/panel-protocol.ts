export type PanelView = 'events' | 'reply' | 'raw' | 'headers' | 'body' | 'checks';

export const panelViews: readonly PanelView[] = [
  'events',
  'reply',
  'raw',
  'headers',
  'body',
  'checks',
];

export const panelLimits = {
  rowsPerMessage: 500,
  messageBytes: 1_048_576,
  inlineEventBytes: 65_536,
  inlineBodyBytes: 1_048_576,
  previewLines: 200,
  rawTailChars: 2_097_152,
  windowRows: 400,
} as const;

export type PanelEventKind = 'json' | 'text' | 'malformed' | 'oversize' | 'comment';

export type PanelRunState =
  'sending' | 'receiving' | 'completed' | 'failed' | 'cancelled' | 'blocked';

export interface PanelRow {
  index: number;
  time: string;
  label: string;
  preview: string;
  kind: PanelEventKind;
}

export interface PanelStatus {
  state: PanelRunState;
  text: string;
  running: boolean;
  events: number;
  warnings: number;
  format: string | undefined;
  reply: boolean;
  replyCut: boolean;
  released: boolean;
  rawGone: boolean;
  replyGone: boolean;
}

export interface TextDelta {
  reset: boolean;
  text: string;
}

export type PanelBody =
  | { kind: 'none' }
  | { kind: 'arriving' }
  | { kind: 'stream' }
  | { kind: 'unavailable' }
  | { kind: 'text'; language: string; text: string }
  | { kind: 'preview'; language: string; text: string; totalBytes: number };

export type ToPanel =
  | {
      type: 'reset';
      run: number;
      view: PanelView;
      readOnly: boolean;
      status: PanelStatus;
      headers: string;
      body: PanelBody;
    }
  | {
      type: 'update';
      run: number;
      status: PanelStatus;
      count: number;
      rows: PanelRow[];
      reply: TextDelta | undefined;
      raw: TextDelta | undefined;
      body: PanelBody | undefined;
      headers: string | undefined;
    }
  | { type: 'rows'; run: number; rows: PanelRow[] }
  | {
      type: 'detail';
      run: number;
      index: number;
      text: string;
      note: string | undefined;
      truncated: boolean;
    }
  | { type: 'select'; view: PanelView }
  | { type: 'expand'; index: number };

export type FromPanel =
  | { type: 'ready' }
  | { type: 'window'; run: number; start: number; end: number; following: boolean }
  | { type: 'rendered'; run: number; newest: number }
  | { type: 'detail'; run: number; index: number }
  | { type: 'stop'; run: number }
  | { type: 'save'; run: number }
  | { type: 'tab'; view: PanelView }
  | { type: 'open'; run: number; target: 'body' | 'headers' }
  | { type: 'openEvent'; run: number; index: number };

const viewNames: readonly string[] = panelViews;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(record);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isRun(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isIndex(value: unknown, eventCount: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= eventCount;
}

function isView(value: unknown): value is PanelView {
  return typeof value === 'string' && viewNames.includes(value);
}

export function parsePanelMessage(value: unknown, eventCount: number): FromPanel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value.type) {
    case 'ready':
      return hasOnly(value, ['type']) ? { type: value.type } : undefined;
    case 'window': {
      const { run, start, end, following } = value;
      return hasOnly(value, ['type', 'run', 'start', 'end', 'following']) &&
        isRun(run) &&
        isIndex(start, eventCount) &&
        isIndex(end, eventCount) &&
        start <= end &&
        end - start < panelLimits.windowRows &&
        typeof following === 'boolean'
        ? { type: 'window', run, start, end, following }
        : undefined;
    }
    case 'stop':
    case 'save': {
      const { run } = value;
      return hasOnly(value, ['type', 'run']) && isRun(run) ? { type: value.type, run } : undefined;
    }
    case 'rendered': {
      const { run, newest } = value;
      return hasOnly(value, ['type', 'run', 'newest']) && isRun(run) && isIndex(newest, eventCount)
        ? { type: 'rendered', run, newest }
        : undefined;
    }
    case 'detail':
    case 'openEvent': {
      const { run, index } = value;
      return hasOnly(value, ['type', 'run', 'index']) && isRun(run) && isIndex(index, eventCount)
        ? { type: value.type, run, index }
        : undefined;
    }
    case 'tab': {
      const { view } = value;
      return hasOnly(value, ['type', 'view']) && isView(view) ? { type: 'tab', view } : undefined;
    }
    case 'open': {
      const { run, target } = value;
      return hasOnly(value, ['type', 'run', 'target']) &&
        isRun(run) &&
        (target === 'body' || target === 'headers')
        ? { type: 'open', run, target }
        : undefined;
    }
    default:
      return undefined;
  }
}
