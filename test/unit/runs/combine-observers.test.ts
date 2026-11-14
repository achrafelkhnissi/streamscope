import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../../../src/events/model';
import { combineObservers } from '../../../src/runs/combine-observers';
import type { RunObserver } from '../../../src/runs/observer';

interface Fake {
  observer: RunObserver;
  calls: string[];
  congested: boolean;
  drain(): void;
}

function fake(name: string): Fake {
  const listeners = new Set<() => void>();
  const state: Fake = {
    calls: [],
    congested: false,
    drain() {
      state.congested = false;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    observer: {
      head: () => {
        state.calls.push(`${name} head`);
      },
      event: (event) => {
        state.calls.push(`${name} event ${String(event.index)}`);
      },
      end: (end) => {
        state.calls.push(`${name} end ${end.kind}`);
      },
      backpressure: {
        get congested() {
          return state.congested;
        },
        onDrain(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  };
  return state;
}

const event = { index: 1 } as StreamEvent;

describe('combineObservers', () => {
  it('forwards head, event and end to every observer', () => {
    const a = fake('a');
    const b = fake('b');
    const combined = combineObservers([a.observer, undefined, b.observer]);

    combined?.head(
      { httpVersion: '1.1', status: 200, statusText: 'OK', headers: [] },
      { spillPath: () => Promise.resolve(undefined), signal: new AbortController().signal },
    );
    combined?.event(event);
    combined?.end({ kind: 'cancelled' });

    expect([...a.calls, ...b.calls]).toEqual([
      'a head',
      'a event 1',
      'a end cancelled',
      'b head',
      'b event 1',
      'b end cancelled',
    ]);
  });

  it('is congested while any observer is, and drains when none is', () => {
    const a = fake('a');
    const b = fake('b');
    const combined = combineObservers([a.observer, b.observer]);
    let drains = 0;
    const stop = combined?.backpressure.onDrain(() => {
      drains += 1;
    });

    a.congested = true;
    b.congested = true;
    expect(combined?.backpressure.congested).toBe(true);
    a.drain();
    expect(combined?.backpressure.congested).toBe(true);
    expect(drains).toBe(0);
    b.drain();
    expect(combined?.backpressure.congested).toBe(false);
    expect(drains).toBe(1);
    stop?.();
    a.congested = true;
    a.drain();
    expect(drains).toBe(1);
  });

  it('returns undefined when no observer is given, and the observer itself when one is', () => {
    const a = fake('a');
    expect(combineObservers([undefined, undefined])).toBeUndefined();
    expect(combineObservers([undefined, a.observer])).toBe(a.observer);
  });
});
