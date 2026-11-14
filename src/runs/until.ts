import { hostEvaluationUnits } from '../capture/task-budget';
import type { StreamEvent } from '../events/model';
import type { Expr } from '../expressions/ast';
import { holds } from '../expressions/evaluate';
import { parseExpression } from '../expressions/parse';
import { WorkBudget } from '../expressions/work';
import type { HttpRequest } from '../http-file/model';

export type UntilOutcome = 'match' | 'no-match' | 'too-much-work';

export function untilCondition(request: HttpRequest): Expr | undefined {
  const directive = request.directives.filter(({ kind }) => kind === 'until').at(-1);
  if (directive === undefined || directive.argument === '') {
    return undefined;
  }
  const parsed = parseExpression(directive.argument, 'condition');
  return parsed.ok ? parsed.expr : undefined;
}

export class UntilWatch {
  private readonly budget = new WorkBudget({ units: hostEvaluationUnits });

  constructor(private readonly condition: Expr) {}

  test(event: StreamEvent): UntilOutcome {
    if (event.kind !== 'json' && event.kind !== 'text') {
      return 'no-match';
    }
    this.budget.restart();
    const held = holds(
      this.condition,
      { value: event.value, sse: event.sse, malformed: false },
      { budget: this.budget },
    );
    this.budget.forget();
    if (this.budget.exhausted) {
      return 'too-much-work';
    }
    return held ? 'match' : 'no-match';
  }
}
