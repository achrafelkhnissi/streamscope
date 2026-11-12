import type {
  Captured,
  FromWebview,
  Row,
  TextDelta,
  ToWebview,
  UpdateMessage,
  ViewName,
} from './messages';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
const rowHeight = 22;
const margin = 40;
const maxScrollPixels = 8_000_000;
const rawLineLimit = 2000;
const views: readonly ViewName[] = ['events', 'reply', 'raw', 'headers', 'body', 'checks'];
const states: Record<UpdateMessage['state'], string> = {
  connecting: 'Connecting',
  streaming: 'Streaming',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
};
const token =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Missing #${id}`);
  }
  return found;
}

const list = element('list') as HTMLDivElement;
const spacer = element('spacer') as HTMLDivElement;
const pill = element('pill');
const statusNode = element('status');
const stop = element('stop') as HTMLButtonElement;
const captured = element('captured') as HTMLDivElement;
const reply = element('reply') as HTMLPreElement;
const raw = element('raw') as HTMLPreElement;
const statusLine = element('status-line') as HTMLPreElement;
const headers = element('headers') as HTMLTableElement;
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.tab')];

const rows = new Map<number, Row>();
const rowNodes = new Map<number, HTMLDivElement>();
let count = 0;
let following = true;
let selected: number | undefined;
let expanded: { index: number; node: HTMLDivElement; height: number } | undefined;
let lastWindow = '';
let lastAck = 0;
let renderQueued = false;
let rawPending = '';

function post(message: FromWebview): void {
  api.postMessage(message);
}

function top(index: number): number {
  const base = (index - 1) * rowHeight;
  return expanded !== undefined && index > expanded.index ? base + expanded.height : base;
}

function virtualHeight(): number {
  return count * rowHeight + (expanded?.height ?? 0);
}

function scrollRatio(): number {
  const height = virtualHeight();
  const space = Math.min(height, maxScrollPixels);
  const client = list.clientHeight;
  return height <= maxScrollPixels || space <= client ? 1 : (height - client) / (space - client);
}

function virtualScrollTop(): number {
  return list.scrollTop * scrollRatio();
}

function setVirtualScrollTop(offset: number): void {
  list.scrollTop = offset / scrollRatio();
}

function onScreen(offset: number): string {
  return `${String(list.scrollTop + offset - virtualScrollTop())}px`;
}

function indexAt(offset: number): number {
  if (expanded !== undefined && offset > top(expanded.index) + rowHeight) {
    return Math.floor((offset - expanded.height) / rowHeight) + 1;
  }
  return Math.floor(offset / rowHeight) + 1;
}

function queueRender(): void {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(render);
  }
}

function acknowledge(): void {
  let newest = 0;
  for (const index of rowNodes.keys()) {
    newest = Math.max(newest, index);
  }
  if (newest > lastAck) {
    lastAck = newest;
    post({ type: 'rendered', newest });
  }
}

function rowNode(row: Row): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'row';
  node.id = `row-${String(row.index)}`;
  node.setAttribute('role', 'option');
  for (const [name, text] of [
    ['index', `#${String(row.index)}`],
    ['time', `+${row.time}`],
    ['label', row.label],
    ['preview', row.preview],
  ] as const) {
    const span = document.createElement('span');
    span.className = name;
    span.textContent = text;
    node.append(span);
  }
  node.addEventListener('click', () => {
    select(row.index);
    toggle(row.index);
  });
  return node;
}

function render(): void {
  renderQueued = false;
  spacer.style.height = `${String(Math.min(virtualHeight(), maxScrollPixels))}px`;
  if (following) {
    list.scrollTop = list.scrollHeight;
  }
  const first = Math.max(1, Math.min(count, indexAt(virtualScrollTop())));
  const last = Math.min(count, first + Math.ceil(list.clientHeight / rowHeight));
  const from = Math.max(1, first - margin);
  const to = Math.min(count, last + margin);
  for (const [index, node] of rowNodes) {
    if (index < from || index > to || !rows.has(index)) {
      node.remove();
      rowNodes.delete(index);
    }
  }
  for (let index = from; index <= to; index += 1) {
    const row = rows.get(index);
    if (row === undefined) {
      continue;
    }
    let node = rowNodes.get(index);
    if (node === undefined) {
      node = rowNode(row);
      rowNodes.set(index, node);
      list.append(node);
    }
    node.style.top = onScreen(top(index));
    node.setAttribute('aria-selected', String(index === selected));
  }
  if (expanded !== undefined) {
    expanded.node.style.top = onScreen(top(expanded.index) + rowHeight);
  }
  for (const index of rows.keys()) {
    if (index < from - margin || index > to + margin) {
      rows.delete(index);
    }
  }
  const windowKey = following ? `tail:${String(to - from)}` : `${String(from)}:${String(to)}`;
  if (windowKey !== lastWindow) {
    lastWindow = windowKey;
    post({ type: 'window', start: from, end: to, following });
  }
  requestAnimationFrame(acknowledge);
}

function select(index: number): void {
  selected = index;
  list.setAttribute('aria-activedescendant', `row-${String(index)}`);
  queueRender();
}

function collapse(): void {
  expanded?.node.remove();
  expanded = undefined;
}

function toggle(index: number): void {
  if (expanded?.index === index) {
    collapse();
    queueRender();
    return;
  }
  post({ type: 'detail', index });
}

