import * as vscode from 'vscode';
import type { CaptureRegistry } from '../../capture/registry';
import type { CheckRegistry } from '../../checks/registry';
import type { HttpFile, Range } from '../../http-file/model';
import { describeOutcome, requestLabel } from '../../response/labels';
import {
  expectsChecks,
  runFile,
  withoutControls,
  type FileRunHooks,
  type FileRunStep,
  type RequestVerdict,
} from '../../runs/file-run';
import type { RunSnapshot } from '../../runs/run';
import { isTestedUri } from '../../runs/test-file';
import type { ParseCache } from '../language/parse-cache';
import type { RequestFeatures } from '../requests/register';
import type { HttpTestItems, RequestTest } from './items';

export interface TestReport {
  kind: 'started' | 'passed' | 'failed' | 'errored' | 'skipped' | 'output';
  id: string;
  messages?: { text: string; line: number | undefined }[];
  durationMs?: number;
  output?: string;
}

export interface TestRunContext {
  controller: vscode.TestController;
  items: HttpTestItems;
  cache: ParseCache;
  requests: RequestFeatures;
  checks: CheckRegistry;
  captures: CaptureRegistry;
  record: ((report: TestReport) => void) | undefined;
}

interface TestStep extends FileRunStep {
  test: RequestTest;
  document: vscode.TextDocument;
  file: HttpFile;
}

interface PlannedFile {
  uri: vscode.Uri;
  ids: Set<string> | undefined;
}

function rangeOf({ start, end }: Range): vscode.Range {
  return new vscode.Range(start.line, start.character, end.line, end.character);
}

function crlf(text: string): string {
  return `${text.replace(/\r?\n/g, '\r\n')}\r\n`;
}

function planOf(request: vscode.TestRunRequest, items: HttpTestItems): PlannedFile[] {
  const excluded = new Set((request.exclude ?? []).map(({ id }) => id));
  const planned = new Map<string, PlannedFile>();
  for (const item of request.include ?? items.files()) {
    if (excluded.has(item.id) || item.uri === undefined || !isTestedUri(item.uri)) {
      continue;
    }
    const key = item.uri.toString();
    const entry = planned.get(key) ?? { uri: item.uri, ids: new Set<string>() };
    planned.set(key, entry);
    if (item.parent === undefined) {
      entry.ids = undefined;
    } else {
      entry.ids?.add(item.id);
    }
  }
  return [...planned.values()].sort((a, b) =>
    vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri)),
  );
}

export async function runTests(
  context: TestRunContext,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const { controller, items, cache, requests, checks, captures, record } = context;
  const excluded = new Set((request.exclude ?? []).map(({ id }) => id));
  const planned = planOf(request, items);
  const testRun = controller.createTestRun(request);
  const stop = new AbortController();
  const cancel = (): void => {
    stop.abort();
  };
  const subscriptions = [
    token.onCancellationRequested(cancel),
    testRun.token.onCancellationRequested(cancel),
  ];

  const output = (text: string, step: TestStep): void => {
    const location = new vscode.Location(
      step.document.uri,
      rangeOf(step.test.request.requestLine.range),
    );
    const shown = withoutControls(text);
    testRun.appendOutput(crlf(shown), location, step.test.item);
    record?.({ kind: 'output', id: step.test.item.id, output: shown });
  };

  const report = (
    step: TestStep,
    verdict: RequestVerdict,
    run: RunSnapshot | undefined,
    mask: (text: string) => string,
  ): void => {
    const { item, request: httpRequest, key } = step.test;
    const { uri } = step.document;
    if (run !== undefined) {
      output(mask(`${step.label}: ${describeOutcome(run, checks.summary(key))}`), step);
    }
    switch (verdict.kind) {
      case 'passed':
        testRun.passed(item, verdict.durationMs);
        record?.({ kind: 'passed', id: item.id, durationMs: verdict.durationMs });
        return;
      case 'failed': {
        const messages = verdict.checks.map(({ text, detail, line }) => {
          const message = new vscode.TestMessage(`\`${text}\` ${detail}`);
          message.location = new vscode.Location(uri, new vscode.Position(line, 0));
          return message;
        });
        testRun.failed(item, messages, verdict.durationMs);
        record?.({
          kind: 'failed',
          id: item.id,
          durationMs: verdict.durationMs,
          messages: verdict.checks.map(({ text, detail, line }) => ({
            text: `\`${text}\` ${detail}`,
            line,
          })),
        });
        return;
      }
      case 'errored': {
        const range = run?.problems[0]?.range ?? httpRequest.requestLine.range;
        const message = new vscode.TestMessage(verdict.message);
        message.location = new vscode.Location(uri, rangeOf(range));
        testRun.errored(item, message, verdict.durationMs);
        record?.({
          kind: 'errored',
          id: item.id,
          durationMs: verdict.durationMs,
          messages: [{ text: verdict.message, line: range.start.line }],
        });
        return;
      }
      case 'skipped':
        testRun.skipped(item);
        record?.({ kind: 'skipped', id: item.id });
        output(`${step.label}: skipped. ${verdict.reason}`, step);
        return;
    }
  };

  const hooks: FileRunHooks<TestStep> = {
    begin: (step) => {
      testRun.started(step.test.item);
      record?.({ kind: 'started', id: step.test.item.id });
    },
    start: (step) =>
      step.test.duplicateOf === undefined
        ? requests.startForTest(step.document, step.file, step.test.request, step.test.index)
        : Promise.resolve({
            kind: 'not-started',
            message: `Another request in this file is also named ${step.test.duplicateOf}.`,
          }),
    checks: (step, runId) =>
      expectsChecks(step.test.request) ? checks.settled(step.test.key, runId) : Promise.resolve([]),
    secrets: async (_step, runId) => {
      await captures.settled(runId);
      return captures.secretsOf(runId);
    },
    report,
  };

  try {
    const batches: TestStep[][] = [];
    for (const { uri, ids } of planned) {
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch (error) {
        const fileItem = items.get(uri);
        if (fileItem !== undefined) {
          const reason = error instanceof Error ? error.message : String(error);
          const text = `Streamscope could not open ${vscode.workspace.asRelativePath(uri)}: ${reason}`;
          testRun.errored(fileItem, new vscode.TestMessage(text));
          record?.({
            kind: 'errored',
            id: fileItem.id,
            messages: [{ text, line: undefined }],
          });
        }
        continue;
      }
      const file = cache.get(document);
      items.sync(uri, file);
      const fileItem = items.get(uri);
      if (fileItem === undefined) {
        continue;
      }
      const steps = items
        .requestsOf(fileItem)
        .filter(({ item }) => (ids === undefined || ids.has(item.id)) && !excluded.has(item.id))
        .map((test) => ({
          key: test.key,
          label: requestLabel(test.request),
          test,
          document,
          file,
        }));
      for (const step of steps) {
        testRun.enqueued(step.test.item);
      }
      batches.push(steps);
    }
    for (const steps of batches) {
      if (stop.signal.aborted) {
        break;
      }
      await runFile(steps, hooks, stop.signal);
    }
  } finally {
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
    testRun.end();
  }
}
