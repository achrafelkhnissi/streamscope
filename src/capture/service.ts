import type { HttpFile, HttpRequest } from '../http-file/model';
import {
  isSensitiveHeader,
  looksLikeCredential,
  sensitiveHeaderValues,
  sensitiveValuesIn,
} from '../masking/masking';
import type { CaptureWaitOutcome, RunCaptures, RunObserver } from '../runs/observer';
import type { ResponseHead } from '../transport/model';
import { responseSelector } from '../variables/references';
import { waitKey, type CaptureWait, type ResolutionProblem } from '../variables/resolve';
import type { CaptureLookup, CaptureLookupResult } from '../variables/sources';
import { captureLookup, inDocument, lookupResult, namedRequestKey, responseKey } from './lookup';
import {
  captureFailedMessage,
  ownCaptureReason,
  ownResponseReason,
  waitCancelledReason,
  waitTimeoutReason,
} from './messages';
import { evaluateResponseReference, type ReferencedRun } from './references';
import { CaptureWaitError, type CaptureEntry, type CaptureRegistry } from './registry';
import { CaptureTracker, readsSensitiveHead, type CaptureDefinition } from './tracker';

interface ProducerSnapshot {
  label: string;
  status: string;
  head: ResponseHead | undefined;
  bodyLength: number;
  failure: { message: string } | undefined;
  problems: readonly { message: string }[];
  sensitiveValues: readonly string[];
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

function producerSensitiveValues(snapshot: ProducerSnapshot, readsHead: boolean): string[] {
  return [
    ...snapshot.sensitiveValues,
    ...sensitiveHeaderValues(snapshot.head?.headers ?? [], readsHead),
  ];
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
    get sensitiveValues() {
      return producerSensitiveValues(run.snapshot(), false);
    },
    readBody: (maxBytes) => run.readBody(maxBytes),
    bodyFile: () => run.bodyFile(),
    workerFile,
  };
}

const finishedStates: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'blocked',
]);
const memberNames = /\.([A-Za-z_$][\w$-]*)|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]/g;

type Located =
  { kind: 'answered'; result: CaptureLookupResult } | { kind: 'producer'; run: ProducerRun };

function distinct(waits: readonly CaptureWait[]): CaptureWait[] {
  return [...new Map(waits.map((wait) => [waitKey(wait), wait])).values()];
}

function lastMemberName(query: string): string | undefined {
  let last: string | undefined;
  for (const match of query.matchAll(memberNames)) {
    last = match[1] ?? match[2] ?? match[3];
  }
  return last;
}

function sensitiveName(wait: ResponseWait): boolean {
  const selector = responseSelector(wait.requestName, wait.reference);
  if (!selector.ok) {
    return false;
  }
  if (selector.part === 'head') {
    return isSensitiveHeader(selector.header) || looksLikeCredential(selector.header);
  }
  const name = selector.query === undefined ? undefined : lastMemberName(selector.query);
  return name !== undefined && looksLikeCredential(name);
}

function readsHead(wait: ResponseWait): boolean {
  const selector = responseSelector(wait.requestName, wait.reference);
  return selector.ok && selector.part === 'head';
}

