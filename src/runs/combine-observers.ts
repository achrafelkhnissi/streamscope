import type { RunObserver } from './observer';

export function combineObservers(
  observers: readonly (RunObserver | undefined)[],
): RunObserver | undefined {
  const present = observers.filter((observer) => observer !== undefined);
  if (present.length <= 1) {
    return present[0];
  }
  const congested = (): boolean => present.some((observer) => observer.backpressure.congested);
  return {
    head: (head, access) => {
      for (const observer of present) {
        observer.head(head, access);
      }
    },
    event: (event) => {
      for (const observer of present) {
        observer.event(event);
      }
    },
    end: (end) => {
      for (const observer of present) {
        observer.end(end);
      }
    },
    backpressure: {
      get congested() {
        return congested();
      },
      onDrain(listener) {
        const stops = present.map((observer) =>
          observer.backpressure.onDrain(() => {
            if (!congested()) {
              listener();
            }
          }),
        );
        return () => {
          for (const stop of stops) {
            stop();
          }
        };
      },
    },
  };
}
