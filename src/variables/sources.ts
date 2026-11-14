import type { SourcedValue } from '../environments/model';
import type { SystemContext } from './system';

export type DotenvState =
  | { kind: 'loaded'; values: ReadonlyMap<string, string>; path: string }
  | { kind: 'missing' }
  | { kind: 'restricted' };

export type CaptureLookupResult =
  | {
      kind: 'value';
      text: string;
      secret: boolean;
      sensitive: readonly string[];
      label: string;
      provenance: { runId: number; event: number | undefined; path: string; time: number };
    }
  | { kind: 'pending'; request: string; label: string; name: string }
  | { kind: 'failed'; message: string }
  | { kind: 'not-run'; label: string; producerName: string | undefined };

export interface CaptureLookup {
  request(requestName: string, captureName: string): CaptureLookupResult | undefined;
  bare(captureName: string): CaptureLookupResult | undefined;
  elsewhere(captureName: string): CaptureLookupResult | undefined;
  response(requestName: string, reference: string): CaptureLookupResult | undefined;
}

export const emptyCaptureLookup: CaptureLookup = {
  request: () => undefined,
  bare: () => undefined,
  elsewhere: () => undefined,
  response: (requestName) => ({ kind: 'not-run', label: requestName, producerName: requestName }),
};

export interface VariableSources {
  system: SystemContext;
  restricted: boolean;
  environmentName: string | undefined;
  environment: ReadonlyMap<string, SourcedValue>;
  shared: ReadonlyMap<string, SourcedValue>;
  secrets: ReadonlyMap<string, string>;
  dotenv: DotenvState;
  processEnv: Readonly<Record<string, string | undefined>>;
  captures: CaptureLookup;
}
