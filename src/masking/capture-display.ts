import { looksLikeCredential, maskedPreview, maskedValue, maskValues } from './masking';

export interface DisplayedCapture {
  name: string;
  secret: boolean;
  text: string;
  sensitive: readonly string[];
}

export function captureDisplayText(capture: DisplayedCapture, length?: number): string {
  if (capture.secret || looksLikeCredential(capture.name)) {
    return maskedValue;
  }
  return maskedPreview(maskValues(capture.text, capture.sensitive), length);
}
