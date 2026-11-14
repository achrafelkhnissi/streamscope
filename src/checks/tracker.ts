import { hostBudget, type TaskBudget } from '../capture/task-budget';
import {
  CaptureTracker,
  readsHeadersOrCookies,
  type CaptureDefinition,
  type CaptureResult,
} from '../capture/tracker';
import type { StreamEvent } from '../events/model';
import type { EventBackpressure } from '../events/session';
import { parseExpression } from '../expressions/parse';
import { maskValues, sensitiveHeaderValues } from '../masking/masking';
import type { RunAccess, RunEnd } from '../runs/observer';
import { parseJson } from '../streaming/json';
import type { ResponseHead } from '../transport/model';
import type { CheckProgram, Term } from './compile';
import { verdictOf, type TermState, type Verdict } from './verdict';

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
  settled: boolean;
}

const endMessages = {
  cancelled: 'the request was stopped before this check settled',
  blocked: 'the request was not sent',
} as const;

function definition(name: string, text: string): CaptureDefinition | string {
  const parsed = parseExpression(text, 'expect');
  return parsed.ok
    ? { name, secret: false, provenance: false, expression: parsed.expr, text }
    : parsed.error.message;
}

function internal(term: Term): [Role, CaptureDefinition | string][] {
  switch (term.kind) {
    case 'value':
      return [['value', definition(term.text, `(${term.text}) | json`)]];
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

export class CheckTracker {
  readonly backpressure: EventBackpressure;
  private readonly tracker: CaptureTracker;
  private readonly checked: Checked[];
  private readonly uses = new Map<string, Use[]>();
  private ended = false;
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
  ) {
    const definitions: CaptureDefinition[] = [];
    this.checked = checks.map((definition) => ({
      definition,
      readsHead: readsHead(definition.program),
      states: new Map(),
      sides: new Map(),
      settled: false,
    }));
    for (const check of this.checked) {
      for (const term of check.definition.program.terms) {
        if (term.kind === 'before') {
          check.sides.set(term.id, {
            first: undefined,
            second: undefined,
            firstFinal: false,
            secondFinal: false,
          });
        }
        for (const [role, captureDefinition] of internal(term)) {
          if (typeof captureDefinition === 'string') {
            check.states.set(term.id, { kind: 'missing', reason: captureDefinition });
            continue;
          }
          const uses = this.uses.get(captureDefinition.name);
          if (uses === undefined) {
            this.uses.set(captureDefinition.name, [{ check, term: term.id, role }]);
            definitions.push(captureDefinition);
          } else {
            uses.push({ check, term: term.id, role });
          }
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

  head(head: ResponseHead, access: RunAccess): void {
    this.headers = head.headers;
    this.tracker.head(head, access);
    for (const check of this.checked) {
      if (!check.settled) {
        this.judge(check, undefined);
      }
    }
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
  }

  private result(name: string, result: CaptureResult): void {
    const settledAt =
      this.ended || result.state !== 'resolved' ? undefined : result.provenance.event;
    for (const use of this.uses.get(name) ?? []) {
      if (use.check.settled || result.state === 'pending') {
        continue;
      }
      if (use.role === 'value' || use.role === 'count') {
        use.check.states.set(use.term, this.stateOf(use.role, result));
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
      this.judge(use.check, settledAt);
    }
  }

  private progress(name: string, index: number, count: number): void {
    for (const use of this.uses.get(name) ?? []) {
      if (use.check.settled) {
        continue;
      }
      if (use.role === 'count') {
        use.check.states.set(use.term, { kind: 'count', count, final: false });
      } else if (use.role !== 'value' && count === 1) {
        const sides = use.check.sides.get(use.term);
        if (sides !== undefined) {
          if (use.role === 'before-first') {
            sides.first = index;
          } else {
            sides.second = index;
          }
          this.setBefore(use.check, use.term, sides);
        }
      } else {
        continue;
      }
      this.judge(use.check, this.ended ? undefined : index);
    }
  }

  private stateOf(
    role: 'value' | 'count',
    result: Exclude<CaptureResult, { state: 'pending' }>,
  ): TermState {
    if (result.state === 'failed') {
      return { kind: 'missing', reason: result.reason };
    }
    const parsed = parseJson(result.text);
    if (!parsed.ok) {
      return { kind: 'missing', reason: parsed.message };
    }
    return role === 'count' && typeof parsed.value === 'number'
      ? { kind: 'count', count: parsed.value, final: true }
      : { kind: 'value', value: parsed.value };
  }

  private setBefore(check: Checked, term: number, sides: Sides): void {
    check.states.set(term, {
      kind: 'before',
      first: sides.first,
      second: sides.second,
      final: sides.firstFinal && sides.secondFinal,
    });
  }

  private judge(check: Checked, settledAt: number | undefined): void {
    const verdict = verdictOf(check.definition.program, check.states);
    if (verdict.state !== 'pending') {
      this.report(check, verdict, settledAt);
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
    const result: CheckResult =
      verdict.state === 'failed'
        ? { state: 'failed', detail: this.masked(check, verdict.detail), settledAt }
        : { state: 'passed', settledAt };
    this.onResult(check.definition.index, result);
  }

  private masked(check: Checked, detail: string): string {
    return maskValues(detail, [
      ...this.run.sensitiveValues,
      ...sensitiveHeaderValues(this.headers, check.readsHead),
    ]);
  }
}
