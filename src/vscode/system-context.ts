import { randomUUID } from 'node:crypto';
import type { SystemContext } from '../variables/system';

export const liveSystemContext: SystemContext = {
  now: () => new Date(),
  uuid: () => randomUUID(),
  randomInt: (minInclusive, maxExclusive) =>
    minInclusive + Math.floor(Math.random() * (maxExclusive - minInclusive)),
};
