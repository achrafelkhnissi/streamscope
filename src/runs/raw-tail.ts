function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export class RawTail {
  private readonly decoder = new TextDecoder();
  private value = '';
  private trims = 0;

  constructor(private readonly maxChars: number) {}

  push(chunk: Uint8Array): void {
    this.append(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    this.append(this.decoder.decode());
  }

  get text(): string {
    return this.value;
  }

  get generation(): number {
    return this.trims;
  }

  get trimmed(): boolean {
    return this.trims > 0;
  }

  private append(text: string): void {
    if (text === '') {
      return;
    }
    this.value += text;
    if (this.value.length <= this.maxChars) {
      return;
    }
    const half = this.value.length - Math.floor(this.maxChars / 2);
    const newline = this.value.indexOf('\n', half - 1);
    const lineStart = newline + 1;
    const start =
      newline !== -1 && lineStart < this.value.length
        ? lineStart
        : half + (isLowSurrogate(this.value.charCodeAt(half)) ? 1 : 0);
    this.value = this.value.slice(start);
    this.trims += 1;
  }
}
