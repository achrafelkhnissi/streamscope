import {
  panelLimits,
  panelViews,
  type FromPanel,
  type PanelBody,
  type PanelRow,
  type PanelStatus,
  type PanelView,
  type TextDelta,
  type ToPanel,
} from '../response/panel-protocol';
import { listWindow, scrollTopFor, type ListInput } from './list-window';
import { bodyNote, stateLabels, statusLine } from './panel-text';
import { rawTail, rawTokens, splitLines } from './raw-colour';

interface PanelState {
  view: PanelView;
  scroll: number | null;
}

interface WebviewApi {
  postMessage(message: FromPanel): void;
  getState(): unknown;
  setState(state: PanelState): void;
}

declare function acquireVsCodeApi(): WebviewApi;

interface RowEntry {
  node: HTMLDivElement;
  time: HTMLSpanElement;
  label: HTMLSpanElement;
  preview: HTMLSpanElement;
  row: PanelRow | undefined;
  top: number;
  selected: boolean;
  size: number;
}

interface Expanded {
  index: number;
  node: HTMLDivElement;
  height: number;
}

interface Reveal {
  index: number;
  align: 'start' | 'nearest';
}

const rowHeight = 22;
const margin = 40;
const maxScrollPixels = 8_000_000;
const announceInterval = 2000;
const maxRawLines = 50_000;
const colourLimit = 10_000;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`The response page has no #${id}.`);
  }
  return found;
}

const api = acquireVsCodeApi();
const list = element('list', HTMLDivElement);
const spacer = element('spacer', HTMLDivElement);
const statePill = element('state', HTMLSpanElement);
const statusText = element('status', HTMLSpanElement);
const openButton = element('open', HTMLButtonElement);
const stopButton = element('stop', HTMLButtonElement);
const announcer = element('announce', HTMLDivElement);
const replyPanel = element('panel-reply', HTMLElement);
const replyText = element('reply', HTMLPreElement);
const rawPanel = element('panel-raw', HTMLElement);
const rawText = element('raw', HTMLPreElement);
const headersText = element('headers', HTMLPreElement);
const noteText = element('body-note', HTMLParagraphElement);
const bodyText = element('body', HTMLPreElement);
const views = panelViews.map((name) => ({
  name,
  tab: element(`tab-${name}`, HTMLButtonElement),
  panel: element(`panel-${name}`, HTMLElement),
}));

let run: number | undefined;
let view: PanelView = 'events';
let count = 0;
let following = true;
let selected: number | undefined;
let reveal: Reveal | undefined;
let expanded: Expanded | undefined;
let detailWanted: number | undefined;
let body: PanelBody = { kind: 'none' };
let headers = '';
let openTarget: 'body' | 'headers' | undefined;
const rows = new Map<number, PanelRow>();
const entries = new Map<number, RowEntry>();
let shown = { first: 1, from: 1, to: 0 };
let windowKey = '';
let acknowledged = 0;
let renderQueued = false;
let pendingScroll: number | undefined;
let savedScroll: number | null = null;
let rawOpen = '';
let rawOpenNode: HTMLDivElement | undefined;
let rawChars = 0;
let rawLines = 0;
const replyNode = document.createTextNode('');
let announcement = '';
let announcedAt = Number.NEGATIVE_INFINITY;
let announceTimer: number | undefined;

const sizes = new ResizeObserver(() => {
  if (expanded !== undefined) {
    const height = expanded.node.offsetHeight;
    if (height > 0) {
      expanded.height = height;
    }
  }
  queueRender();
});

function post(message: FromPanel): void {
  api.postMessage(message);
}

function saveState(): void {
  api.setState({ view, scroll: savedScroll });
}

function readState(value: unknown): PanelState {
  if (typeof value !== 'object' || value === null || !('view' in value) || !('scroll' in value)) {
    return { view: 'events', scroll: null };
  }
  const { view: savedView, scroll } = value;
  return {
    view: panelViews.find((name) => name === savedView) ?? 'events',
    scroll:
      typeof scroll === 'number' && Number.isSafeInteger(scroll) && scroll >= 1 ? scroll : null,
  };
}

