import type { HttpFile } from '../http-file/model';
import { looksLikeCredential, maskedValue, maskUrl } from '../masking/masking';
import { captureProvenance, type VariableCompletion } from '../variables/inspect';
import type { CaptureLookup, CaptureLookupResult } from '../variables/sources';
import type { CaptureEntry } from './registry';

export interface CaptureHint {
  readonly label: string;
  readonly tooltip: string;
}

const maxHintLength = 60;
const maskedPrefixLength = 1_024;
const lineBreaks = /\r\n|[\r\n\u2028\u2029]/g;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function shortened(text: string): string {
  const head = maskUrl(text.slice(0, maskedPrefixLength)).replace(lineBreaks, ' ');
  if (head.length <= maxHintLength && text.length <= maskedPrefixLength) {
    return head;
  }
  const end = isHighSurrogate(head.charCodeAt(maxHintLength - 2))
    ? maxHintLength - 2
    : maxHintLength - 1;
  return `${head.slice(0, end)}…`;
}

function hidden(entry: CaptureEntry): boolean {
  return (
    entry.secret ||
    (entry.result.state === 'resolved' && entry.result.secret) ||
    looksLikeCredential(entry.name)
  );
}

function hintLabel(entry: CaptureEntry): string {
  const { result } = entry;
  switch (result.state) {
    case 'pending':
      return '…';
    case 'resolved':
      return `= ${hidden(entry) ? maskedValue : shortened(result.text)}`;
    case 'failed':
      return `✗ ${shortened(result.reason)}`;
  }
}

function hintTooltip(entry: CaptureEntry): string {
  const { result, label, name, secret, runId } = entry;
  const origin = `${label} › ${name} · run ${String(runId)}`;
  switch (result.state) {
    case 'pending':
      return `… has not arrived yet\n${origin}`;
    case 'resolved':
      return `= ${hidden(entry) ? maskedValue : maskUrl(result.text)}\n${captureProvenance({
        label,
        name,
        secret,
        provenance: result.provenance,
      })}`;
    case 'failed':
      return `✗ ${result.reason}\n${origin}`;
  }
}

export function captureHint(entry: CaptureEntry | undefined): CaptureHint | undefined {
  if (entry === undefined) {
    return undefined;
  }
  return {
    label: hintLabel(entry),
    get tooltip() {
      return hintTooltip(entry);
    },
  };
}

function completionDetail(result: CaptureLookupResult, name: string, reference: string): string {
  switch (result.kind) {
    case 'value':
      return `${result.label} › ${name} = ${
        result.secret || looksLikeCredential(reference) ? maskedValue : shortened(result.text)
      }`;
    case 'pending':
      return `${result.label} › ${name} …`;
    case 'failed':
      return `✗ ${shortened(result.message)}`;
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
