import type { ParsedEvent } from '../events/model';
import type { FramedLine } from './framer';
import { parseJson } from './json';

export function ndjsonEvent(line: FramedLine): ParsedEvent | undefined {
  const position = {
    offset: line.offset,
    length: line.length,
    line: line.number,
    sse: undefined,
    marker: undefined,
    unterminated: line.terminator === '',
  };
  if (line.kind === 'oversize') {
    return { ...position, kind: 'oversize', value: line.preview, error: undefined };
  }
  if (line.text.trim() === '') {
    return undefined;
  }
  const parsed = parseJson(line.text);
  if (!parsed.ok) {
    return { ...position, kind: 'malformed', value: line.text, error: parsed.message };
  }
  return { ...position, kind: 'json', value: parsed.value, error: undefined };
}
