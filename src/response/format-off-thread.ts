import { Worker } from 'node:worker_threads';
import { formatBody, type BodyLanguage } from './format-body';

export interface EncodedBody {
  languageId: BodyLanguage;
  binary: boolean;
  content: Uint8Array;
}

export const workerThresholdBytes = 1_048_576;

function inline(bytes: Uint8Array, contentType: string | undefined): EncodedBody {
  const formatted = formatBody(bytes, contentType);
  return {
    languageId: formatted.languageId,
    binary: formatted.binary,
    content: new TextEncoder().encode(formatted.text),
  };
}

const abortedMessage = 'Formatting the response body was aborted.';

export function formatBodyOffThread(
  bytes: Uint8Array,
  contentType: string | undefined,
  workerFile: string,
  signal?: AbortSignal,
): Promise<EncodedBody> {
  if (bytes.length <= workerThresholdBytes) {
    return Promise.resolve(inline(bytes, contentType));
  }
  if (signal?.aborted) {
    return Promise.reject(new Error(abortedMessage));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile);
    const finish = (settle: () => void): void => {
      signal?.removeEventListener('abort', onAbort);
      worker.removeAllListeners();
      void worker.terminate();
      settle();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(new Error(abortedMessage));
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (encoded: EncodedBody) => {
      finish(() => {
        resolve(encoded);
      });
    });
    worker.once('error', (error) => {
      finish(() => {
        reject(error);
      });
    });
    worker.once('exit', (code) => {
      finish(() => {
        reject(new Error(`The format worker exited with code ${String(code)}.`));
      });
    });
    const copy = new Uint8Array(bytes);
    worker.postMessage({ bytes: copy, contentType }, [copy.buffer]);
  });
}
