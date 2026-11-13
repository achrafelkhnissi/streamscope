export interface ListInput {
  scrollTop: number;
  clientHeight: number;
  count: number;
  rowHeight: number;
  expanded: { index: number; height: number } | undefined;
  maxScrollPixels: number;
}

export interface ListWindow {
  first: number;
  last: number;
  spacerHeight: number;
  top(index: number): number;
}

interface Geometry {
  virtualHeight: number;
  spacerHeight: number;
  maxScroll: number;
  ratio: number;
}

function geometry(input: ListInput): Geometry {
  const virtualHeight = input.count * input.rowHeight + (input.expanded?.height ?? 0);
  const spacerHeight = Math.min(virtualHeight, input.maxScrollPixels);
  const maxScroll = Math.max(0, spacerHeight - input.clientHeight);
  const virtualRange = Math.max(0, virtualHeight - input.clientHeight);
  const ratio = maxScroll > 0 && virtualRange > maxScroll ? virtualRange / maxScroll : 1;
  return { virtualHeight, spacerHeight, maxScroll, ratio };
}

function offsetOf(input: ListInput, index: number): number {
  const base = (index - 1) * input.rowHeight;
  const { expanded } = input;
  return expanded !== undefined && index > expanded.index ? base + expanded.height : base;
}

function clampedScroll(input: ListInput, shape: Geometry): number {
  return Math.min(Math.max(0, input.scrollTop), shape.maxScroll);
}

function virtualTop(input: ListInput, shape: Geometry, scrollTop: number): number {
  return scrollTop >= shape.maxScroll
    ? Math.max(0, shape.virtualHeight - input.clientHeight)
    : scrollTop * shape.ratio;
}

function firstAt(input: ListInput, offset: number): number {
  const { expanded, rowHeight } = input;
  if (expanded !== undefined && offset >= expanded.index * rowHeight) {
    return offset < expanded.index * rowHeight + expanded.height
      ? expanded.index
      : Math.floor((offset - expanded.height) / rowHeight) + 1;
  }
  return Math.floor(offset / rowHeight) + 1;
}

function lastBefore(input: ListInput, offset: number): number {
  const { expanded, rowHeight } = input;
  if (expanded !== undefined && offset > expanded.index * rowHeight) {
    return offset <= expanded.index * rowHeight + expanded.height
      ? expanded.index
      : Math.ceil((offset - expanded.height) / rowHeight);
  }
  return Math.ceil(offset / rowHeight);
}

export function listWindow(input: ListInput): ListWindow {
  const shape = geometry(input);
  const scrollTop = clampedScroll(input, shape);
  const offset = virtualTop(input, shape, scrollTop);
  return {
    first: Math.max(1, Math.min(input.count, firstAt(input, offset))),
    last: Math.min(input.count, lastBefore(input, offset + input.clientHeight)),
    spacerHeight: shape.spacerHeight,
    top: (index) => scrollTop + offsetOf(input, index) - offset,
  };
}

export function scrollTopFor(input: ListInput, index: number, align: 'start' | 'nearest'): number {
  const shape = geometry(input);
  const scrollTop = clampedScroll(input, shape);
  const current = virtualTop(input, shape, scrollTop);
  const rowTop = offsetOf(input, index);
  const rowBottom = rowTop + input.rowHeight;
  let target: number;
  let round: (value: number) => number;
  if (align === 'start') {
    target = rowTop;
    round = Math.ceil;
  } else if (rowTop < current) {
    target = rowTop;
    round = Math.floor;
  } else if (rowBottom > current + input.clientHeight) {
    target = rowBottom - input.clientHeight;
    round = Math.ceil;
  } else {
    return scrollTop;
  }
  if (target >= shape.virtualHeight - input.clientHeight) {
    return shape.maxScroll;
  }
  return Math.max(0, round(target / shape.ratio));
}

export interface ListScroll {
  following: boolean;
  revealPending: boolean;
  ownScrollTop: number | undefined;
  scrollTop: number;
  atBottom: boolean;
}

export function followingAfterScroll(scroll: ListScroll): boolean {
  if (scroll.revealPending) {
    return scroll.following;
  }
  if (scroll.ownScrollTop !== undefined && Math.abs(scroll.scrollTop - scroll.ownScrollTop) < 1) {
    return scroll.following;
  }
  return scroll.atBottom;
}
