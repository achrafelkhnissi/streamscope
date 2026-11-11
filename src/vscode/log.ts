import type * as vscode from 'vscode';
import { maskHeaders, maskUrl } from '../masking/masking';
import { describeOutcome } from '../response/labels';
import type { RunSnapshot } from '../runs/run';
import type { Headers } from '../transport/model';

function headerList(headers: Headers): string {
  return maskHeaders(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
}

export function logRunStart(log: vscode.LogOutputChannel, method: string, url: string): void {
  log.info(`→ ${method.toUpperCase()} ${maskUrl(url)}`);
}

export function logRunEnd(log: vscode.LogOutputChannel, run: RunSnapshot): void {
  const line = `← ${describeOutcome(run)}`;
  if (run.status === 'failed' || run.status === 'blocked') {
    log.warn(line);
  } else {
    log.info(line);
  }
  if (run.sent) {
    log.debug(`Request headers: ${headerList(run.sent.headers)}`);
  }
  if (run.head) {
    log.debug(`Response headers: ${headerList(run.head.headers)}`);
  }
}
