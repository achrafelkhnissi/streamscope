import type { Directive, DirectiveKind, HttpFile, HttpRequest } from '../http-file/model';
import { formatBytes } from '../response/labels';
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
import type { SystemContext } from '../variables/system';
import type { BodyFileContext } from './body-files';
import { buildOutgoingRequest, type BuildResult } from './build-request';
import { parseDuration } from './duration';

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
  failure: RunFailure | undefined;
  problems: readonly ResolutionProblem[];
}

export interface RequestSettings {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  ca: readonly string[] | undefined;
  maxBodyBytes: number;
}

export interface RunInput {
  key: string;
  label: string;
  file: HttpFile;
  request: HttpRequest;
  bodyFiles: BodyFileContext;
  settings: RequestSettings;
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
}

type RunState = Omit<RunSnapshot, 'elapsedMs'>;

const timeoutMessage = 'Expected a duration such as 500ms, 30s or 5m.';
let nextRunId = 1;

function lastDirective(request: HttpRequest, kind: DirectiveKind): Directive | undefined {
  return request.directives.filter((directive) => directive.kind === kind).at(-1);
}

function hasDirective(request: HttpRequest, kind: DirectiveKind): boolean {
  return lastDirective(request, kind) !== undefined;
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
  let received = 0;
  let cancelled = false;
  let tooLarge = false;
  let endedAt: number | undefined;
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
    failure: undefined,
    problems: [],
  };

  const snapshot = (): RunSnapshot => ({
    ...state,
    elapsedMs: (endedAt ?? dependencies.clock()) - state.startedAt,
  });
  const wasCancelled = (): boolean => cancelled;
  const notify = (): void => {
    onChange?.(snapshot());
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
      Object.assign(state, { head, sent, status: 'receiving' });
      notify();
    },
    onData: (chunk) => {
      if (tooLarge) {
        return;
      }
      const room = settings.maxBodyBytes - received;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        received += room;
        tooLarge = true;
        controller.abort();
        return;
      }
      chunks.push(chunk);
      received += chunk.length;
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
      system: dependencies.system,
      restricted: false,
      environmentName: undefined,
      environment: new Map(),
      shared: new Map(),
      secrets: new Map(),
      dotenv: { kind: 'missing' },
      processEnv: {},
      privateFileIgnored: false,
    });
    const problems = [...timeoutProblems(), ...(resolution.ok ? [] : resolution.problems)];
    if (!resolution.ok || problems.length > 0) {
      return finish({ status: 'blocked', problems });
    }
    let built: BuildResult;
    try {
      built = await buildOutgoingRequest(resolution.request, resolution.scope, input.bodyFiles);
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
    if (wasCancelled()) {
      return finish({ status: 'cancelled' });
    }
    const timeout = lastDirective(request, 'timeout');
    const options: TransportOptions = {
      rejectUnauthorized: !hasDirective(request, 'insecure'),
      ca: settings.ca,
      connectTimeoutMs: settings.connectTimeoutMs,
      headersTimeoutMs: settings.headersTimeoutMs,
      totalTimeoutMs: timeout === undefined ? undefined : parseDuration(timeout.argument),
      followRedirects: settings.followRedirects && !hasDirective(request, 'no-redirect'),
      maxRedirects: settings.maxRedirects,
    };
    let outcome: Outcome;
    try {
      outcome = await dependencies.transport.send(built.request, options, sink, controller.signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return finish({
        status: 'failed',
        failure: {
          kind: 'invalid-request',
          message: `The request could not be sent: ${reason}.`,
        },
      });
    }
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
    cancel: () => {
      cancelled = true;
      controller.abort();
    },
  };
}
