import type { SourcedValue } from '../environments/model';
import type { SystemContext } from './system';

export type DotenvState =
  | { kind: 'loaded'; values: ReadonlyMap<string, string>; path: string }
  | { kind: 'missing' }
  | { kind: 'restricted' };

export interface VariableSources {
  system: SystemContext;
  restricted: boolean;
  environmentName: string | undefined;
  environment: ReadonlyMap<string, SourcedValue>;
  shared: ReadonlyMap<string, SourcedValue>;
  secrets: ReadonlyMap<string, string>;
  dotenv: DotenvState;
  processEnv: Readonly<Record<string, string | undefined>>;
  privateFileIgnored: boolean;
}
