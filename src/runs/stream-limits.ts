import {
  defaultSpillLimits,
  defaultStreamLimits,
  type SpillLimits,
  type StreamLimits,
} from '../streaming/limits';
import { parseSize } from './size';

export type LimitsResult<Limits> = { ok: true; limits: Limits } | { ok: false; message: string };

export interface StreamSettingValues {
  maxEventSize: string;
  memoryEvents: number;
  typeFields: unknown;
}

export interface SpillSettingValues {
  maxSpillSize: string;
  maxTotalSpillSize: string;
}

const minEventSize = 1024;
const maxEventSizeCap = 256 * 1024 * 1024;
const minMemoryEvents = 100;
const maxMemoryEvents = 1_000_000;
const minSpillSize = 1024 * 1024;

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function unreadableSize(name: string, value: string): { ok: false; message: string } {
  return fail(
    `streamscope.stream.${name} must be a size such as 512KiB, 16MiB or 2GiB, not "${value}".`,
  );
}

export function resolveStreamLimits(values: StreamSettingValues): LimitsResult<StreamLimits> {
  const maxEventSize = parseSize(values.maxEventSize);
  if (maxEventSize === undefined) {
    return unreadableSize('maxEventSize', values.maxEventSize);
  }
  if (maxEventSize < minEventSize || maxEventSize > maxEventSizeCap) {
    return fail(
      `streamscope.stream.maxEventSize must be a size from 1KiB to 256MiB, not "${values.maxEventSize}".`,
    );
  }
  const { memoryEvents } = values;
  if (
    !Number.isInteger(memoryEvents) ||
    memoryEvents < minMemoryEvents ||
    memoryEvents > maxMemoryEvents
  ) {
    return fail(
      `streamscope.stream.memoryEvents must be a whole number from ${String(minMemoryEvents)} to ${String(maxMemoryEvents)}, not ${String(memoryEvents)}.`,
    );
  }
  const names: unknown[] | undefined = Array.isArray(values.typeFields)
    ? (values.typeFields as unknown[])
    : undefined;
  if (
    !names?.length ||
    !names.every((name): name is string => typeof name === 'string' && name !== '')
  ) {
    return fail(
      `streamscope.stream.typeFields must be a non-empty list of field names, not ${JSON.stringify(values.typeFields)}.`,
    );
  }
  return {
    ok: true,
    limits: { ...defaultStreamLimits, maxEventSize, memoryEvents, typeFields: names },
  };
}

export function resolveSpillLimits(values: SpillSettingValues): LimitsResult<SpillLimits> {
  const maxFileSize = parseSize(values.maxSpillSize);
  if (maxFileSize === undefined) {
    return unreadableSize('maxSpillSize', values.maxSpillSize);
  }
  if (maxFileSize < minSpillSize) {
    return fail(
      `streamscope.stream.maxSpillSize must be a size of at least 1MiB, not "${values.maxSpillSize}".`,
    );
  }
  const maxTotalSize = parseSize(values.maxTotalSpillSize);
  if (maxTotalSize === undefined) {
    return unreadableSize('maxTotalSpillSize', values.maxTotalSpillSize);
  }
  if (maxTotalSize < maxFileSize) {
    return fail(
      `streamscope.stream.maxTotalSpillSize must be a size of at least streamscope.stream.maxSpillSize ("${values.maxSpillSize}"), not "${values.maxTotalSpillSize}".`,
    );
  }
  return { ok: true, limits: { ...defaultSpillLimits, maxFileSize, maxTotalSize } };
}
