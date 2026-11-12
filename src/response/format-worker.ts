import { parentPort } from 'node:worker_threads';
import { formatBody } from './format-body';

interface FormatRequest {
  bytes: Uint8Array;
  contentType: string | undefined;
}

parentPort?.once('message', ({ bytes, contentType }: FormatRequest) => {
  const formatted = formatBody(bytes, contentType);
  const content = new TextEncoder().encode(formatted.text);
  parentPort?.postMessage({ languageId: formatted.languageId, binary: formatted.binary, content }, [
    content.buffer,
  ]);
});
