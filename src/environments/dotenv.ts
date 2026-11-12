import * as path from 'node:path';

const linePattern = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/;
const environmentFileName = /^[\w-][\w.-]*$/;
const doubleQuoteEscapes: Record<string, string> = { n: '\n', r: '\r', t: '\t' };

function unquote(raw: string): string {
  const quote = raw[0];
  if (quote === '"') {
    const end = raw.indexOf('"', 1);
    const inner = end === -1 ? raw.slice(1) : raw.slice(1, end);
    return inner.replace(
      /\\(.)/g,
      (_, character: string) => doubleQuoteEscapes[character] ?? character,
    );
  }
  if (quote === "'") {
    const end = raw.indexOf("'", 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  const comment = raw.indexOf('#');
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

export function parseDotenv(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) {
      continue;
    }
    const match = linePattern.exec(line);
    if (match?.[1] !== undefined) {
      values.set(match[1], unquote((match[2] ?? '').trim()));
    }
  }
  return values;
}

function isWithin(folder: string, root: string): boolean {
  const relative = path.relative(root, folder);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function dotenvCandidates(
  documentDir: string,
  containmentRoot: string,
  environment: string | undefined,
): string[] {
  const names =
    environment !== undefined &&
    environmentFileName.test(environment) &&
    !environment.includes('..')
      ? [`.env.${environment}`, '.env']
      : ['.env'];
  const candidates: string[] = [];
  let folder = documentDir;
  for (;;) {
    candidates.push(...names.map((name) => path.join(folder, name)));
    const parent = path.dirname(folder);
    if (folder === containmentRoot || parent === folder || !isWithin(folder, containmentRoot)) {
      return candidates;
    }
    folder = parent;
  }
}
