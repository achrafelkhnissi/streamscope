import type { ParsedEvent } from '../events/model';
import type { FramedLine } from './framer';
import { parseJson } from './json';
import { previewBytes } from './limits';

const asciiDigits = /^[0-9]+$/;

function withoutDataField(preview: string): string {
  if (!preview.startsWith('data:')) {
    return preview;
  }
  const value = preview.slice('data:'.length);
  return value.startsWith(' ') ? value.slice(1) : value;
}

export class SseInterpreter {
  private start: { offset: number; line: number } | undefined;
  private blockEnd = 0;
  private data = '';
  private dataBytes = 0;
  private hasData = false;
  private eventType: string | undefined;
  private id: string | undefined;
  private retry: number | undefined;
  private oversizePreview: string | undefined;

  constructor(private readonly maxEventBytes: number) {}

  line(line: FramedLine): ParsedEvent | undefined {
    if (line.kind === 'line' && line.text === '') {
      return this.dispatch(line);
    }
    this.start ??= { offset: line.offset, line: line.number };
    this.blockEnd = line.offset + line.length;
    if (line.kind === 'oversize') {
      this.markOversize(withoutDataField(line.preview));
      return undefined;
    }
    if (line.text.startsWith(':')) {
      const comment = line.text.slice(1);
      return {
        offset: line.offset,
        length: line.length,
        line: line.number,
        kind: 'comment',
        value: comment.startsWith(' ') ? comment.slice(1) : comment,
        sse: undefined,
        marker: undefined,
        error: undefined,
        unterminated: line.terminator === '',
      };
    }
    const colon = line.text.indexOf(':');
    const field = colon === -1 ? line.text : line.text.slice(0, colon);
    const raw = colon === -1 ? '' : line.text.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    switch (field) {
      case 'data':
        this.addData(value, line.length);
        break;
      case 'event':
        this.eventType = value === '' ? undefined : value;
        break;
      case 'id':
        if (!value.includes('\0')) {
          this.id = value;
        }
        break;
      case 'retry':
        if (asciiDigits.test(value)) {
          this.retry = Number(value);
        }
        break;
    }
    return undefined;
  }

  end(): { offset: number; length: number } | undefined {
    const start = this.start;
    const pending = this.hasData || this.oversizePreview !== undefined;
    this.reset();
    if (start === undefined || !pending) {
      return undefined;
    }
    return { offset: start.offset, length: this.blockEnd - start.offset };
  }

  private addData(value: string, bytes: number): void {
    if (this.oversizePreview !== undefined) {
      return;
    }
    this.dataBytes += bytes;
    if (this.dataBytes > this.maxEventBytes) {
      this.oversizePreview = (this.data + value).slice(0, previewBytes);
      this.data = '';
      return;
    }
    this.data += `${value}\n`;
    this.hasData = true;
  }

  private markOversize(preview: string): void {
    if (this.oversizePreview !== undefined) {
      return;
    }
    this.oversizePreview = this.hasData ? this.data.slice(0, -1).slice(0, previewBytes) : preview;
    this.data = '';
  }

  private dispatch(line: FramedLine): ParsedEvent | undefined {
    const start = this.start;
    if (start === undefined) {
      return undefined;
    }
    const sse = { event: this.eventType, id: this.id, retry: this.retry };
    const position = {
      offset: start.offset,
      length: line.offset + line.length - start.offset,
      line: start.line,
      sse,
      error: undefined,
      unterminated: false,
    };
    const oversizePreview = this.oversizePreview;
    const hasData = this.hasData;
    const data = this.data.slice(0, -1);
    this.reset();
    if (oversizePreview !== undefined) {
      return { ...position, kind: 'oversize', value: oversizePreview, marker: undefined };
    }
    if (!hasData) {
      return undefined;
    }
    const marker = sse.event === 'error' ? 'error' : data === '[DONE]' ? 'done' : undefined;
    const parsed = parseJson(data);
    return parsed.ok
      ? { ...position, kind: 'json', value: parsed.value, marker }
      : { ...position, kind: 'text', value: data, marker };
  }

  private reset(): void {
    this.start = undefined;
    this.data = '';
    this.dataBytes = 0;
    this.hasData = false;
    this.eventType = undefined;
    this.id = undefined;
    this.retry = undefined;
    this.oversizePreview = undefined;
  }
}
