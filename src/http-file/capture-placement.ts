import type { HttpRequest } from './model';

export type PlacementResult =
  { ok: true; line: number; text: string } | { ok: false; message: string };

const maxCaptures = 64;

function markerOf(lines: readonly string[], line: number | undefined): '#' | '//' {
  if (line === undefined) {
    return '#';
  }
  return (lines[line] ?? '').trimStart().startsWith('//') ? '//' : '#';
}

export function captureLine(
  marker: '#' | '//',
  name: string,
  secret: boolean,
  expression: string,
): string {
  return `${marker} @capture ${secret ? 'secret ' : ''}${name} = ${expression}`;
}

export function capturedNames(request: HttpRequest): ReadonlySet<string> {
  return new Set(request.captures.map(({ name }) => name));
}

export function placeCapture(input: {
  request: HttpRequest;
  lines: readonly string[];
  name: string;
  secret: boolean;
  expression: string;
}): PlacementResult {
  const { request, lines, name, secret, expression } = input;
  const captureLines = request.directives.filter(({ kind }) => kind === 'capture');
  if (captureLines.length >= maxCaptures) {
    return {
      ok: false,
      message: `This request already has ${String(maxCaptures)} captures, the most a request can have.`,
    };
  }
  if (capturedNames(request).has(name)) {
    return { ok: false, message: `This request already captures ${name}.` };
  }
  const lastCapture = captureLines.at(-1);
  const nameLine = request.directives.find(({ kind }) => kind === 'name')?.range.start.line;
  const marker = markerOf(lines, lastCapture?.range.start.line ?? nameLine);
  const line =
    lastCapture === undefined
      ? request.requestLine.range.start.line
      : lastCapture.range.end.line + 1;
  return {
    ok: true,
    line,
    text: captureLine(marker, name, secret, expression),
  };
}
