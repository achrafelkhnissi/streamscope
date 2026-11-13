import type { SpillArea } from '../events/spill';
import type { RunHistory } from './history';

export function sessionShutdown(
  history: RunHistory,
  spill: Promise<SpillArea | undefined>,
): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      await history.dispose();
      await (await spill)?.dispose();
    })();
    return stopping;
  };
}
