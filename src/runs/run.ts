import { StreamSession } from '../events/session';
import type { SpillArea, SpillFile } from '../events/spill';
import type { Directive, DirectiveKind, HttpFile, HttpRequest } from '../http-file/model';
import { formatBytes } from '../response/labels';
import type { FormatDecision, StreamDirective } from '../streaming/detect';
import type { StreamLimits } from '../streaming/limits';
import type {
  FailureKind,
  Outcome,
  RedirectHop,
  ResponseHead,
  ResponseSink,
  SentRequest,
  Timing,
  Transport,
  TransportOptions,
} from '../transport/model';
import { resolveRequest, type ResolutionProblem } from '../variables/resolve';
import type { VariableSources } from '../variables/sources';
import type { SystemContext } from '../variables/system';
import type { BodyFileContext } from './body-files';
import { buildOutgoingRequest, type BuildResult } from './build-request';
import { parseDuration } from './duration';
import { RawTail } from './raw-tail';

export type RunStatus = 'sending' | 'receiving' | 'completed' | 'failed' | 'cancelled' | 'blocked';

export interface RunFailure {
  kind: FailureKind | 'body-too-large';
  message: string;
}

export interface RunSnapshot {
  id: number;
  key: string;
  label: string;
  status: RunStatus;
  startedAt: number;
  elapsedMs: number;
  sent: SentRequest | undefined;
  head: ResponseHead | undefined;
  hops: readonly RedirectHop[];
  timing: Timing | undefined;
  wireBytes: number;
  body: Uint8Array;
  bodyKept: boolean;
  stream: StreamSession | undefined;
  raw: RawTail;
  failure: RunFailure | undefined;
  problems: readonly ResolutionProblem[];
  sensitiveValues: readonly string[];
}

export interface RequestSettings {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  ca: readonly string[] | undefined;
  maxBodyBytes: number;
  insecureEnvironment: boolean;
}

export interface RunInput {
  key: string;
  label: string;
  file: HttpFile;
  request: HttpRequest;
  bodyFiles: Omit<BodyFileContext, 'restricted'>;
  settings: RequestSettings;
  variables: Omit<VariableSources, 'system' | 'restricted'>;
  restricted: boolean;
  confirmSend: (() => Promise<boolean>) | undefined;
  spill: SpillArea | undefined;
  limits: StreamLimits;
}

export interface RunDependencies {
  transport: Transport;
  system: SystemContext;
  clock(): number;
}

export interface RunHandle {
  readonly id: number;
  readonly done: Promise<RunSnapshot>;
  snapshot(): RunSnapshot;
  cancel(): void;
  onUpdate(listener: () => void): () => void;
  compact(): void;
  release(): Promise<void>;
}

type RunState = Omit<RunSnapshot, 'elapsedMs'>;

const timeoutMessage = 'Expected a duration such as 500ms, 30s or 5m.';
const rawTailChars = 2_097_152;
const streamDirectives: ReadonlySet<string> = new Set<StreamDirective>([
  'sse',
  'ndjson',
  'json',
  'text',
  'raw',
  'auto',
]);
let nextRunId = 1;

function lastDirective(request: HttpRequest, kind: DirectiveKind): Directive | undefined {
  return request.directives.filter((directive) => directive.kind === kind).at(-1);
}

function hasDirective(request: HttpRequest, kind: DirectiveKind): boolean {
  return lastDirective(request, kind) !== undefined;
}

function isStreamDirective(argument: string): argument is StreamDirective {
  return streamDirectives.has(argument);
}

function streamDirective(request: HttpRequest): StreamDirective | undefined {
  const argument = lastDirective(request, 'stream')?.argument;
  return argument !== undefined && isStreamDirective(argument) ? argument : undefined;
}

function isEventFormat(decision: FormatDecision | undefined): boolean {
  return decision?.format === 'sse' || decision?.format === 'ndjson';
}