function showDetail(index: number, json: string): void {
  collapse();
  const node = document.createElement('div');
  node.className = 'detail';
  const pre = document.createElement('pre');
  pre.textContent = json;
  const capture = document.createElement('button');
  capture.textContent = 'Capture This Value…';
  capture.addEventListener('click', () => {
    post({ type: 'capture', index });
  });
  node.append(pre, capture);
  list.append(node);
  expanded = { index, node, height: 0 };
  expanded.height = node.offsetHeight;
  queueRender();
}

function reveal(index: number): void {
  following = false;
  const offset = top(index);
  const scrolled = virtualScrollTop();
  if (offset < scrolled) {
    setVirtualScrollTop(offset);
  } else if (offset + rowHeight > scrolled + list.clientHeight) {
    setVirtualScrollTop(offset + rowHeight - list.clientHeight);
  }
}

function selectView(view: ViewName, notify: boolean): void {
  for (const button of tabButtons) {
    const on = button.dataset.view === view;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
  }
  for (const name of views) {
    element(`panel-${name}`).classList.toggle('on', name === view);
  }
  if (notify) {
    post({ type: 'tab', view });
  }
  if (view === 'events') {
    queueRender();
  }
}

function colouredLine(text: string): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'raw-line';
  let at = 0;
  for (const match of text.matchAll(token)) {
    if (match.index > at) {
      line.append(text.slice(at, match.index));
    }
    const span = document.createElement('span');
    span.className =
      match[1] !== undefined
        ? match[2] !== undefined
          ? 'key'
          : 'string'
        : match[3] !== undefined
          ? 'number'
          : 'literal';
    span.textContent = match[0];
    line.append(span);
    at = match.index + match[0].length;
  }
  if (at < text.length) {
    line.append(text.slice(at));
  }
  return line;
}

function appendRaw(delta: TextDelta): void {
  if (delta.reset) {
    raw.replaceChildren();
    rawPending = '';
  }
  const lines = (rawPending + delta.text).split('\n');
  rawPending = lines.pop() ?? '';
  for (const line of lines) {
    raw.append(colouredLine(line));
  }
  while (raw.childElementCount > rawLineLimit) {
    raw.firstElementChild?.remove();
  }
}

function showCaptured(values: readonly Captured[]): void {
  const label = document.createElement('span');
  label.textContent = 'Captured:';
  const chips = values.map(({ name, value }) => {
    const chip = document.createElement('span');
    chip.className = value === undefined ? 'chip wait' : 'chip';
    chip.textContent = value === undefined ? `${name} · waiting` : `${name} = ${value}`;
    return chip;
  });
  captured.replaceChildren(label, ...chips);
}

function showHeaders(status: string, fields: readonly [string, string][]): void {
  statusLine.textContent = status;
  headers.replaceChildren(
    ...fields.map(([name, value]) => {
      const tableRow = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = name;
      const valueCell = document.createElement('td');
      valueCell.textContent = value;
      tableRow.append(nameCell, valueCell);
      return tableRow;
    }),
  );
}

function applyUpdate(message: UpdateMessage): void {
  if (message.reset) {
    rows.clear();
    for (const node of rowNodes.values()) {
      node.remove();
    }
    rowNodes.clear();
    lastAck = 0;
    lastWindow = '';
  }
  count = message.count;
  for (const row of message.rows) {
    rows.set(row.index, row);
  }
  pill.textContent = states[message.state];
  pill.className = `pill ${message.state}`;
  statusNode.textContent = message.status;
  stop.disabled = !message.running;
  showCaptured(message.captured);
  if (message.reply !== undefined) {
    if (message.reply.reset) {
      reply.textContent = '';
    }
    reply.append(message.reply.text);
  }
  if (message.raw !== undefined) {
    appendRaw(message.raw);
  }
  if (message.headers !== undefined) {
    showHeaders(message.headers.status, message.headers.fields);
  }
  queueRender();
}

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'update':
      applyUpdate(message);
      return;
    case 'rows':
      for (const row of message.rows) {
        rows.set(row.index, row);
      }
      queueRender();
      return;
    case 'detail':
      showDetail(message.index, message.json);
      return;
    case 'select':
      selectView(message.view, false);
      return;
    case 'expand':
      select(message.index);
      reveal(message.index);
      post({ type: 'detail', index: message.index });
      return;
    case 'focusCapture':
      expanded?.node.querySelector('button')?.focus();
      return;
  }
});

list.addEventListener('scroll', () => {
  following = list.scrollTop + list.clientHeight >= list.scrollHeight - rowHeight;
  queueRender();
});

list.addEventListener('keydown', (event) => {
  const current = selected ?? Math.min(count, indexAt(virtualScrollTop()));
  const moves: Record<string, number> = {
    ArrowDown: current + 1,
    ArrowUp: current - 1,
    Home: 1,
    End: count,
  };
  const target = moves[event.key];
  if (target !== undefined) {
    event.preventDefault();
    const index = Math.max(1, Math.min(count, target));
    select(index);
    reveal(index);
    following = event.key === 'End';
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && selected !== undefined) {
    event.preventDefault();
    toggle(selected);
  }
});

for (const button of tabButtons) {
  button.addEventListener('click', () => {
    selectView(button.dataset.view as ViewName, true);
  });
  button.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step !== 0) {
      const position = (tabButtons.indexOf(button) + step + tabButtons.length) % tabButtons.length;
      const next = tabButtons[position];
      next?.focus();
      selectView(next?.dataset.view as ViewName, true);
    }
  });
}

stop.addEventListener('click', () => {
  post({ type: 'stop' });
});

post({ type: 'ready' });
