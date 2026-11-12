import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import * as path from 'node:path';
import { defaultSpillLimits, type SpillLimits } from '../streaming/limits';

const pidName = /^\d+$/;
const stagingLimit = 64 * 1024;
const copyChunkBytes = 1024 * 1024;

export type SpillCopy = 'complete' | 'capped' | 'unavailable';

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class SpillArea {
  private readonly files: SpillFile[] = [];
  private used = 0;

  private constructor(
    readonly directory: string,
    private readonly limits: SpillLimits,
  ) {}

  static async open(
    root: string,
    limits: SpillLimits = defaultSpillLimits,
    pid: number = process.pid,
  ): Promise<SpillArea> {
    const own = String(pid);
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        pidName.test(entry.name) &&
        entry.name !== own &&
        !isRunning(Number(entry.name))
      ) {
        await rm(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
    const directory = path.join(root, own);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { mode: 0o700 });
    return new SpillArea(directory, limits);
  }

  get totalSize(): number {
    return this.used;
  }

  async create(): Promise<SpillFile> {
    const filePath = path.join(this.directory, `${randomBytes(8).toString('hex')}.spill`);
    const stream = createWriteStream(filePath, {
      flags: 'wx',
      mode: 0o600,
      highWaterMark: this.limits.writeBufferBytes,
    });
    await once(stream, 'open');
    const stageBytes = Math.min(stagingLimit, this.limits.writeBufferBytes);
    const file = new SpillFile(filePath, stream, this.limits.maxFileSize, stageBytes, {
      reserve: (requester, bytes) => this.reserve(requester, bytes),
      release: (released, bytes) => {
        this.release(released, bytes);
      },
    });
    this.files.push(file);
    return file;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.files].map((file) => file.delete()));
    await rm(this.directory, { recursive: true, force: true });
  }

  private reserve(requester: SpillFile, bytes: number): boolean {
    while (this.used + bytes > this.limits.maxTotalSize) {
      const oldest = this.files.find((file) => file !== requester);
      if (oldest === undefined) {
        return false;
      }
      oldest.evict();
    }
    this.used += bytes;
    return true;
  }

  private release(file: SpillFile, bytes: number): void {
    this.used -= bytes;
    const index = this.files.indexOf(file);
    if (index !== -1) {
      this.files.splice(index, 1);
    }
  }
}

interface SpillAccount {
  reserve(requester: SpillFile, bytes: number): boolean;
  release(file: SpillFile, bytes: number): void;
}

export class SpillFile {
  private saved = 0;
  private written = 0;
  private stage: Uint8Array | undefined;
  private staged = 0;
  private flushQueued = false;
  private isCapped = false;
  private isEvicted = false;
  private removed = false;
  private finishing = false;
  private reader: Promise<FileHandle> | undefined;
  private removal: Promise<void> | undefined;
  private waiters: { until: number; resolve: () => void }[] = [];
  private readonly drainListeners = new Set<() => void>();

  constructor(
    readonly path: string,
    private readonly stream: WriteStream,
    private readonly maxFileSize: number,
    private readonly stageBytes: number,
    private readonly account: SpillAccount,
  ) {
    stream.on('error', () => {
      this.isCapped = true;
      this.releaseWaiting();
    });
    stream.on('drain', () => {
      this.notifyDrain();
    });
  }

  get savedBytes(): number {
    return this.saved;
  }

  get sidePath(): string {
    return `${this.path}.side`;
  }

  get capped(): boolean {
    return this.isCapped;
  }

  get evicted(): boolean {
    return this.isEvicted;
  }

  append(chunk: Uint8Array): boolean {
    if (this.isCapped || this.removed || this.finishing || chunk.length === 0) {
      return true;
    }
    if (this.saved + chunk.length > this.maxFileSize || !this.account.reserve(this, chunk.length)) {
      this.isCapped = true;
      return true;
    }
    if (chunk.length >= this.stageBytes) {
      this.flush();
      this.saved += chunk.length;
      return this.write(chunk, this.saved);
    }
    if (this.staged + chunk.length > this.stageBytes) {
      this.flush();
    }
    this.stage ??= new Uint8Array(this.stageBytes);
    this.stage.set(chunk, this.staged);
    this.staged += chunk.length;
    this.saved += chunk.length;
    if (!this.flushQueued) {
      this.flushQueued = true;
      setImmediate(() => {
        this.flushQueued = false;
        this.flush();
      });
    }
    return !this.stream.writableNeedDrain;
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => {
      this.drainListeners.delete(listener);
    };
  }

