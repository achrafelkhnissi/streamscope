import * as path from 'node:path';
import type { EnvironmentLayer, EnvironmentOrigin } from './model';

const insecureKey = 'streamscope.insecure';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

function layerFrom(value: unknown, origin: EnvironmentOrigin): EnvironmentLayer {
  const environments = new Map<string, ReadonlyMap<string, string>>();
  const insecure = new Set<string>();
  if (isRecord(value)) {
    for (const [name, entries] of Object.entries(value)) {
      if (!isRecord(entries)) {
        continue;
      }
      const variables = new Map<string, string>();
      for (const [key, entry] of Object.entries(entries)) {
        if (key === insecureKey) {
          if (entry === true) {
            insecure.add(name);
          }
          continue;
        }
        const text = scalar(entry);
        if (text !== undefined) {
          variables.set(key, text);
        }
      }
      environments.set(name, variables);
    }
  }
  return { origin, environments, insecure };
}

export function parseSettingsEnvironments(value: unknown): EnvironmentLayer {
  return layerFrom(value, { kind: 'settings' });
}

export function parseEnvironmentFile(
  text: string,
  origin: EnvironmentOrigin,
): { ok: true; layer: EnvironmentLayer } | { ok: false; message: string } {
  const name = origin.kind === 'settings' ? 'settings' : path.basename(origin.path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${name} is not valid JSON: ${reason}` };
  }
  if (!isRecord(value)) {
    return { ok: false, message: `${name} must contain a JSON object of environments.` };
  }
  return { ok: true, layer: layerFrom(value, origin) };
}