function atBottom(panel: HTMLElement): boolean {
  return panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
}

function flushAnnouncement(): void {
  announceTimer = undefined;
  if (announcer.textContent !== announcement) {
    announcer.textContent = announcement;
    announcedAt = performance.now();
  }
}

function announce(text: string): void {
  announcement = text;
  if (announceTimer !== undefined) {
    return;
  }
  const wait = announcedAt + announceInterval - performance.now();
  if (wait > 0) {
    announceTimer = window.setTimeout(flushAnnouncement, wait);
  } else {
    flushAnnouncement();
  }
}

function updateOpenButton(): void {
  if (view === 'body' && (body.kind === 'text' || body.kind === 'preview')) {
    openTarget = 'body';
  } else if (view === 'headers' && headers !== '') {
    openTarget = 'headers';
  } else {
    openTarget = undefined;
  }
  openButton.hidden = run === undefined || openTarget === undefined;
}

function queueRender(): void {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(render);
  }
}

function showView(next: PanelView, picked: boolean): void {
  const changed = next !== view;
  view = next;
  for (const entry of views) {
    const on = entry.name === next;
    entry.tab.setAttribute('aria-selected', String(on));
    entry.tab.tabIndex = on ? 0 : -1;
    entry.panel.classList.toggle('on', on);
  }
  updateOpenButton();
  saveState();
  if (picked && changed) {
    post({ type: 'tab', view: next });
  }
  if (next === 'events') {
    queueRender();
  }
}

function showStatus(status: PanelStatus): void {
  const label = stateLabels[status.state];
  const line = statusLine(status);
  statePill.textContent = label;
  statePill.dataset.state = status.state;
  statusText.textContent = line;
  statusText.title = line;
  stopButton.disabled = !status.running;
  announce(`${label}. ${line}`);
}

function showHeaders(text: string): void {
  headers = text;
  headersText.textContent = text;
  updateOpenButton();
}

function showBody(next: PanelBody): void {
  body = next;
  const note = bodyNote(next);
  noteText.textContent = note;
  noteText.hidden = note === '';
  bodyText.textContent = next.kind === 'text' || next.kind === 'preview' ? next.text : '';
  updateOpenButton();
}

function appendReply(delta: TextDelta): void {
  const stick = atBottom(replyPanel);
  if (delta.reset) {
    replyNode.data = delta.text;
  } else {
    replyNode.appendData(delta.text);
  }
  if (stick) {
    replyPanel.scrollTop = replyPanel.scrollHeight;
  }
}

function rawLine(text: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'line';
  if (text.length > colourLimit) {
    node.textContent = text;
    return node;
  }
  for (const token of rawTokens(text)) {
    if (token.kind === 'plain') {
      node.append(token.text);
    } else {
      const span = document.createElement('span');
      span.className = token.kind;
      span.textContent = token.text;
      node.append(span);
    }
  }
  return node;
}

function clearRawLines(): void {
  rawText.replaceChildren();
  rawChars = 0;
  rawLines = 0;
}

function clearRaw(): void {
  clearRawLines();
  rawOpen = '';
  rawOpenNode = undefined;
}

function dropFirstRawLine(): void {
  const first = rawText.firstElementChild;
  if (first !== null) {
    rawChars -= first.textContent.length + 1;
    rawLines -= 1;
    first.remove();
  }
}

