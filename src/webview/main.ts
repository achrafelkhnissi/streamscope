import {
  panelLimits,
  panelViews,
  type FromPanel,
  type PanelBody,
  type PanelCapture,
  type PanelCheck,
  type PanelRow,
  type PanelRunState,
  type PanelStatus,
  type PanelView,
  type TextDelta,
  type ToPanel,
} from '../response/panel-protocol';
import { followingAfterScroll, listWindow, scrollTopFor, type ListInput } from './list-window';
import {
  canOpen,
  canSave,
  effectiveView,
  setDisabledKeepingFocus,
  visibleViews,
} from './panel-state';
import {
  bodyCaptureHint,
  bodyNote,
  captureLabel,
  captureText,
  captureWhereHint,
  eventCaptureHint,
  historyNote,
  notJsonHint,
  rawNote,
  replyNote,
  stateAnnouncement,
  stateLabels,
  statusLine,
} from './panel-text';
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

interface Detail {
  index: number;
  pre: HTMLPreElement;
  hint: HTMLParagraphElement;
}

type CaptureSpot =
  { target: 'event'; index: number; offset: number } | { target: 'body'; offset: number };

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
const captureButton = element('capture', HTMLButtonElement);
const historyText = element('history-note', HTMLParagraphElement);
const captureList = element('captures', HTMLUListElement);
const stopButton = element('stop', HTMLButtonElement);
const saveButton = element('save', HTMLButtonElement);
const announcer = element('announce', HTMLDivElement);
const replyPanel = element('panel-reply', HTMLElement);
const replyText = element('reply', HTMLPreElement);
const replyCutText = element('reply-note', HTMLParagraphElement);
const rawPanel = element('panel-raw', HTMLElement);
const rawText = element('raw', HTMLPreElement);
const rawGoneText = element('raw-note', HTMLParagraphElement);
const headersText = element('headers', HTMLPreElement);
const noteText = element('body-note', HTMLParagraphElement);
const bodyText = element('body', HTMLPreElement);
const captureHint = element('capture-hint', HTMLParagraphElement);
const captureNote = element('capture-note', HTMLParagraphElement);
const checkList = element('check-list', HTMLUListElement);
const checksEmpty = element('checks', HTMLParagraphElement);
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
let latestStatus: PanelStatus | undefined;
let openTarget: 'body' | 'headers' | undefined;
let detail: Detail | undefined;
let eventSpot: CaptureSpot | undefined;
let bodySpot: CaptureSpot | undefined;
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
let announcedState: PanelRunState | undefined;
let ownScrollTop: number | undefined;
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
  captureButton.hidden = !(
    run !== undefined &&
    view === 'body' &&
    (body.kind === 'text' || body.kind === 'preview') &&
    body.language === 'json'
  );
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
  if (changed) {
    captureNote.hidden = true;
  }
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

function showTabs(): void {
  const shown = visibleViews(latestStatus);
  for (const entry of views) {
    entry.tab.hidden = !shown.includes(entry.name);
  }
  if (!shown.includes(view)) {
    showView('events', false);
  }
}

function showStatus(status: PanelStatus): void {
  latestStatus = status;
  const label = stateLabels[status.state];
  const line = statusLine(status);
  statePill.textContent = label;
  statePill.dataset.state = status.state;
  statusText.textContent = line;
  statusText.title = line;
  setDisabledKeepingFocus(stopButton, !status.running, document.activeElement === stopButton, list);
  saveButton.disabled = !canSave(status);
  openButton.disabled = !canOpen(status);
  const gone = historyNote(status);
  historyText.textContent = gone;
  historyText.hidden = gone === '';
  const cut = replyNote(status);
  replyCutText.textContent = cut;
  replyCutText.hidden = cut === '';
  const rawGone = rawNote(status);
  rawGoneText.textContent = rawGone;
  rawGoneText.hidden = rawGone === '';
  showTabs();
  const text = stateAnnouncement(announcedState, status);
  announcedState = status.state;
  if (text !== undefined) {
    announce(text);
  }
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
  bodySpot = undefined;
  captureHint.hidden = true;
  updateOpenButton();
}

function captureItem(capture: PanelCapture): HTMLLIElement {
  const item = document.createElement('li');
  item.dataset.state = capture.state;
  item.textContent = captureText(capture);
  item.setAttribute('aria-label', captureLabel(capture));
  return item;
}

const checkMarks: Record<PanelCheck['state'], string> = {
  passed: '✓',
  failed: '✗',
  pending: '…',
};

function checkItem(check: PanelCheck): HTMLLIElement {
  const item = document.createElement('li');
  item.dataset.state = check.state;
  item.setAttribute(
    'aria-label',
    `${check.state}: ${check.text}${check.detail === '' ? '' : `, ${check.detail}`}`,
  );
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = `${checkMarks[check.state]} `;
  const text = document.createElement('span');
  text.textContent = check.text;
  item.append(mark, text);
  if (check.detail !== '') {
    const detail = document.createElement('span');
    detail.className = 'detail-text';
    detail.textContent = ` ${check.detail}`;
    item.append(detail);
  }
  return item;
}

function showChecks(checks: readonly PanelCheck[]): void {
  checkList.replaceChildren(...checks.map(checkItem));
  checkList.hidden = checks.length === 0;
  checksEmpty.hidden = checks.length > 0;
}

