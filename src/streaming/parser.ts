import { eventLabel } from '../events/label';
import type { ParsedEvent, StreamEvent } from '../events/model';
import {
  classifyContentType,
  mediaType,
  type FormatDecision,
  type StreamDirective,
  type StreamFormat,
} from './detect';
import { byteOrderMark, isMarkPrefix, LineFramer, type FramedLine } from './framer';
import { parseJson } from './json';
import { sniffBytes } from './limits';
import { ndjsonEvent } from './ndjson';
import { SseInterpreter } from './sse';

export type StreamWarning =
  | { kind: 'invalid-utf8'; offset: number }
  | { kind: 'discarded-event'; offset: number; length: number };

export interface StreamSink {
  format(decision: FormatDecision): void;
  event(event: StreamEvent): void;
  text(text: string): void;
  warning(warning: StreamWarning): void;
}

export interface StreamParserOptions {
  contentType: string | undefined;
  directive: StreamDirective | undefined;
  maxEventSize: number;
  typeFields: readonly string[];
  now: () => number;
}

type Mode =
  | { kind: 'sniff'; kept: FramedLine[]; keptBytes: number }
  | { kind: 'held'; line: FramedLine }
  | { kind: 'ndjson' }
  | { kind: 'sse'; interpreter: SseInterpreter }
  | {
      kind: 'text';
      decoder: InstanceType<typeof TextDecoder>;
      head: Uint8Array | undefined;
      offset: number;
    }
  | { kind: 'done' };

const ssePrefixes = ['data:', 'event:', 'id:', 'retry:', ':'];

function isMeaningful(line: FramedLine): boolean {
  return line.kind === 'oversize' || line.text.trim() !== '';
}

function sniffText(text: string): 'sse' | 'json' | 'text' {
  if (ssePrefixes.some((prefix) => text.startsWith(prefix))) {
    return 'sse';
  }
  const start = text.trimStart();
  return start.startsWith('{') || start.startsWith('[') ? 'json' : 'text';
}

function heldBeforeTerminator(line: FramedLine): number {
  const terminatorBytes = line.terminator.length;
  return line.length - terminatorBytes + (line.terminator.startsWith('\r') ? 1 : 0);
}

function lineText(line: FramedLine): string {
  return (line.kind === 'line' ? line.text : line.preview) + line.terminator;
}