function startedLater(entry: CaptureEntry, other: CaptureEntry): boolean {
  return (
    entry.runStartedAt > other.runStartedAt ||
    (entry.runStartedAt === other.runStartedAt && entry.runId > other.runId)
  );
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
  private readonly names: ReadonlySet<string>;
  private readonly responses = new Map<string, CaptureLookupResult>();
  private readonly previous = new Map<string, CaptureEntry>();
  private key: string | undefined;
  private label: string | undefined;

  constructor(private readonly options: CaptureServiceOptions) {
    this.definitions = options.request.captures.flatMap(
      ({ name, secret, expression, expressionText }) =>
        expression === undefined
          ? []
          : [
              {
                name,
                secret: secret || readsSensitiveHead(expression),
                expression,
                text: expressionText,
              },
            ],
    );
    this.names = new Set(this.definitions.map((definition) => definition.name));
    const base = captureLookup(options.registry, options.documentUri, options.file, this.responses);
    const local = inDocument(options.documentUri);
    this.lookup = {
      request: (requestName, captureName) => {
        const result = base.request(requestName, captureName);
        return this.isOwn(result) ? this.previousValue(result.label, captureName) : result;
      },
      bare: (captureName) => this.newestInDocument(captureName, local),
      elsewhere: (captureName) => {
        const result = base.elsewhere(captureName);
        return this.label !== undefined &&
          this.names.has(captureName) &&
          (result === undefined || result.kind === 'not-run')
          ? { kind: 'failed', message: ownCaptureReason(this.label, captureName) }
          : result;
      },
      response: (requestName, reference) => base.response(requestName, reference),
    };
  }

  begin(run: { id: number; key: string; label: string; startedAt: number }): void {
    const { registry } = this.options;
    this.key = run.key;
    this.label = run.label;
    for (const entry of registry.forRequest(run.key)) {
      if (entry.result.state !== 'pending' && this.names.has(entry.name)) {
        this.previous.set(entry.name, entry);
      }
    }
    registry.begin(
      run,
      this.definitions.map(({ name, secret }) => ({ name, secret })),
    );
  }

  observer(run: {
    id: number;
    label: string;
    wallStartedAt: number;
    sensitiveValues: readonly string[];
  }): RunObserver | undefined {
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

  async settle(
    waits: readonly CaptureWait[],
    runId: number,
    signal: AbortSignal,
  ): Promise<readonly CaptureWait[]> {
    const remaining: CaptureWait[] = [];
    const evaluations: Promise<void>[] = [];
    for (const wait of distinct(waits)) {
      if (wait.kind === 'capture') {
        remaining.push(wait);
        continue;
      }
      const located = this.locate(wait, runId);
      if (located.kind === 'answered') {
        this.answer(wait, located.result);
      } else if (this.ready(wait, located.run)) {
        evaluations.push(
          this.evaluate(wait, located.run, signal).then((result) => {
            this.answer(wait, result);
          }),
        );
      } else {
        remaining.push(wait);
      }
    }
    await Promise.all(evaluations);
    return remaining;
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
    const problems: ResolutionProblem[] = [];
    try {
      await Promise.all(
        distinct(waits).map((wait) =>
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

  private isOwn(
    result: CaptureLookupResult | undefined,
  ): result is Extract<CaptureLookupResult, { kind: 'pending' }> {
    return result?.kind === 'pending' && result.request === this.key;
  }

  private previousValue(label: string, name: string): CaptureLookupResult {
    const previous = this.previous.get(name);
    return previous === undefined
      ? { kind: 'failed', message: ownCaptureReason(label, name) }
      : lookupResult(previous);
  }

  private newestInDocument(
    name: string,
    local: (request: string) => boolean,
  ): CaptureLookupResult | undefined {
    const other = this.options.registry.latest(
      name,
      (request) => request !== this.key && local(request),
    );
    const previous = this.previous.get(name);
    const newest =
      previous !== undefined && (other === undefined || startedLater(previous, other))
        ? previous
        : other;
    return newest === undefined ? undefined : lookupResult(newest);
  }

  private answer(wait: ResponseWait, result: CaptureLookupResult | undefined): void {
    if (result !== undefined) {
      this.responses.set(responseKey(wait.requestName, wait.reference), result);
    }
  }

  private locate(wait: ResponseWait, runId: number): Located {
    const label = wait.requestName;
    const { documentUri, registry, runs } = this.options;
    const run = runs(namedRequestKey(documentUri, label));
    if (run === undefined || registry.startedBeforeClear(run.id)) {
      return { kind: 'answered', result: { kind: 'not-run', label, producerName: label } };
    }
    if (run.id === runId) {
      return { kind: 'answered', result: { kind: 'failed', message: ownResponseReason(label) } };
    }
    return { kind: 'producer', run };
  }

  private outdated(wait: ResponseWait, producer: ProducerRun): boolean {
    const { documentUri, registry, runs } = this.options;
    return (
      runs(namedRequestKey(documentUri, wait.requestName)) !== producer ||
      registry.startedBeforeClear(producer.id)
    );
  }

  private ready(wait: ResponseWait, producer: ProducerRun): boolean {
    const { status, head } = producer.snapshot();
    return finishedStates.has(status) || (readsHead(wait) && head !== undefined);
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
    const located = this.locate(wait, runId);
    if (located.kind === 'answered') {
      this.answer(wait, located.result);
      return;
    }
    const producer = located.run;
    const arrived = readsHead(wait)
      ? Promise.race([producer.headArrived, producer.done])
      : producer.done;
    this.answer(
      wait,
      await within(
        arrived.then(() =>
          this.outdated(wait, producer) ? undefined : this.evaluate(wait, producer, signal),
        ),
        timeoutMs,
        signal,
        wait.requestName,
        wait.reference,
      ),
    );
  }

  private async evaluate(
    wait: ResponseWait,
    producer: ProducerRun,
    signal: AbortSignal,
  ): Promise<CaptureLookupResult | undefined> {
    const stopped = (): boolean => signal.aborted;
    if (stopped()) {
      return undefined;
    }
    const { requestName: label, reference } = wait;
    const result = await evaluateResponseReference(
      referencedRun(producer, this.options.workerFile),
      reference,
      signal,
    );
    if (stopped() || this.options.registry.startedBeforeClear(producer.id)) {
      return undefined;
    }
    if (!result.ok) {
      return { kind: 'failed', message: captureFailedMessage(label, reference, result.reason) };
    }
    const snapshot = producer.snapshot();
    const { wallStartedAt, elapsedMs } = snapshot;
    return {
      kind: 'value',
      text: result.text,
      secret: sensitiveName(wait) || this.secretOf(wait, producer.id, result.text),
      sensitive: sensitiveValuesIn(result.text, producerSensitiveValues(snapshot, readsHead(wait))),
      label,
      provenance: {
        runId: producer.id,
        event: undefined,
        path: reference,
        time: wallStartedAt + elapsedMs,
      },
    };
  }

  private secretOf(wait: ResponseWait, producerId: number, text: string): boolean {
    const { registry, documentUri } = this.options;
    return registry
      .forRequest(namedRequestKey(documentUri, wait.requestName))
      .some(
        ({ secret, runId, result }) =>
          secret &&
          runId === producerId &&
          (result.state === 'pending' || (result.state === 'resolved' && result.text === text)),
      );
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
    return { message, range: wait.range ?? reference?.range ?? request.requestLine.range };
  }
}
