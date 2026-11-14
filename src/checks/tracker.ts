import {
  bodyLimitReason,
  bodyNotSentReason,
  bodyUnavailableReason,
  evaluationCancelledReason,
  eventsLimitReason,
  eventsUnavailableReason,
  eventUnavailableReason,
  hostWorkReason,
  jsonPathLimitReason,
  replyCutOffReason,
  replyUnavailableReason,
} from '../capture/messages';
import {
  captureSliceMs,
  hostBudget,
  hostEvaluationUnits,
  type TaskBudget,
} from '../capture/task-budget';
import {
  CaptureTracker,
  readsHeadersOrCookies,
  type CaptureDefinition,
  type CaptureResult,
} from '../capture/tracker';
import type { StreamEvent } from '../events/model';
import type { EventBackpressure } from '../events/session';
import type { Value } from '../expressions/ast';
import { compactJson, maxInsertedLength, valueTooLargeReason } from '../expressions/insert';
import { parseExpression } from '../expressions/parse';
import { WorkBudget } from '../expressions/work';
import { maskUrl, maskValues, sensitiveHeaderValues } from '../masking/masking';
import type { RunAccess, RunEnd } from '../runs/observer';
import { parseJson } from '../streaming/json';
import type { ResponseHead } from '../transport/model';
import type { CheckProgram, Skeleton, Term } from './compile';
import {
  cutText,
  tooMuchWorkDetail,
  verdictOf,
  type Judged,
  type TermState,
  type Verdict,
} from './verdict';

export interface CheckDefinition {
  index: number;
  program: CheckProgram;
}

export type CheckResult = Exclude<Verdict, { state: 'pending' }> & {
  settledAt: number | undefined;
};

type Role = 'value' | 'count' | 'before-first' | 'before-second';

interface Use {
  check: Checked;
  term: number;
  role: Role;
}

interface Sides {
  first: number | undefined;
  second: number | undefined;
  firstFinal: boolean;
  secondFinal: boolean;
}

interface Checked {
  readonly definition: CheckDefinition;
  readonly readsHead: boolean;
  readonly states: Map<number, TermState>;
  readonly sides: Map<number, Sides>;
  readonly memo: Map<Skeleton, Judged>;
  overflow: boolean;
  settled: boolean;
}

export const maxCheckValues = 64;
export const maxCheckDetail = 4_096;
const overflowDetail = `the checks of this request read more than ${String(maxCheckValues)} values, so this check is not evaluated`;
const undecidedDetail = 'the check could not be decided';
const endMessages = {
  cancelled: 'the request was stopped before this check settled',
  blocked: 'the request was not sent',
} as const;
const limitReasons: ReadonlySet<string> = new Set([
  valueTooLargeReason,
  hostWorkReason,
  jsonPathLimitReason,
  bodyLimitReason,
  eventsLimitReason,
  bodyUnavailableReason,
  eventsUnavailableReason,
  eventUnavailableReason,
  bodyNotSentReason,
  replyUnavailableReason,
  replyCutOffReason,
  evaluationCancelledReason,
]);
const tooManyMatches = / matched more than /;

function isLimit(reason: string): boolean {
  return limitReasons.has(reason) || tooManyMatches.test(reason);
}

function definition(name: string, text: string): CaptureDefinition | string {
  const parsed = parseExpression(text, 'expect');
  return parsed.ok
    ? { name, secret: false, provenance: false, expression: parsed.expr, text }
    : parsed.error.message;
}

function internal(term: Term): [Role, CaptureDefinition | string][] {
  switch (term.kind) {
    case 'value':
      return [['value', term.problem ?? definition(term.text, `(${term.text}) | json`)]];
    case 'count':
      return [['count', definition(`#count ${term.text}`, term.text)]];
    case 'before':
      return [
        ['before-second', definition(`#before-b ${term.text}`, `count(${term.secondText})`)],
        ['before-first', definition(`#before-a ${term.text}`, `count(${term.firstText})`)],
      ];
  }
}

function readsHead(program: CheckProgram): boolean {
  return program.terms.some((term) => term.kind === 'value' && readsHeadersOrCookies(term.expr));
}

