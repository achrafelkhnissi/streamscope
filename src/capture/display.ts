import { captureDisplayText } from '../masking/capture-display';
import type { CaptureEntry } from './registry';
import type { CaptureResult } from './tracker';

export function entryValueText(
  entry: CaptureEntry,
  result: Extract<CaptureResult, { state: 'resolved' }>,
  length?: number,
): string {
  return captureDisplayText(
    {
      name: entry.name,
      secret: entry.secret || result.secret,
      text: result.text,
      sensitive: result.sensitive,
    },
    length,
  );
}