  async read(offset: number, length: number): Promise<Uint8Array | undefined> {
    if (this.removed || offset + length > this.saved) {
      return undefined;
    }
    const buffer = new Uint8Array(length);
    return (await this.readInto(buffer, offset)) ? buffer : undefined;
  }

  async copyTo(destination: string): Promise<SpillCopy> {
    if (this.removed) {
      return 'unavailable';
    }
    const end = this.saved;
    const capped = this.isCapped;
    const buffer = new Uint8Array(Math.min(copyChunkBytes, end));
    const temporary = path.join(
      path.dirname(destination),
      `.streamscope-${randomBytes(8).toString('hex')}.tmp`,
    );
    const target = await open(temporary, 'wx');
    let replaced = false;
    try {
      for (let offset = 0; offset < end; offset += buffer.length) {
        const chunk = buffer.subarray(0, Math.min(buffer.length, end - offset));
        if (!(await this.readInto(chunk, offset))) {
          return 'unavailable';
        }
        await target.writeFile(chunk);
      }
      await target.close();
      await rename(temporary, destination);
      replaced = true;
      return capped ? 'capped' : 'complete';
    } finally {
      await target.close().catch(() => undefined);
      if (!replaced) {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
  }

  async writeSide(bytes: Uint8Array): Promise<boolean> {
    if (this.isGone()) {
      return false;
    }
    try {
      await writeFile(this.sidePath, bytes, { mode: 0o600 });
    } catch {
      return false;
    }
    if (this.isGone()) {
      await rm(this.sidePath, { force: true }).catch(() => undefined);
      return false;
    }
    return true;
  }

  async readSide(): Promise<Uint8Array | undefined> {
    if (this.removed) {
      return undefined;
    }
    try {
      return await readFile(this.sidePath);
    } catch {
      return undefined;
    }
  }

  async finish(): Promise<void> {
    if (this.finishing || this.removed) {
      return;
    }
    this.flush();
    this.finishing = true;
    await new Promise<void>((resolve) => {
      this.stream.end(() => {
        resolve();
      });
    });
  }

  evict(): void {
    if (this.removed) {
      return;
    }
    this.isEvicted = true;
    this.removal = this.remove().catch(() => undefined);
  }

  async delete(): Promise<void> {
    if (this.removal === undefined) {
      this.removal = this.remove();
    }
    await this.removal;
  }

  private flush(): void {
    if (this.stage === undefined || this.staged === 0 || this.removed) {
      return;
    }
    const bytes = this.stage.subarray(0, this.staged);
    this.stage = undefined;
    this.staged = 0;
    this.write(bytes, this.saved);
  }

  private write(bytes: Uint8Array, end: number): boolean {
    return this.stream.write(bytes, () => {
      this.written = Math.max(this.written, end);
      this.wake(false);
    });
  }

  private async remove(): Promise<void> {
    this.removed = true;
    this.stage = undefined;
    this.staged = 0;
    this.account.release(this, this.saved);
    this.releaseWaiting();
    if (!this.stream.closed) {
      const closed = new Promise<void>((resolve) => {
        this.stream.once('close', () => {
          resolve();
        });
      });
      this.stream.destroy();
      await closed;
    }
    const reader = this.reader;
    this.reader = undefined;
    await reader?.then(
      (handle) => handle.close(),
      () => undefined,
    );
    await rm(this.path, { force: true });
    await rm(this.sidePath, { force: true });
  }

  private async readInto(buffer: Uint8Array, offset: number): Promise<boolean> {
    const end = offset + buffer.length;
    if (this.removed || end > this.saved) {
      return false;
    }
    if (this.written < end) {
      this.flush();
      await new Promise<void>((resolve) => {
        this.waiters.push({ until: end, resolve });
      });
    }
    if (!this.holds(end)) {
      return false;
    }
    this.reader ??= open(this.path, 'r').catch((error: unknown) => {
      this.reader = undefined;
      throw error;
    });
    const handle = await this.reader;
    if (!this.holds(end)) {
      return false;
    }
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return bytesRead === buffer.length;
  }

  private isGone(): boolean {
    return this.removed;
  }

  private holds(end: number): boolean {
    return !this.removed && this.written >= end;
  }

  private releaseWaiting(): void {
    this.wake(true);
    this.notifyDrain();
  }

  private notifyDrain(): void {
    for (const listener of [...this.drainListeners]) {
      listener();
    }
  }

  private wake(all: boolean): void {
    const ready = this.waiters.filter((waiter) => all || waiter.until <= this.written);
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) {
      waiter.resolve();
    }
  }
}