function fullJson(value: Value): string {
  const text = compactJson(value, maxInsertedLength);
  return text.ok ? text.text : '…';
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class CheckTracker {
  readonly backpressure: EventBackpressure;
  private readonly tracker: CaptureTracker;
  private readonly checked: Checked[];
  private readonly uses = new Map<string, Use[]>();
  private readonly dirty = new Map<Checked, number | undefined>();
  private ended = false;
  private judging = false;
  private headers: ResponseHead['headers'] = [];

  constructor(
    private readonly run: {
      id: number;
      label: string;
      wallStartedAt: number;
      sensitiveValues: readonly string[];
    },
    checks: readonly CheckDefinition[],
    private readonly onResult: (index: number, result: CheckResult) => void,
    workerFile: string,
    budget: TaskBudget = hostBudget,
    private readonly secrets: () => readonly string[] = () => [],
  ) {
    const definitions: CaptureDefinition[] = [];
    this.checked = checks.map((definitionOf) => ({
      definition: definitionOf,
      readsHead: readsHead(definitionOf.program),
      states: new Map(),
      sides: new Map(),
      memo: new Map(),
      overflow: false,
      settled: false,
    }));
    for (const check of this.checked) {
      const wanted = check.definition.program.terms.flatMap((term) =>
        internal(term).map(([role, made]) => ({ term, role, made })),
      );
      const added = new Set(
        wanted.flatMap(({ made }) =>
          typeof made !== 'string' && !this.uses.has(made.name) ? [made.name] : [],
        ),
      );
      if (definitions.length + added.size > maxCheckValues) {
        check.overflow = true;
        continue;
      }
      for (const { term, role, made } of wanted) {
        if (term.kind === 'before') {
          check.sides.set(term.id, {
            first: undefined,
            second: undefined,
            firstFinal: false,
            secondFinal: false,
          });
        }
        if (typeof made === 'string') {
          check.states.set(term.id, { kind: 'error', reason: made });
          continue;
        }
        const uses = this.uses.get(made.name);
        if (uses === undefined) {
          this.uses.set(made.name, [{ check, term: term.id, role }]);
          definitions.push(made);
        } else {
          uses.push({ check, term: term.id, role });
        }
      }
    }
    this.tracker = new CaptureTracker(
      run,
      definitions,
      (name, result) => {
        this.result(name, result);
      },
      workerFile,
      budget,
      (name, index, count) => {
        this.progress(name, index, count);
      },
    );
    this.backpressure = this.tracker;
  }

  get retained(): number {
    let total = 0;
    for (const check of this.checked) {
      total += check.states.size + check.sides.size + check.memo.size;
    }
    return total;
  }

  head(head: ResponseHead, access: RunAccess): void {
    this.headers = head.headers;
    this.tracker.head(head, access);
    for (const check of this.checked) {
      if (check.overflow) {
        this.report(check, { state: 'failed', detail: overflowDetail }, undefined);
        continue;
      }
      for (const term of check.definition.program.terms) {
        if (term.kind === 'count' && !check.states.has(term.id)) {
          check.states.set(term.id, { kind: 'count', count: 0, index: undefined, final: false });
        }
      }
      this.touch(check, undefined);
    }
    this.judgeNow();
  }

  event(event: StreamEvent): void {
    this.tracker.event(event);
  }

  async end(end: RunEnd): Promise<void> {
    this.ended = true;
    if (end.kind !== 'completed') {
      const detail =
        end.kind === 'failed' ? `the request failed: ${end.message}` : endMessages[end.kind];
      for (const check of this.checked) {
        this.report(check, { state: 'failed', detail }, undefined);
      }
    }
    await this.tracker.end(end);
    for (const check of this.checked) {
      this.touch(check, undefined);
    }
    while (this.dirty.size > 0) {
      this.judgeSome(performance.now() + captureSliceMs);
      await nextTask();
    }
    for (const check of this.checked) {
      this.report(check, { state: 'failed', detail: undecidedDetail }, undefined);
    }
  }

  private result(name: string, result: CaptureResult): void {
    if (result.state === 'pending') {
      return;
    }
    const uses = this.uses.get(name) ?? [];
    const settledAt =
      this.ended || result.state !== 'resolved' ? undefined : result.provenance.event;
    const state = this.stateOf(uses[0]?.role ?? 'value', result, uses);
    for (const use of uses) {
      if (use.check.settled) {
        continue;
      }
      if (use.role === 'value' || use.role === 'count') {
        const previous = use.check.states.get(use.term);
        const index = previous?.kind === 'count' ? previous.index : undefined;
        use.check.states.set(use.term, state.kind === 'count' ? { ...state, index } : state);
      } else if (state.kind === 'error') {
        use.check.states.set(use.term, state);
      } else {
        const sides = use.check.sides.get(use.term);
        if (sides !== undefined) {
          if (use.role === 'before-first') {
            sides.firstFinal = true;
          } else {
            sides.secondFinal = true;
          }
          this.setBefore(use.check, use.term, sides);
        }
      }
      this.touch(use.check, settledAt);
    }
    this.judgeNow();
  }

  private progress(name: string, index: number, count: number): void {
    for (const use of this.uses.get(name) ?? []) {
      if (use.check.settled) {
        continue;
      }
      if (use.role === 'count') {
        use.check.states.set(use.term, { kind: 'count', count, index, final: false });
      } else if (use.role !== 'value' && count === 1) {
        const sides = use.check.sides.get(use.term);
        if (sides === undefined) {
          continue;
        }
        if (use.role === 'before-first') {
          sides.first = index;
        } else {
          sides.second = index;
        }
        this.setBefore(use.check, use.term, sides);
      } else {
        continue;
      }
      this.touch(use.check, this.ended ? undefined : index);
    }
    this.judgeNow();
  }

  private stateOf(
    role: Role,
    result: Exclude<CaptureResult, { state: 'pending' }>,
    uses: readonly Use[],
  ): TermState {
    if (result.state === 'failed') {
      return role === 'value' && !isLimit(result.reason)
        ? { kind: 'missing', reason: result.reason }
        : { kind: 'error', reason: result.reason };
    }
    const parsed = parseJson(result.text);
    if (!parsed.ok) {
      return { kind: 'error', reason: parsed.message };
    }
    if (role === 'value') {
      const readsHeaders = uses.some(({ check }) => check.readsHead);
      return {
        kind: 'value',
        value: parsed.value,
        preview: cutText(this.mask(result.text, readsHeaders)),
      };
    }
    return typeof parsed.value === 'number'
      ? { kind: 'count', count: parsed.value, index: undefined, final: true }
      : { kind: 'error', reason: result.text };
  }

  private setBefore(check: Checked, term: number, sides: Sides): void {
    check.states.set(term, {
      kind: 'before',
      first: sides.first,
      second: sides.second,
      final: sides.firstFinal && sides.secondFinal,
    });
  }

  private touch(check: Checked, settledAt: number | undefined): void {
    if (!check.settled) {
      this.dirty.set(check, settledAt ?? this.dirty.get(check));
    }
  }

  private judgeNow(): void {
    this.judgeSome(performance.now() + captureSliceMs);
    if (this.dirty.size > 0 && !this.judging) {
      this.judging = true;
      setImmediate(() => {
        this.judging = false;
        this.judgeNow();
      });
    }
  }

  private judgeSome(deadline: number): void {
    for (const [check, settledAt] of this.dirty) {
      if (performance.now() > deadline) {
        return;
      }
      this.dirty.delete(check);
      if (check.settled) {
        continue;
      }
      const verdict = verdictOf(check.definition.program, check.states, {
        format: (value) => cutText(this.mask(fullJson(value), check.readsHead)),
        budget: new WorkBudget({ units: hostEvaluationUnits, reason: tooMuchWorkDetail }),
        memo: check.memo,
      });
      if (verdict.state !== 'pending') {
        this.report(check, verdict, settledAt);
      }
    }
  }

  private report(
    check: Checked,
    verdict: Exclude<Verdict, { state: 'pending' }>,
    settledAt: number | undefined,
  ): void {
    if (check.settled) {
      return;
    }
    check.settled = true;
    check.states.clear();
    check.sides.clear();
    check.memo.clear();
    this.dirty.delete(check);
    const result: CheckResult =
      verdict.state === 'failed'
        ? {
            state: 'failed',
            detail: cutText(this.mask(verdict.detail, check.readsHead), maxCheckDetail),
            settledAt,
          }
        : { state: 'passed', settledAt };
    this.onResult(check.definition.index, result);
  }

  private mask(text: string, readsHeaders: boolean): string {
    return maskUrl(
      maskValues(text, [
        ...this.run.sensitiveValues,
        ...sensitiveHeaderValues(this.headers, readsHeaders),
        ...this.secrets(),
      ]),
    );
  }
}
