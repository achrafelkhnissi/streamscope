import type { HttpFile, HttpRequest } from '../http-file/model';
import { maskUrl } from '../masking/masking';
import type { CaptureLookup, CaptureLookupResult } from '../variables/sources';
import { captureFailedMessage } from './messages';
import type { CaptureEntry, CaptureRegistry } from './registry';

interface Producer {
  request: HttpRequest;
  index: number;
}

const producers = new WeakMap<HttpFile, ReadonlyMap<string, Producer>>();

export function namedRequestKey(documentUri: string, requestName: string): string {
  return `${documentUri}\n@${requestName}`;
}

export function responseKey(requestName: string, reference: string): string {
  return `${requestName}\n${reference}`;
}

function producerIdentity(documentUri: string, { request, index }: Producer): string {
  const { method, url } = request.requestLine;
  return request.name ?? `${documentUri}\n#${String(index)} ${method.toUpperCase()} ${url}`;
}

function producerLabel(request: HttpRequest): string {
  return (
    request.name ??
    request.title ??
    `${request.requestLine.method.toUpperCase()} ${maskUrl(request.requestLine.url)}`
  );
}

export function lookupResult(entry: CaptureEntry): CaptureLookupResult {
  const { result, label, name } = entry;
  switch (result.state) {
    case 'pending':
      return { kind: 'pending', request: entry.request, label, name };
    case 'resolved':
      return {
        kind: 'value',
        text: result.text,
        secret: entry.secret,
        label,
        provenance: result.provenance,
      };
    case 'failed':
      return { kind: 'failed', message: captureFailedMessage(label, name, result.reason) };
  }
}

function firstProducers(file: HttpFile): ReadonlyMap<string, Producer> {
  const known = producers.get(file);
  if (known !== undefined) {
    return known;
  }
  const first = new Map<string, Producer>();
  for (const [index, request] of file.requests.entries()) {
    for (const capture of request.captures) {
      if (!first.has(capture.name)) {
        first.set(capture.name, { request, index });
      }
    }
  }
  producers.set(file, first);
  return first;
}

export function captureLookup(
  registry: CaptureRegistry,
  documentUri: string,
  file: HttpFile,
  responses: ReadonlyMap<string, CaptureLookupResult>,
): CaptureLookup {
  return {
    request: (requestName, captureName) => {
      const entry = registry.get(namedRequestKey(documentUri, requestName), captureName);
      return entry === undefined ? undefined : lookupResult(entry);
    },
    bare: (captureName) => {
      const entry = registry.latest(captureName);
      if (entry !== undefined) {
        return lookupResult(entry);
      }
      const producer = firstProducers(file).get(captureName);
      if (producer === undefined) {
        return undefined;
      }
      return {
        kind: 'not-run',
        label: producerLabel(producer.request),
        producerName: producerIdentity(documentUri, producer),
      };
    },
    response: (requestName, reference) => responses.get(responseKey(requestName, reference)),
  };
}
