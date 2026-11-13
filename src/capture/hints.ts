import { looksLikeCredential, maskedPreview, maskedValue } from '../masking/masking';
import { captureProvenance } from '../variables/inspect';
import type { CaptureEntry } from './registry';

export interface CaptureHint {
  readonly label: string;
  readonly tooltip: string;
}

const maxHintLength = 60;
const lineBreaks = /\r\n|[\r\n\u2028\u2029]/g;

export function hintText(text: string): string {
  return maskedPreview(text, maxHintLength).replace(lineBreaks, ' ');
}

export function isSecret(entry: CaptureEntry): boolean {
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
      return `= ${isSecret(entry) ? maskedValue : hintText(result.text)}`;
    case 'failed':
      return `✗ ${hintText(result.reason)}`;
  }
}

function hintTooltip(entry: CaptureEntry): string {
  const { result, label, name, secret, runId } = entry;
  const origin = `${label} › ${name} · run ${String(runId)}`;
  switch (result.state) {
    case 'pending':
      return `… has not arrived yet\n${origin}`;
    case 'resolved':
      return `= ${isSecret(entry) ? maskedValue : maskedPreview(result.text)}\n${captureProvenance({
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