function textDecoder(): InstanceType<typeof TextDecoder> {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

export class StreamParser {
  private mode: Mode;
  private readonly framer: LineFramer;
  private readonly contentType: string | undefined;
  private initial: FormatDecision | undefined;
  private index = 0;
  private warnedUtf8 = false;

  constructor(
    private readonly options: StreamParserOptions,
    private readonly sink: StreamSink,
  ) {
    this.framer = new LineFramer(options.maxEventSize);
    this.contentType = mediaType(options.contentType);
    const directive = options.directive === 'auto' ? undefined : options.directive;
    const known = classifyContentType(options.contentType);
    if (directive !== undefined) {
      this.initial = { format: directive, reason: 'directive', contentType: this.contentType };
    } else if (known !== 'sniff') {
      this.initial = { format: known, reason: 'content-type', contentType: this.contentType };
    }
    this.mode =
      this.initial === undefined
        ? { kind: 'sniff', kept: [], keptBytes: 0 }
        : this.modeFor(this.initial.format, new Uint8Array(0));
  }

  get pendingBytes(): number {
    return this.mode.kind === 'text' || this.mode.kind === 'done' ? 0 : this.framer.pendingBytes;
  }

  push(chunk: Uint8Array): void {
    if (this.mode.kind === 'done') {
      return;
    }
    this.announce();
    if (this.mode.kind === 'text') {
      this.decodeText(this.mode, chunk, false);
      return;
    }
    this.framer.push(chunk);
    this.drain();
    if (
      this.mode.kind === 'sniff' &&
      this.framer.pendingBytes + this.mode.keptBytes >= sniffBytes
    ) {
      this.decideOnPrefix();
    }
  }

  end(): void {
    if (this.mode.kind === 'done') {
      return;
    }
    this.announce();
    if (this.mode.kind !== 'text') {
      this.drain();
      const last = this.framer.end();
      if (last !== undefined) {
        this.handle(last);
      }
    }
    const mode = this.mode;
    if (mode.kind === 'sniff') {
      this.decide({ format: 'text', reason: 'detected', contentType: this.contentType });
      this.switchToText(mode.kept);
    }
    const final = this.mode;
    if (final.kind === 'text') {
      this.decodeText(final, new Uint8Array(0), true);
    }
    if (final.kind === 'sse') {
      const discarded = final.interpreter.end();
      if (discarded !== undefined) {
        this.sink.warning({ kind: 'discarded-event', ...discarded });
      }
    }
    this.mode = { kind: 'done' };
  }

  stop(): void {
    this.mode = { kind: 'done' };
  }

  private announce(): void {
    if (this.initial !== undefined) {
      this.sink.format(this.initial);
      this.initial = undefined;
    }
  }

  private modeFor(format: StreamFormat, head: Uint8Array | undefined): Mode {
    switch (format) {
      case 'sse':
        return { kind: 'sse', interpreter: new SseInterpreter(this.options.maxEventSize) };
      case 'ndjson':
        return { kind: 'ndjson' };
      default:
        return { kind: 'text', decoder: textDecoder(), head, offset: 0 };
    }
  }

  private drain(): void {
    for (let line = this.framer.next(); line !== undefined; line = this.framer.next()) {
      this.handle(line);
      if (this.mode.kind === 'text') {
        this.decodeText(this.mode, this.framer.takeRemaining(), false);
        return;
      }
    }
  }

  private handle(line: FramedLine): void {
    if (line.kind === 'line' && line.invalidUtf8) {
      this.warnUtf8(line.offset);
    }
    const mode = this.mode;
    switch (mode.kind) {
      case 'sniff': {
        const reach = mode.keptBytes + heldBeforeTerminator(line);
        mode.kept.push(line);
        mode.keptBytes += line.length;
        if (isMeaningful(line) && reach >= sniffBytes) {
          this.decideOnText(line.kind === 'line' ? line.text : line.preview, mode.kept);
        } else if (isMeaningful(line)) {
          this.sniff(line, mode.kept);
        }
        return;
      }
      case 'held':
        if (!isMeaningful(line)) {
          this.sink.text(lineText(line));
          return;
        }
        this.decide({ format: 'ndjson', reason: 'detected', contentType: this.contentType });
        this.mode = { kind: 'ndjson' };
        this.interpret(mode.line);
        this.interpret(line);
        return;
      case 'ndjson':
      case 'sse':
        this.interpret(line);
        return;
      case 'text':
      case 'done':
        return;
    }
  }

  private sniff(line: FramedLine, kept: readonly FramedLine[]): void {
    const guess = sniffText(line.kind === 'line' ? line.text : line.preview);
    if (guess === 'sse') {
      this.startSse(kept);
      return;
    }
    if (guess === 'text') {
      this.decide({ format: 'text', reason: 'detected', contentType: this.contentType });
      this.switchToText(kept);
      return;
    }
    this.decide({ format: 'json', reason: 'detected', contentType: this.contentType });
    const parsed = line.kind === 'line' ? parseJson(line.text) : undefined;
    if (parsed?.ok !== true) {
      this.switchToText(kept);
      return;
    }
    for (const keptLine of kept) {
      this.sink.text(lineText(keptLine));
    }
    this.mode = { kind: 'held', line };
  }

  private startSse(kept: readonly FramedLine[]): void {
    this.decide({ format: 'sse', reason: 'detected', contentType: this.contentType });
    this.mode = { kind: 'sse', interpreter: new SseInterpreter(this.options.maxEventSize) };
    for (const keptLine of kept) {
      this.interpret(keptLine);
    }
  }

  private decideOnPrefix(): void {
    if (this.mode.kind !== 'sniff') {
      return;
    }
    const prefix = textDecoder().decode(this.framer.peek(sniffBytes), { stream: true });
    if (sniffText(prefix) === 'sse') {
      this.startSse(this.mode.kept);
      return;
    }
    this.decideOnText(prefix, this.mode.kept);
    this.decodeText(this.mode, this.framer.takeRemaining(), false);
  }

  private decideOnText(text: string, kept: readonly FramedLine[]): void {
    const guess = sniffText(text);
    if (guess === 'sse') {
      this.startSse(kept);
      return;
    }
    this.decide({ format: guess, reason: 'detected', contentType: this.contentType });
    this.switchToText(kept);
  }

  private switchToText(kept: readonly FramedLine[]): void {
    for (const keptLine of kept) {
      this.sink.text(lineText(keptLine));
    }
    this.mode = { kind: 'text', decoder: textDecoder(), head: undefined, offset: 0 };
  }

  private decide(decision: FormatDecision): void {
    this.sink.format(decision);
  }

  private interpret(line: FramedLine): void {
    const mode = this.mode;
    const parsed =
      mode.kind === 'sse'
        ? mode.interpreter.line(line)
        : mode.kind === 'ndjson'
          ? ndjsonEvent(line)
          : undefined;
    if (parsed !== undefined) {
      this.emit(parsed);
    }
  }

  private emit(parsed: ParsedEvent): void {
    this.index += 1;
    this.sink.event({
      ...parsed,
      index: this.index,
      time: this.options.now(),
      label: eventLabel(parsed.value, parsed.sse, this.options.typeFields),
    });
  }

  private decodeText(mode: Mode, chunk: Uint8Array, last: boolean): void {
    if (mode.kind !== 'text') {
      return;
    }
    let bytes = chunk;
    if (mode.head !== undefined) {
      const head = mode.head.length === 0 ? chunk : Uint8Array.from([...mode.head, ...chunk]);
      if (!last && head.length < byteOrderMark.length && isMarkPrefix(head)) {
        mode.head = head;
        return;
      }
      mode.head = undefined;
      bytes =
        head.length >= byteOrderMark.length && isMarkPrefix(head.subarray(0, byteOrderMark.length))
          ? head.subarray(byteOrderMark.length)
          : head;
    }
    const text = mode.decoder.decode(bytes, { stream: !last });
    if (text.includes('�')) {
      this.warnUtf8(mode.offset);
    }
    mode.offset += bytes.length;
    if (text !== '') {
      this.sink.text(text);
    }
  }

  private warnUtf8(offset: number): void {
    if (!this.warnedUtf8) {
      this.warnedUtf8 = true;
      this.sink.warning({ kind: 'invalid-utf8', offset });
    }
  }
}

export function parseEventBytes(
  bytes: Uint8Array,
  format: 'sse' | 'ndjson',
  options: { maxEventSize: number; typeFields: readonly string[] },
): Omit<StreamEvent, 'index' | 'time'> | undefined {
  const framer = new LineFramer(options.maxEventSize);
  const interpreter = format === 'sse' ? new SseInterpreter(options.maxEventSize) : undefined;
  let last: ParsedEvent | undefined;
  const take = (line: FramedLine): void => {
    last = (interpreter ? interpreter.line(line) : ndjsonEvent(line)) ?? last;
  };
  framer.push(bytes);
  for (let line = framer.next(); line !== undefined; line = framer.next()) {
    take(line);
  }
  const final = framer.end();
  if (final !== undefined) {
    take(final);
  }
  return last && { ...last, label: eventLabel(last.value, last.sse, options.typeFields) };
}
