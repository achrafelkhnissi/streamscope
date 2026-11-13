import type { HttpFile } from '../http-file/model';
import { looksLikeCredential, maskedValue } from '../masking/masking';
import type { VariableCompletion } from '../variables/inspect';
import type { CaptureLookup, CaptureLookupResult } from '../variables/sources';
import { hintText } from './hints';

function completionDetail(result: CaptureLookupResult, name: string, reference: string): string {
  switch (result.kind) {
    case 'value':
      return `${result.label} › ${name} = ${
        result.secret || looksLikeCredential(reference) ? maskedValue : hintText(result.text)
      }`;
    case 'pending':
      return `${result.label} › ${name} …`;
    case 'failed':
      return `✗ ${hintText(result.message)}`;
    case 'not-run':
      return `${result.label} › ${name} · not run yet`;
  }
}

export function captureCompletions(file: HttpFile, lookup: CaptureLookup): VariableCompletion[] {
  const completions = new Map<string, string>();
  for (const request of file.requests) {
    for (const { name } of request.captures) {
      const requestName = request.name;
      if (requestName !== undefined) {
        const reference = `${requestName}.${name}`;
        if (!completions.has(reference)) {
          const result = lookup.request(requestName, name) ?? {
            kind: 'not-run',
            label: requestName,
            producerName: requestName,
          };
          completions.set(reference, completionDetail(result, name, reference));
        }
      }
      if (!completions.has(name)) {
        const bare = lookup.bare(name);
        if (bare !== undefined) {
          completions.set(name, completionDetail(bare, name, name));
        }
      }
    }
  }
  return [...completions].map(([label, detail]) => ({ label, detail }));
}
