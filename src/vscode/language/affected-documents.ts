import type { HttpFile } from '../../http-file/model';
import { requestKeyDocument } from '../../runs/run';

function referencesAny(file: HttpFile, names: ReadonlySet<string>): boolean {
  return file.requests.some((request) =>
    request.variableReferences.some(({ expression }) => names.has(expression)),
  );
}

export function affectedDocuments(
  requests: ReadonlySet<string>,
  names: ReadonlySet<string>,
  open: ReadonlyMap<string, HttpFile>,
): { hints: string[]; diagnostics: string[] } {
  const changed = new Set([...requests].map(requestKeyDocument));
  const hints: string[] = [];
  const diagnostics: string[] = [];
  for (const [uri, file] of open) {
    if (changed.has(uri)) {
      hints.push(uri);
    }
    if (referencesAny(file, names)) {
      diagnostics.push(uri);
    }
  }
  return { hints, diagnostics };
}