function appendRaw(delta: TextDelta): void {
  const stick = atBottom(rawPanel);
  if (delta.reset) {
    clearRaw();
  }
  rawOpenNode?.remove();
  rawOpenNode = undefined;
  const tail = rawTail(splitLines(rawOpen, delta.text), panelLimits.rawTailChars, maxRawLines);
  if (tail.cut) {
    clearRawLines();
  }
  const lineChars = tail.lines.reduce((sum, line) => sum + line.length + 1, 0);
  const added = lineChars + tail.open.length;
  const addedLines = tail.lines.length + (tail.open === '' ? 0 : 1);
  while (
    rawLines > 0 &&
    (rawChars + added > panelLimits.rawTailChars || rawLines + addedLines > maxRawLines)
  ) {
    dropFirstRawLine();
  }
  const fragment = document.createDocumentFragment();
  for (const line of tail.lines) {
    fragment.append(rawLine(line));
  }
  rawChars += lineChars;
  rawLines += tail.lines.length;
  rawOpen = tail.open;
  if (tail.open !== '') {
    rawOpenNode = rawLine(tail.open.endsWith('\r') ? tail.open.slice(0, -1) : tail.open);
    fragment.append(rawOpenNode);
  }
  rawText.append(fragment);
  if (stick) {
    rawPanel.scrollTop = rawPanel.scrollHeight;
  }
}

function keptRange(): { low: number; high: number } {
  return following
    ? { low: count - panelLimits.windowRows + 1, high: count }
    : { low: shown.from - margin, high: shown.to + margin };
}

function storeRows(incoming: readonly PanelRow[]): void {
  const { low, high } = keptRange();
  for (const row of incoming) {
    if (row.index >= low && row.index <= high) {
      rows.set(row.index, row);
    }
  }
  for (const index of rows.keys()) {
    if (index < low || index > high) {
      rows.delete(index);
    }
  }
  queueRender();
}

function cell(node: HTMLDivElement, name: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = name;
  node.append(span);
  return span;
}

function addEntry(index: number): RowEntry {
  const node = document.createElement('div');
  node.className = 'row';
  node.id = `row-${String(index)}`;
  node.dataset.index = String(index);
  node.setAttribute('role', 'option');
  node.setAttribute('aria-posinset', String(index));
  node.setAttribute('aria-selected', 'false');
  cell(node, 'index').textContent = String(index);
  const entry: RowEntry = {
    node,
    time: cell(node, 'time'),
    label: cell(node, 'label'),
    preview: cell(node, 'preview'),
    row: undefined,
    top: Number.NaN,
    selected: false,
    size: 0,
  };
  spacer.append(node);
  entries.set(index, entry);
  return entry;
}

function fill(entry: RowEntry, row: PanelRow | undefined): void {
  entry.row = row;
  entry.time.textContent = row?.time ?? '';
  entry.label.textContent = row?.label ?? '';
  entry.preview.textContent = row?.preview ?? '';
  if (row === undefined) {
    entry.node.removeAttribute('data-kind');
  } else {
    entry.node.dataset.kind = row.kind;
  }
}

function listInput(scrollTop: number): ListInput {
  return {
    scrollTop,
    clientHeight: list.clientHeight,
    count,
    rowHeight,
    expanded:
      expanded === undefined ? undefined : { index: expanded.index, height: expanded.height },
    maxScrollPixels,
  };
}

function acknowledge(forRun: number, newest: number): void {
  if (forRun === run && newest > acknowledged) {
    acknowledged = newest;
    post({ type: 'rendered', run: forRun, newest });
  }
}

