import type { HttpFile, HttpRequest } from '../http-file/model';
import type { CaptureWaitOutcome, RunCaptures, RunObserver } from '../runs/observer';
import type { ResponseHead } from '../transport/model';
import { responseSelector } from '../variables/references';
import type { CaptureWait, ResolutionProblem } from '../variables/resolve';
import type { CaptureLookup, CaptureLookupResult } from '../variables/sources';
import { captureLookup, lookupResult, namedRequestKey, responseKey } from './lookup';
import {
  captureFailedMessage,
  ownCaptureReason,
  waitCancelledReason,
  waitTimeoutReason,
} from './messages';
import { evaluateResponseReference, type ReferencedRun, type ReferenceResult } from './references';
import { CaptureWaitError, type CaptureEntry, type CaptureRegistry } from './registry';
import { CaptureTracker, type CaptureDefinition } from './tracker';

interface ProducerSnapshot {
  label: string;
  status: string;
  head: ResponseHead | undefined;
  bodyLength: number;
  failure: { message: string } | undefined;
  problems: readonly { message: string }[];
  wallStartedAt: number;
  elapsedMs: number;
}

export interface ProducerRun {
  readonly id: number;
  readonly done: Promise<unknown>;
  readonly headArrived: Promise<void>;
  snapshot(): ProducerSnapshot;
  readBody(maxBytes: number): Promise<Uint8Array | undefined>;
  bodyFile(): Promise<{ path: string; length: number } | undefined>;
}

export interface CaptureServiceOptions {
  registry: CaptureRegistry;
  documentUri: string;
  file: HttpFile;
  request: HttpRequest;
  workerFile: string;
  runs: (key: string) => ProducerRun | undefined;
}

type ResponseWait = Extract<CaptureWait, { kind: 'response' }>;

function failureText(snapshot: ProducerSnapshot): string | undefined {
  return snapshot.status === 'blocked'
    ? snapshot.problems.map((problem) => problem.message).join(' ')
    : snapshot.failure?.message;
}

function referencedRun(run: ProducerRun, workerFile: string): ReferencedRun {
  return {
    get label() {
      return run.snapshot().label;
    },
    get status() {
      return run.snapshot().status;
    },
    get head() {
      return run.snapshot().head;
    },
    get bodyLength() {
      return run.snapshot().bodyLength;
    },
    done: run.done,
    headArrived: run.headArrived,
    failure: () => failureText(run.snapshot()),
    readBody: (maxBytes) => run.readBody(maxBytes),
    bodyFile: () => run.bodyFile(),
    workerFile,
  };
}

function waitKey(wait: CaptureWait): string {
  return wait.kind === 'capture'
    ? `capture\n${wait.request}\n${wait.name}`
    : `response\n${wait.requestName}\n${wait.reference}`;
}

function within<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string,
  name: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => {
      end();
      reject(new CaptureWaitError('cancelled', waitCancelledReason(label, name)));
    };
    const timer = setTimeout(() => {
      end();
      reject(new CaptureWaitError('timeout', waitTimeoutReason(label, name, timeoutMs)));
    }, timeoutMs);
    const end = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
    };
    if (signal.aborted) {
      cancelled();
      return;
    }
    signal.addEventListener('abort', cancelled, { once: true });
    work.finally(end).then(resolve, reject);
  });
}

export class CaptureService implements RunCaptures {
  readonly lookup: CaptureLookup;
  private readonly definitions: readonly CaptureDefinition[];
  private readonly responses = new Map<string, CaptureLookupResult>();
  private readonly previous = new Map<string, CaptureEntry>();
  private key: string | undefined;

  constructor(private readonly options: CaptureServiceOptions) {
    this.definitions = options.request.captures.flatMap(
      ({ name, secret, expression, expressionText }) =>
        expression === undefined ? [] : [{ name, secret, expression, text: expressionText }],
    );
    const base = captureLookup(options.registry, options.documentUri, options.file, this.responses);
    this.lookup = {
      request: (requestName, captureName) => this.ownValue(base.request(requestName, captureName)),
      bare: (captureName) => this.ownValue(base.bare(captureName)),
      response: (requestName, reference) => base.response(requestName, reference),
    };
  }

