export interface StreamLimits {
  maxEventSize: number;
  memoryEvents: number;
  memoryBytes: number;
  typeFields: readonly string[];
  batchIntervalMs: number;
}

export const defaultStreamLimits: Readonly<StreamLimits> = {
  maxEventSize: 16 * 1024 * 1024,
  memoryEvents: 10_000,
  memoryBytes: 16 * 1024 * 1024,
  typeFields: ['type', 'event', 'object'],
  batchIntervalMs: 50,
};

export const sniffBytes = 64 * 1024;
export const previewBytes = 1024;
export const maxLabelLength = 100;
export const maxLabels = 4096;
export const maxIndexedEvents = 2_097_152;
export const maxReplyLength = 1_048_576;

export interface SpillLimits {
  maxFileSize: number;
  maxTotalSize: number;
  writeBufferBytes: number;
}

export const defaultSpillLimits: Readonly<SpillLimits> = {
  maxFileSize: 512 * 1024 * 1024,
  maxTotalSize: 2 * 1024 * 1024 * 1024,
  writeBufferBytes: 4 * 1024 * 1024,
};