function render(): void {
  renderQueued = false;
  if (run === undefined || view !== 'events') {
    return;
  }
  const currentRun = run;
  const base = listInput(following ? Number.MAX_SAFE_INTEGER : list.scrollTop);
  const scrollTop =
    reveal === undefined ? base.scrollTop : scrollTopFor(base, reveal.index, reveal.align);
  const revealing = reveal !== undefined;
  reveal = undefined;
  let area = listWindow({ ...base, scrollTop });
  spacer.style.height = `${String(area.spacerHeight)}px`;
  if (following) {
    list.scrollTop = area.spacerHeight;
  } else if (revealing) {
    list.scrollTop = scrollTop;
    area = listWindow({ ...base, scrollTop: list.scrollTop });
  }
  const visible = Math.max(0, area.last - area.first + 1);
  const extra = Math.max(0, Math.min(margin, Math.floor((panelLimits.windowRows - visible) / 2)));
  const from = Math.max(1, area.first - extra);
  const to = Math.min(count, area.last + extra, from + panelLimits.windowRows - 1);
  shown = { first: area.first, from, to };
  for (const [index, entry] of entries) {
    if (index < from || index > to) {
      entry.node.remove();
      entries.delete(index);
    }
  }
  let newest = 0;
  for (let index = from; index <= to; index += 1) {
    const entry = entries.get(index) ?? addEntry(index);
    const row = rows.get(index);
    if (entry.row !== row) {
      fill(entry, row);
    }
    const top = area.top(index);
    if (entry.top !== top) {
      entry.top = top;
      entry.node.style.top = `${String(top)}px`;
    }
    const isSelected = index === selected;
    if (entry.selected !== isSelected) {
      entry.selected = isSelected;
      entry.node.setAttribute('aria-selected', String(isSelected));
    }
    if (entry.size !== count) {
      entry.size = count;
      entry.node.setAttribute('aria-setsize', String(count));
    }
    if (row !== undefined) {
      newest = index;
    }
  }
  if (expanded !== undefined) {
    expanded.node.style.top = `${String(area.top(expanded.index) + rowHeight)}px`;
  }
  if (selected !== undefined && entries.has(selected)) {
    list.setAttribute('aria-activedescendant', `row-${String(selected)}`);
  } else {
    list.removeAttribute('aria-activedescendant');
  }
  const key = following ? `tail:${String(to - from)}` : `${String(from)}:${String(to)}`;
  if (to >= from && key !== windowKey) {
    windowKey = key;
    post({ type: 'window', run: currentRun, start: from, end: to, following });
  }
  const scroll = following ? null : area.first;
  if (scroll !== savedScroll) {
    savedScroll = scroll;
    saveState();
  }
  if (newest > acknowledged) {
    requestAnimationFrame(() => {
      acknowledge(currentRun, newest);
    });
  }
}

function select(index: number, tail: boolean): void {
  selected = index;
  following = tail;
  reveal = tail ? undefined : { index, align: 'nearest' };
  queueRender();
}

function closeDetail(): void {
  detailWanted = undefined;
  if (expanded !== undefined) {
    sizes.unobserve(expanded.node);
    expanded.node.remove();
    expanded = undefined;
    queueRender();
  }
}

function requestDetail(index: number): void {
  if (run !== undefined) {
    detailWanted = index;
    post({ type: 'detail', run, index });
  }
}

function toggle(index: number): void {
  if (expanded?.index === index) {
    closeDetail();
  } else {
    requestDetail(index);
  }
}