  begin(run: { id: number; key: string; label: string; startedAt: number }): void {
    const { registry } = this.options;
    const names = new Set(this.definitions.map((definition) => definition.name));
    this.key = run.key;
    for (const entry of registry.forRequest(run.key)) {
      if (entry.result.state === 'resolved' && names.has(entry.name)) {
        this.previous.set(entry.name, entry);
      }
    }
    registry.begin(
      run,
      this.definitions.map(({ name, secret }) => ({ name, secret })),
    );
  }

  observer(run: { id: number; label: string; wallStartedAt: number }): RunObserver | undefined {
    this.previous.clear();
    this.responses.clear();
    if (this.definitions.length === 0) {
      return undefined;
    }
    const { registry, workerFile } = this.options;
    const tracker = new CaptureTracker(
      run,
      this.definitions,
      (name, result) => {
        registry.update(run.id, name, result);
      },
      workerFile,
    );
    return {
      head: (head, access) => {
        tracker.head(head, access);
      },
      event: (event) => {
        tracker.event(event);
      },
      end: (end) => {
        void tracker.end(end);
      },
      backpressure: tracker,
    };
  }

  async wait(
    waits: readonly CaptureWait[],
    runId: number,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<CaptureWaitOutcome> {
    const { timeoutMs, signal } = options;
    const stop = new AbortController();
    const cancel = (): void => {
      stop.abort();
    };
    if (signal.aborted) {
      stop.abort();
    } else {
      signal.addEventListener('abort', cancel, { once: true });
    }
    const distinct = new Map(waits.map((wait) => [waitKey(wait), wait]));
    const problems: ResolutionProblem[] = [];
    try {
      await Promise.all(
        [...distinct.values()].map((wait) =>
          this.waitFor(wait, runId, timeoutMs, stop.signal).catch((error: unknown) => {
            if (!(error instanceof CaptureWaitError)) {
              throw error;
            }
            problems.push(this.problem(wait, error.message));
            stop.abort();
          }),
        ),
      );
    } finally {
      signal.removeEventListener('abort', cancel);
      stop.abort();
    }
    const [problem] = problems;
    return problem === undefined ? { ok: true } : { ok: false, problem };
  }

  private ownValue(result: CaptureLookupResult | undefined): CaptureLookupResult | undefined {
    if (result?.kind !== 'pending' || result.request !== this.key) {
      return result;
    }
    const previous = this.previous.get(result.name);
    return previous === undefined
      ? { kind: 'failed', message: ownCaptureReason(result.label, result.name) }
      : lookupResult(previous);
  }

  private async waitFor(
    wait: CaptureWait,
    runId: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (wait.kind === 'capture') {
      await this.options.registry.wait(wait.request, wait.name, runId, { timeoutMs, signal });
      return;
    }
    this.responses.set(
      responseKey(wait.requestName, wait.reference),
      await this.response(wait, runId, timeoutMs, signal),
    );
  }

  private async response(
    wait: ResponseWait,
    runId: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CaptureLookupResult> {
    const { requestName: label, reference } = wait;
    const { documentUri, runs, workerFile } = this.options;
    const producer = runs(namedRequestKey(documentUri, label));
    if (producer === undefined) {
      return { kind: 'not-run', label, producerName: label };
    }
    if (producer.id === runId) {
      return { kind: 'failed', message: ownCaptureReason(label, reference) };
    }
    const selector = responseSelector(label, reference);
    const ready =
      selector.ok && selector.part === 'head'
        ? Promise.race([producer.headArrived, producer.done])
        : producer.done;
    const evaluate = async (): Promise<ReferenceResult> => {
      await ready;
      signal.throwIfAborted();
      return evaluateResponseReference(referencedRun(producer, workerFile), reference);
    };
    const result = await within(evaluate(), timeoutMs, signal, label, reference);
    if (!result.ok) {
      return { kind: 'failed', message: captureFailedMessage(label, reference, result.reason) };
    }
    const { wallStartedAt, elapsedMs } = producer.snapshot();
    return {
      kind: 'value',
      text: result.text,
      secret: false,
      label,
      provenance: {
        runId: producer.id,
        event: undefined,
        path: reference,
        time: wallStartedAt + elapsedMs,
      },
    };
  }

  private problem(wait: CaptureWait, message: string): ResolutionProblem {
    const { request } = this.options;
    const expressions =
      wait.kind === 'capture'
        ? [wait.name, `${wait.label}.${wait.name}`]
        : [`${wait.requestName}.${wait.reference}`];
    const reference = request.variableReferences.find((candidate) =>
      expressions.includes(candidate.expression),
    );
    return { message, range: reference?.range ?? request.requestLine.range };
  }
}
