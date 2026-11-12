import type { HttpFile, HttpRequest } from '../http-file/model';
import { missingSecrets } from './resolve';
import type { VariableSources } from './sources';

export function referencedSecrets(
  file: HttpFile,
  request: HttpRequest,
  sources: VariableSources,
): string[] {
  return missingSecrets(file, request, { ...sources, secrets: new Map() });
}
