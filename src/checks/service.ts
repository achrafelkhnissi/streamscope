import type { HttpRequest } from '../http-file/model';
import type { RunChecks, RunObserver } from '../runs/observer';
import { compileCheck } from './compile';
import type { CheckRegistry } from './registry';
import { CheckTracker, type CheckDefinition } from './tracker';

export interface CheckServiceOptions {
  registry: CheckRegistry;
  request: HttpRequest;
  workerFile: string;
}

export class CheckService implements RunChecks {
  private readonly definitions: readonly CheckDefinition[];
  private readonly lines: readonly { text: string; line: number }[];

  constructor(private readonly options: CheckServiceOptions) {
    const expects = options.request.expects.flatMap(({ text, range, expression }) =>
      expression === undefined ? [] : [{ text, line: range.start.line, expression }],
    );
    this.definitions = expects.map(({ text, expression }, index) => ({
      index,
      program: compileCheck(expression, text),
    }));
    this.lines = expects.map(({ text, line }) => ({ text, line }));
  }

  begin(run: { id: number; key: string; startedAt: number }): void {
    this.options.registry.begin(run, this.lines);
  }

  observer(run: {
    id: number;
    label: string;
    wallStartedAt: number;
    sensitiveValues: readonly string[];
  }): RunObserver | undefined {
    if (this.definitions.length === 0) {
      return undefined;
    }
    const { registry, workerFile } = this.options;
    const tracker = new CheckTracker(
      run,
      this.definitions,
      (index, result) => {
        registry.update(run.id, index, result);
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
      backpressure: tracker.backpressure,
    };
  }
}