function showDetail(forRun: number, index: number, text: string, truncated: boolean): void {
  closeDetail();
  const node = document.createElement('div');
  node.className = 'detail';
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', `Event ${String(index)}`);
  const pre = document.createElement('pre');
  pre.tabIndex = 0;
  pre.textContent = text;
  node.append(pre);
  if (truncated) {
    const note = document.createElement('p');
    note.textContent =
      'This event is too large to show here in full. Open it in the editor to see all of it.';
    node.append(note);
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Open Event in Editor';
  open.addEventListener('click', () => {
    post({ type: 'openEvent', run: forRun, index });
  });
  node.append(open);
  spacer.append(node);
  expanded = { index, node, height: node.offsetHeight };
  sizes.observe(node);
  queueRender();
}

function expand(index: number): void {
  if (run !== undefined) {
    showView('events', false);
    select(index, false);
    requestDetail(index);
  }
}

function reset(message: Extract<ToPanel, { type: 'reset' }>): void {
  if (run !== undefined) {
    pendingScroll = undefined;
  }
  run = message.run;
  count = 0;
  following = true;
  selected = undefined;
  reveal = undefined;
  closeDetail();
  rows.clear();
  for (const entry of entries.values()) {
    entry.node.remove();
  }
  entries.clear();
  shown = { first: 1, from: 1, to: 0 };
  windowKey = '';
  acknowledged = 0;
  savedScroll = pendingScroll ?? null;
  list.removeAttribute('aria-activedescendant');
  spacer.style.height = '0px';
  clearRaw();
  replyNode.data = '';
  showHeaders(message.headers);
  showBody(message.body);
  stopButton.hidden = message.readOnly;
  showStatus(message.status);
  showView(message.view, false);
  queueRender();
}

function update(message: Extract<ToPanel, { type: 'update' }>): void {
  count = message.count;
  if (pendingScroll !== undefined) {
    if (count >= pendingScroll) {
      following = false;
      reveal = { index: pendingScroll, align: 'start' };
    }
    pendingScroll = undefined;
  }
  showStatus(message.status);
  storeRows(message.rows);
  if (message.reply !== undefined) {
    appendReply(message.reply);
  }
  if (message.raw !== undefined) {
    appendRaw(message.raw);
  }
  if (message.headers !== undefined) {
    showHeaders(message.headers);
  }
  if (message.body !== undefined) {
    showBody(message.body);
  }
}

function receive(message: ToPanel): void {
  switch (message.type) {
    case 'reset':
      reset(message);
      return;
    case 'update':
      if (message.run === run) {
        update(message);
      }
      return;
    case 'rows':
      if (message.run === run) {
        storeRows(message.rows);
      }
      return;
    case 'detail':
      if (message.run === run && message.index === detailWanted) {
        showDetail(message.run, message.index, message.text, message.truncated);
      }
      return;
    case 'select':
      showView(message.view, false);
      return;
    case 'expand':
      expand(message.index);
      return;
  }
}

list.addEventListener('scroll', () => {
  following = atBottom(list);
  queueRender();
});

list.addEventListener('click', (event) => {
  const target = event.target;
  const node = target instanceof Element ? target.closest('.row') : null;
  if (node instanceof HTMLElement) {
    const index = Number(node.dataset.index);
    list.focus({ preventScroll: true });
    select(index, false);
    toggle(index);
  }
});

list.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (expanded !== undefined || detailWanted !== undefined) {
      event.preventDefault();
      closeDetail();
      list.focus({ preventScroll: true });
    }
    return;
  }
  if (event.target !== list || count === 0) {
    return;
  }
  const current = selected ?? shown.first;
  const step = selected === undefined ? 0 : 1;
  const moves: Partial<Record<string, number>> = {
    ArrowDown: current + step,
    ArrowUp: current - step,
    Home: 1,
    End: count,
  };
  const target = moves[event.key];
  if (target !== undefined) {
    event.preventDefault();
    select(Math.max(1, Math.min(count, target)), event.key === 'End');
  } else if (event.key === 'Enter' && selected !== undefined) {
    event.preventDefault();
    toggle(selected);
  }
});

views.forEach((entry, position) => {
  entry.tab.addEventListener('click', () => {
    showView(entry.name, true);
  });
  entry.tab.addEventListener('keydown', (event) => {
    const targets: Partial<Record<string, number>> = {
      ArrowRight: position + 1,
      ArrowLeft: position - 1,
      Home: 0,
      End: views.length - 1,
    };
    const target = targets[event.key];
    const next = target === undefined ? undefined : views[(target + views.length) % views.length];
    if (next !== undefined) {
      event.preventDefault();
      next.tab.focus();
      showView(next.name, true);
    }
  });
});

stopButton.addEventListener('click', () => {
  post({ type: 'stop' });
});

openButton.addEventListener('click', () => {
  if (run !== undefined && openTarget !== undefined) {
    post({ type: 'open', run, target: openTarget });
  }
});

window.addEventListener('message', (event: MessageEvent<ToPanel>) => {
  receive(event.data);
});

replyText.append(replyNode);
sizes.observe(list);
const initial = readState(api.getState());
pendingScroll = initial.scroll ?? undefined;
savedScroll = initial.scroll;
showView(initial.view, false);
post({ type: 'ready' });
