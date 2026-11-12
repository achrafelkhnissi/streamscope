import * as path from 'node:path';
import type {
  EnvironmentCatalog,
  EnvironmentLayer,
  EnvironmentOrigin,
  SourcedValue,
} from './model';

const sharedName = '$shared';

export function originLabel(origin: EnvironmentOrigin, environment: string): string {
  const where = origin.kind === 'settings' ? 'settings' : path.basename(origin.path);
  const what = environment === sharedName ? sharedName : `${environment} environment`;
  return `${what} (${where})`;
}

function merged(
  layers: readonly EnvironmentLayer[],
  environment: string,
): ReadonlyMap<string, SourcedValue> {
  const result = new Map<string, SourcedValue>();
  for (const layer of layers) {
    for (const [name, value] of layer.environments.get(environment) ?? []) {
      result.set(name, { value, origin: originLabel(layer.origin, environment) });
    }
  }
  return result;
}

export function environmentCatalog(
  layers: readonly EnvironmentLayer[],
  active: string | undefined,
): EnvironmentCatalog {
  const names = new Set<string>();
  for (const layer of layers) {
    for (const name of layer.environments.keys()) {
      if (name !== sharedName) {
        names.add(name);
      }
    }
  }
  return {
    names: [...names].sort(),
    active,
    variables: active === undefined ? new Map() : merged(layers, active),
    shared: merged(layers, sharedName),
    insecure: active !== undefined && layers.some((layer) => layer.insecure.has(active)),
  };
}
