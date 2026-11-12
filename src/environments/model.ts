export type EnvironmentOrigin =
  { kind: 'settings' } | { kind: 'file'; path: string } | { kind: 'private-file'; path: string };

export interface EnvironmentLayer {
  origin: EnvironmentOrigin;
  environments: ReadonlyMap<string, ReadonlyMap<string, string>>;
  insecure: ReadonlySet<string>;
}

export interface SourcedValue {
  value: string;
  origin: string;
}

export interface EnvironmentCatalog {
  names: string[];
  active: string | undefined;
  variables: ReadonlyMap<string, SourcedValue>;
  shared: ReadonlyMap<string, SourcedValue>;
  insecure: boolean;
}
