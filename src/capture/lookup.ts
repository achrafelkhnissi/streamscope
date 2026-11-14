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
const declarers = new WeakMap<
  HttpFile,
  { documentUri: string; keys: ReadonlyMap<string, ReadonlySet<string>> }
>();
const noKeys: ReadonlySet<string> = new Set();

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

export function declaringKeys(
  documentUri: string,
  file: HttpFile,
  name: string,
): ReadonlySet<string> {
  const known = declarers.get(file);
  if (known?.documentUri === documentUri) {
    return known.keys.get(name) ?? noKeys;
  }
  const keys = new Map<string, Set<string>>();
  for (const [index, request] of file.requests.entries()) {
    const key =
      request.name === undefined
        ? producerIdentity(documentUri, { request, index })
        : namedRequestKey(documentUri, request.name);
    for (const capture of request.captures) {
      const declaring = keys.get(capture.name);
      if (declaring === undefined) {
        keys.set(capture.name, new Set([key]));
      } else {
        declaring.add(key);
      }
    }
  }
  declarers.set(file, { documentUri, keys });
  return keys.get(name) ?? noKeys;
}

function producerLabel(request: HttpRequest): string {
  return (
    request.name ??
    request.title ??
    `${request.requestLine.method.toUpperCase()} ${maskUrl(request.requestLine.url)}`
  );
}

export function lookupResult(entry: CaptureEntry, secretPending: boolean): CaptureLookupResult {
  const { result, label, name } = entry;
  switch (result.state) {
    case 'pending':
      return { kind: 'pending', request: entry.request, label, name };
    case 'resolved':
      return {
        kind: 'value',
        text: result.text,
        secret: entry.secret,
        sensitive: result.sensitive,
        label,
        provenance: result.provenance,
        ...(secretPending ? { secretPending: true } : {}),
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
  const found = (entry: CaptureEntry | undefined): CaptureLookupResult | undefined =>
    entry === undefined ? undefined : lookupResult(entry, registry.hasPendingSecret(entry.runId));
  return {
    request: (requestName, captureName) =>
      found(registry.get(namedRequestKey(documentUri, requestName), captureName)),
    bare: (captureName) => {
      const declared = declaringKeys(documentUri, file, captureName);
      return found(registry.latest(captureName, (request) => declared.has(request)));
    },
    elsewhere: (captureName) => {
      const declared = declaringKeys(documentUri, file, captureName);
      const entry = found(registry.latest(captureName, (request) => !declared.has(request)));
      if (entry !== undefined) {
        return entry;
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
