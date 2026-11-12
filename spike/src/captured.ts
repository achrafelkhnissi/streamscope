import type { JsonValue } from '../../src/events/model';
import type { EventStore } from '../../src/events/store';

export interface CapturedValue {
  name: string;
  value: string | undefined;
}

function field(value: JsonValue | undefined, name: string): JsonValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return (value as { readonly [key: string]: JsonValue })[name];
}

export class CapturedValues {
  private scanned = 0;
  private readonly values = new Map<string, string>();

  constructor(private readonly names: readonly string[] = ['threadId', 'runId']) {}

  update(store: EventStore): void {
    for (let index = this.scanned + 1; index <= store.count; index += 1) {
      if (this.values.size === this.names.length) {
        break;
      }
      const value = store.inMemory(index)?.value;
      if (field(value, 'type') === 'RUN_STARTED') {
        for (const name of this.names) {
          const found = field(value, name);
          if (typeof found === 'string' && !this.values.has(name)) {
            this.values.set(name, found);
          }
        }
      }
    }
    this.scanned = store.count;
  }

  list(): CapturedValue[] {
    return this.names.map((name) => ({ name, value: this.values.get(name) }));
  }

  text(): string {
    return `Captured: ${this.list()
      .map(({ name, value }) => (value === undefined ? `${name} · waiting` : `${name} = ${value}`))
      .join('   ')}`;
  }
}
