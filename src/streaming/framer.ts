import { isUtf8 } from 'node:buffer';
import { previewBytes } from './limits';

export type LineTerminator = '' | '\n' | '\r' | '\r\n';

export type FramedLine =
  | {
      kind: 'line';
      text: string;
      terminator: LineTerminator;
      offset: number;
      length: number;
      number: number;
      invalidUtf8: boolean;
    }
  | {
      kind: 'oversize';
      preview: string;
      terminator: LineTerminator;
      offset: number;
      length: number;
      number: number;
    };

const lf = 0x0a;
const maxPieces = 16;
const cr = 0x0d;
export const byteOrderMark = [0xef, 0xbb, 0xbf];
const lineDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

function join(parts: readonly Uint8Array[], total: number): Uint8Array {
  const [first] = parts;
  if (parts.length === 1 && first !== undefined) {
    return first;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

export function firstBytes(pieces: readonly Uint8Array[], count: number): Uint8Array {
  const first = new Uint8Array(count);
  let at = 0;
  for (const piece of pieces) {
    if (at >= count) {
      break;
    }
    const taken = piece.subarray(0, count - at);
    first.set(taken, at);
    at += taken.length;
  }
  return first.subarray(0, at);
}

export function isMarkPrefix(bytes: Uint8Array): boolean {
  return bytes.every((byte, index) => byte === byteOrderMark[index]);
}

function decodePreview(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes, { stream: true });
}

export class LineFramer {
  private readonly previewLimit: number;
  private head: Uint8Array | undefined = new Uint8Array(0);
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private position = 0;
  private nextLf = -2;
  private nextCr = -2;
  private parts: Uint8Array[] = [];
  private gathered: Uint8Array | undefined;
  private partBytes = 0;
  private preview: Uint8Array | undefined;
  private pendingCr = false;
  private lineStart = 0;
  private consumed = 0;
  private lineNumber = 0;
  private stopped = false;

  constructor(private readonly maxLineBytes: number) {
    this.previewLimit = Math.min(previewBytes, maxLineBytes);
  }

  get lineOffset(): number {
    return this.lineStart;
  }

  get pendingBytes(): number {
    return (
      (this.head?.length ?? 0) +
      this.partBytes +
      (this.preview?.length ?? 0) +
      (this.pendingCr ? 1 : 0) +
      this.queuedBytes
    );
  }

  push(chunk: Uint8Array): void {
    if (this.stopped || chunk.length === 0) {
      return;
    }
    if (this.head === undefined) {
      this.enqueue(chunk);
      return;
    }
    const head =
      this.head.length === 0 ? chunk : join([this.head, chunk], this.head.length + chunk.length);
    if (head.length < byteOrderMark.length && isMarkPrefix(head)) {
      this.head = head;
      return;
    }
    this.head = undefined;
    if (isMarkPrefix(head.subarray(0, byteOrderMark.length))) {
      this.consumed = byteOrderMark.length;
      this.lineStart = byteOrderMark.length;
      this.enqueue(head.subarray(byteOrderMark.length));
      return;
    }
    this.enqueue(head);
  }

  next(): FramedLine | undefined {
    while (!this.stopped) {
      const chunk = this.queue[0];
      if (chunk === undefined) {
        return undefined;
      }
      if (this.pendingCr) {
        this.pendingCr = false;
        if (chunk[this.position] === lf) {
          this.advance(1);
          return this.finish('\r\n');
        }
        return this.finish('\r');
      }
      const terminator = this.findTerminator(chunk);
      if (terminator === -1) {
        this.append(chunk.subarray(this.position));
        this.advance(chunk.length - this.position);
        continue;
      }
      this.append(chunk.subarray(this.position, terminator));
      this.advance(terminator - this.position + 1);
      if (chunk[terminator] === lf) {
        return this.finish('\n');
      }
      this.pendingCr = true;
    }
    return undefined;
  }

  end(): FramedLine | undefined {
    if (this.stopped) {
      return undefined;
    }
    if (this.head !== undefined && this.head.length > 0) {
      this.append(this.head);
      this.consumed += this.head.length;
    }
    this.head = undefined;
    if (this.pendingCr) {
      this.pendingCr = false;
      return this.finish('\r');
    }
    if (this.partBytes > 0 || this.preview !== undefined) {
      return this.finish('');
    }
    return undefined;
  }

  peek(count: number): Uint8Array {
    const pieces = this.unconsumed();
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    return total === 0 ? new Uint8Array(0) : join(pieces, total).slice(0, count);
  }

  takeRemaining(): Uint8Array {
    const pieces = this.unconsumed();
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    this.stopped = true;
    this.head = undefined;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.clearLine();
    this.preview = undefined;
    this.pendingCr = false;
    return total === 0 ? new Uint8Array(0) : join(pieces, total);
  }

  private unconsumed(): Uint8Array[] {
    const pieces: Uint8Array[] = [];
    if (this.head !== undefined && this.head.length > 0) {
      pieces.push(this.head);
    }
    if (this.preview !== undefined) {
      pieces.push(this.preview);
    }
    pieces.push(...this.lineBytes());
    if (this.pendingCr) {
      pieces.push(Uint8Array.of(cr));
    }
    const [first, ...rest] = this.queue;
    if (first !== undefined) {
      pieces.push(first.subarray(this.position), ...rest);
    }
    return pieces;
  }

  private enqueue(chunk: Uint8Array): void {
    if (chunk.length > 0) {
      this.queue.push(chunk);
      this.queuedBytes += chunk.length;
    }
  }

  private findTerminator(chunk: Uint8Array): number {
    if (this.nextLf !== -1 && this.nextLf < this.position) {
      this.nextLf = chunk.indexOf(lf, this.position);
    }
    if (this.nextCr !== -1 && this.nextCr < this.position) {
      this.nextCr = chunk.indexOf(cr, this.position);
    }
    if (this.nextLf === -1) {
      return this.nextCr;
    }
    if (this.nextCr === -1) {
      return this.nextLf;
    }
    return Math.min(this.nextLf, this.nextCr);
  }

  private advance(count: number): void {
    this.position += count;
    this.consumed += count;
    this.queuedBytes -= count;
    const chunk = this.queue[0];
    if (chunk !== undefined && this.position >= chunk.length) {
      this.queue.shift();
      this.position = 0;
      this.nextLf = -2;
      this.nextCr = -2;
    }
  }

  private append(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.preview !== undefined) {
      return;
    }
    const needed = this.partBytes + bytes.length;
    if (needed > this.maxLineBytes) {
      this.preview = firstBytes([...this.lineBytes(), bytes], this.previewLimit);
      this.clearLine();
      return;
    }
    if (this.gathered === undefined && this.parts.length < maxPieces) {
      this.parts.push(bytes);
      this.partBytes = needed;
      return;
    }
    if (this.gathered === undefined || needed > this.gathered.length) {
      const grown = new Uint8Array(Math.min(this.maxLineBytes, Math.max(needed * 2, 4096)));
      let at = 0;
      for (const piece of this.lineBytes()) {
        grown.set(piece, at);
        at += piece.length;
      }
      this.gathered = grown;
      this.parts = [];
    }
    this.gathered.set(bytes, this.partBytes);
    this.partBytes = needed;
  }

  private lineBytes(): Uint8Array[] {
    return this.gathered === undefined ? this.parts : [this.gathered.subarray(0, this.partBytes)];
  }

  private clearLine(): void {
    this.parts = [];
    this.gathered = undefined;
    this.partBytes = 0;
  }

  private finish(terminator: LineTerminator): FramedLine {
    const offset = this.lineStart;
    const length = this.consumed - offset;
    this.lineStart = this.consumed;
    this.lineNumber += 1;
    const number = this.lineNumber;
    if (this.preview !== undefined) {
      const preview = decodePreview(this.preview);
      this.preview = undefined;
      return { kind: 'oversize', preview, terminator, offset, length, number };
    }
    const bytes = join(this.lineBytes(), this.partBytes);
    this.clearLine();
    const text = lineDecoder.decode(bytes);
    const invalidUtf8 = text.includes('�') && !isUtf8(bytes);
    return { kind: 'line', text, terminator, offset, length, number, invalidUtf8 };
  }
}