function showCaptures(captures: readonly PanelCapture[]): void {
  captureList.replaceChildren(...captures.map(captureItem));
  captureList.hidden = captures.length === 0;
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
    ownScrollTop = Math.max(0, area.spacerHeight - base.clientHeight);
  } else if (revealing) {
    list.scrollTop = scrollTop;
    ownScrollTop = list.scrollTop;
    area = listWindow({ ...base, scrollTop: ownScrollTop });
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
  detail = undefined;
  eventSpot = undefined;
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

function showDetail(message: Extract<ToPanel, { type: 'detail' }>): void {
  const { run: forRun, index, text, note: marked, truncated } = message;
  closeDetail();
  const node = document.createElement('div');
  node.className = 'detail';
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', `Event ${String(index)}`);
  if (marked !== undefined) {
    const why = document.createElement('p');
    why.textContent = marked;
    node.append(why);
  }
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
  const capture = document.createElement('button');
  capture.type = 'button';
  capture.textContent = 'Capture This Value…';
  capture.addEventListener('click', captureEvent);
  const hint = document.createElement('p');
  hint.hidden = true;
  node.append(open, capture, hint);
  detail = { index, pre, hint };
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
  captureNote.hidden = true;
  announcedState = undefined;
  ownScrollTop = undefined;
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
  showCaptures(message.captures);
  showChecks(message.checks);
  stopButton.hidden = message.readOnly;
  showStatus(message.status);
  showView(effectiveView(message.view, message.status), false);
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
  if (message.captures !== undefined) {
    showCaptures(message.captures);
  }
  if (message.checks !== undefined) {
    showChecks(message.checks);
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
        showDetail(message);
      }
      return;
    case 'select':
      showView(effectiveView(message.view, latestStatus), false);
      return;
    case 'expand':
      expand(message.index);
      return;
    case 'captureSelection':
      captureSelected();
      return;
  }
}

function textOffset(pre: HTMLPreElement, node: Node, offset: number): number | undefined {
  if (node === pre.firstChild && node.nodeType === Node.TEXT_NODE) {
    return offset;
  }
  if (node === pre) {
    return offset === 0 ? 0 : pre.textContent.length;
  }
  return undefined;
}

function recordSelection(): void {
  const current = document.getSelection();
  if (current === null || current.rangeCount === 0) {
    return;
  }
  const range = current.getRangeAt(0);
  const { startContainer, startOffset } = range;
  if (detail !== undefined && detail.pre.contains(startContainer)) {
    const offset = textOffset(detail.pre, startContainer, startOffset);
    if (offset !== undefined) {
      eventSpot = { target: 'event', index: detail.index, offset };
    }
  } else if (bodyText.contains(startContainer)) {
    const offset = textOffset(bodyText, startContainer, startOffset);
    if (offset !== undefined) {
      bodySpot = { target: 'body', offset };
    }
  }
}

function showHint(node: HTMLParagraphElement | undefined, text: string): void {
  if (node !== undefined) {
    node.textContent = text;
    node.hidden = false;
  }
  announce(text);
}

function captureSelected(): void {
  captureNote.hidden = true;
  if (view === 'events' && detail !== undefined) {
    captureEvent();
  } else if (view === 'body' && !captureButton.hidden) {
    captureBody();
  } else if (view === 'events') {
    showHint(captureNote, eventCaptureHint);
  } else if (view === 'body' && (body.kind === 'text' || body.kind === 'preview')) {
    showHint(captureNote, notJsonHint);
  } else {
    showHint(captureNote, captureWhereHint);
  }
}

function captureEvent(): void {
  if (run === undefined) {
    return;
  }
  if (eventSpot?.target === 'event' && eventSpot.index === detail?.index) {
    detail.hint.hidden = true;
    post({
      type: 'capture',
      run,
      target: 'event',
      index: eventSpot.index,
      offset: eventSpot.offset,
    });
    return;
  }
  showHint(detail?.hint, eventCaptureHint);
}

function captureBody(): void {
  if (run === undefined) {
    return;
  }
  if (bodySpot?.target === 'body' && !captureButton.hidden) {
    captureHint.hidden = true;
    post({ type: 'capture', run, target: 'body', offset: bodySpot.offset });
    return;
  }
  showHint(captureHint, bodyCaptureHint);
}

list.addEventListener('scroll', () => {
  following = followingAfterScroll({
    following,
    revealPending: reveal !== undefined,
    ownScrollTop,
    scrollTop: list.scrollTop,
    atBottom: atBottom(list),
  });
  ownScrollTop = undefined;
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

for (const entry of views) {
  entry.tab.addEventListener('click', () => {
    showView(entry.name, true);
  });
  entry.tab.addEventListener('keydown', (event) => {
    const names = visibleViews(latestStatus);
    const shown = views.filter((candidate) => names.includes(candidate.name));
    const position = shown.indexOf(entry);
    const targets: Partial<Record<string, number>> = {
      ArrowRight: position + 1,
      ArrowLeft: position - 1,
      Home: 0,
      End: shown.length - 1,
    };
    const target = targets[event.key];
    const next = target === undefined ? undefined : shown[(target + shown.length) % shown.length];
    if (next !== undefined) {
      event.preventDefault();
      next.tab.focus();
      showView(next.name, true);
    }
  });
}

stopButton.addEventListener('click', () => {
  if (run !== undefined) {
    post({ type: 'stop', run });
  }
});

saveButton.addEventListener('click', () => {
  if (run !== undefined) {
    post({ type: 'save', run });
  }
});

openButton.addEventListener('click', () => {
  if (run !== undefined && openTarget !== undefined) {
    post({ type: 'open', run, target: openTarget });
  }
});

captureButton.addEventListener('click', captureBody);

document.addEventListener('selectionchange', recordSelection);

window.addEventListener('message', (event: MessageEvent<ToPanel>) => {
  receive(event.data);
});

replyText.append(replyNode);
sizes.observe(list);
const initial = readState(api.getState());
pendingScroll = initial.scroll ?? undefined;
savedScroll = initial.scroll;
showTabs();
showView(effectiveView(initial.view, latestStatus), false);
post({ type: 'ready' });
