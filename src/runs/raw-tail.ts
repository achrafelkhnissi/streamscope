const lineSnapChars = 65_536;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export class RawTail {
  private readonly decoder = new TextDecoder();
  private pieces: string[] = [];
  private held = 0;
  private appended = 0;
  private trims = 0;

  constructor(private readonly maxChars: number) {}

  push(chunk: Uint8Array): void {
    this.append(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    this.append(this.decoder.decode());
  }

  get text(): string {
    if (this.pieces.length > 1) {
      this.pieces = [this.pieces.join('')];
    }
    return this.pieces[0] ?? '';
  }

  get total(): number {
    return this.appended;
  }

  get generation(): number {
    return this.trims;
  }

  get trimmed(): boolean {
    return this.trims > 0;
  }

  release(): void {
    this.pieces = [];
    this.held = 0;
  }

  since(offset: number): string | undefined {
    const start = this.appended - this.held;
    if (offset < start) {
      return undefined;
    }
    let wanted = this.appended - offset;
    let first = this.pieces.length;
    while (wanted > 0 && first > 0) {
      first -= 1;
      wanted -= this.pieces[first]?.length ?? 0;
    }
    const joined = this.pieces.slice(first).join('');
    return joined.slice(joined.length - (this.appended - offset));
  }

  private append(text: string): void {
    if (text === '') {
      return;
    }
    this.pieces.push(text);
    this.held += text.length;
    this.appended += text.length;
    if (this.held <= this.maxChars) {
      return;
    }
    const value = this.text;
    const half = value.length - Math.floor(this.maxChars / 2);
    const reach = Math.min(lineSnapChars, Math.floor(this.maxChars / 4));
    const newline = value.indexOf('\n', half - 1);
    const lineStart = newline + 1;
    const start =
      newline !== -1 && newline - (half - 1) <= reach && lineStart < value.length
        ? lineStart
        : half + (isLowSurrogate(value.charCodeAt(half)) ? 1 : 0);
    this.pieces = [value.slice(start)];
    this.held = value.length - start;
    this.trims += 1;
  }
}
