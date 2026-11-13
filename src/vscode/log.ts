import type * as vscode from 'vscode';
import { maskHeaders, maskUrl, maskValues } from '../masking/masking';
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

export function logRunWaiting(log: vscode.LogOutputChannel, run: RunSnapshot): void {
  log.info(`… ${maskValues(run.label, run.sensitiveValues)} waits for ${run.waitingFor ?? ''}`);
}

export function logRunEnd(log: vscode.LogOutputChannel, run: RunSnapshot): void {
  const masked = (text: string): string => maskValues(text, run.sensitiveValues);
  const line = `← ${describeOutcome(run)}`;
  if (run.status === 'failed' || run.status === 'blocked') {
    log.warn(line);
  } else {
    log.info(line);
  }
  if (run.sent) {
    log.debug(masked(`Request headers: ${headerList(run.sent.headers)}`));
  }
  if (run.head) {
    log.debug(masked(`Response headers: ${headerList(run.head.headers)}`));
  }
}