function contentTypeOf(head: ResponseHead): string | undefined {
  return head.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

function drained(session: StreamSession): Promise<void> {
  return new Promise((resolve) => {
    const stop = session.onDrain(() => {
      stop();
      resolve();
    });
  });
}

async function createSpillFile(area: SpillArea | undefined): Promise<SpillFile | undefined> {
  try {
    return await area?.create();
  } catch {
    return undefined;
  }
}

async function deleteSpillFile(file: SpillFile | undefined): Promise<void> {
  await file?.delete().catch(() => undefined);
}

export function requestKey(documentUri: string, request: HttpRequest, index: number): string {
  return request.name === undefined
    ? `${documentUri}\n#${String(index)} ${request.requestLine.method.toUpperCase()} ${request.requestLine.url}`
    : `${documentUri}\n@${request.name}`;
}

export function startRun(
  input: RunInput,
  dependencies: RunDependencies,
  onChange?: (snapshot: RunSnapshot) => void,
): RunHandle {
  const { request, settings } = input;
  const id = nextRunId++;
  const controller = new AbortController();
  const chunks: Uint8Array[] = [];
  const listeners = new Set<() => void>();
  const raw = new RawTail(rawTailChars);
  let received = 0;
  let cancelled = false;
  let tooLarge = false;
  let endedAt: number | undefined;
  let session: StreamSession | undefined;
  let spillFile: SpillFile | undefined;
  const state: RunState = {
    id,
    key: input.key,
    label: input.label,
    status: 'sending',
    startedAt: dependencies.clock(),
    sent: undefined,
    head: undefined,
    hops: [],
    timing: undefined,
    wireBytes: 0,
    body: new Uint8Array(),
    bodyKept: true,
    stream: undefined,
    raw,
    failure: undefined,
    problems: [],
    sensitiveValues: [],
  };

  const snapshot = (): RunSnapshot => ({
    ...state,
    elapsedMs: (endedAt ?? dependencies.clock()) - state.startedAt,
  });
  const wasCancelled = (): boolean => cancelled;
  const update = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const notify = (): void => {
    onChange?.(snapshot());
    update();
  };
  const dropBodyOfEvents = (stream: StreamSession): void => {
    if (state.bodyKept && isEventFormat(stream.format)) {
      state.bodyKept = false;
      chunks.length = 0;
      received = 0;
    }
  };
  const closeStream = async (completed: boolean): Promise<void> => {
    if (session === undefined) {
      await deleteSpillFile(spillFile);
      return;
    }
    if (completed) {
      raw.end();
      session.end();
      dropBodyOfEvents(session);
    } else {
      session.stop();
    }
  };
  const cancel = (): void => {
    cancelled = true;
    controller.abort();
  };
  const finish = (changes: Partial<RunState>): RunSnapshot => {
    Object.assign(state, changes, { body: Buffer.concat(chunks) });
    chunks.length = 0;
    endedAt = dependencies.clock();
    notify();
    return snapshot();
  };

  const sink: ResponseSink = {
    onRequest: (sent) => {
      state.sent = sent;
    },
    onHead: (head, sent) => {
      session = new StreamSession({
        contentType: contentTypeOf(head),
        directive: streamDirective(request),
        spill: spillFile,
        now: () => dependencies.clock() - state.startedAt,
        onUpdate: update,
        onText: () => undefined,
        limits: input.limits,
      });
      Object.assign(state, { head, sent, status: 'receiving', stream: session });
      notify();
    },
    onData: (chunk) => {
      if (tooLarge || session === undefined) {
        return undefined;
      }
      raw.push(chunk);
      const accepted = session.write(chunk);
      dropBodyOfEvents(session);
      if (state.bodyKept) {
        const room = settings.maxBodyBytes - received;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          received += room;
          tooLarge = true;
          controller.abort();
          return undefined;
        }
        chunks.push(chunk);
        received += chunk.length;
      }
      return accepted ? undefined : drained(session);
    },
  };

  const timeoutProblems = (): ResolutionProblem[] => {
    const timeout = lastDirective(request, 'timeout');
    if (timeout === undefined || parseDuration(timeout.argument) !== undefined) {
      return [];
    }
    return [
      {
        message: timeoutMessage,
        range: timeout.argument === '' ? timeout.range : timeout.argumentRange,
      },
    ];
  };

  const run = async (): Promise<RunSnapshot> => {
    notify();
    if (wasCancelled()) {
      return finish({ status: 'cancelled' });
    }
    const resolution = resolveRequest(input.file, request, {
      ...input.variables,
      system: dependencies.system,
      restricted: input.restricted,
    });
    if (resolution.ok) {
      state.sensitiveValues = resolution.sensitiveValues;
    }
    const problems = [...timeoutProblems(), ...(resolution.ok ? [] : resolution.problems)];
    if (!resolution.ok || problems.length > 0) {
      return finish({ status: 'blocked', problems });
    }
    let built: BuildResult;
    try {
      built = await buildOutgoingRequest(resolution.request, resolution.scope, {
        ...input.bodyFiles,
        restricted: input.restricted,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return finish({
        status: 'failed',
        failure: { kind: 'body-file', message: `A body file could not be read: ${reason}.` },
      });
    }
    if (!built.ok) {
      return finish({ status: 'blocked', problems: built.problems });
    }
    if (input.confirmSend && !(await input.confirmSend())) {
      return finish({ status: 'cancelled' });
    }
    if (wasCancelled()) {
      return finish({ status: 'cancelled' });
    }
    const timeout = lastDirective(request, 'timeout');
    const options: TransportOptions = {
      rejectUnauthorized:
        input.restricted || !(hasDirective(request, 'insecure') || settings.insecureEnvironment),
      ca: settings.ca,
      connectTimeoutMs: settings.connectTimeoutMs,
      headersTimeoutMs: settings.headersTimeoutMs,
      totalTimeoutMs: timeout === undefined ? undefined : parseDuration(timeout.argument),
      followRedirects: settings.followRedirects && !hasDirective(request, 'no-redirect'),
      maxRedirects: settings.maxRedirects,
    };
    spillFile = await createSpillFile(input.spill);
    let outcome: Outcome;
    try {
      outcome = await dependencies.transport.send(built.request, options, sink, controller.signal);
    } catch (error) {
      await closeStream(false);
      const reason = error instanceof Error ? error.message : String(error);
      return finish({
        status: 'failed',
        failure: {
          kind: 'invalid-request',
          message: `The request could not be sent: ${reason}.`,
        },
      });
    }
    await closeStream(outcome.kind === 'completed');
    const exchange = { hops: outcome.hops, timing: outcome.timing, wireBytes: outcome.wireBytes };
    if (outcome.kind === 'completed') {
      return finish({ ...exchange, status: 'completed' });
    }
    if (outcome.kind === 'failed') {
      const { kind, message } = outcome.failure;
      return finish({ ...exchange, status: 'failed', failure: { kind, message } });
    }
    if (tooLarge) {
      return finish({
        ...exchange,
        status: 'failed',
        failure: {
          kind: 'body-too-large',
          message: `The response body is larger than ${formatBytes(settings.maxBodyBytes)}, so Streamscope stopped reading it.`,
        },
      });
    }
    return finish({ ...exchange, status: 'cancelled' });
  };

  return {
    id,
    done: Promise.resolve().then(run),
    snapshot,
    cancel,
    onUpdate: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    compact: () => {
      session?.store.release();
    },
    release: async () => {
      cancel();
      session?.dispose();
      await deleteSpillFile(spillFile);
    },
  };
}
