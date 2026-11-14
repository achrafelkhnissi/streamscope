import type * as vscode from 'vscode';
import { maskHeaders, maskUrl, maskValues } from '../masking/masking';
import { describeOutcome } from '../response/labels';
import type { RunSnapshot } from '../runs/run';
import type { Headers } from '../transport/model';

export type RunLog = Pick<vscode.LogOutputChannel, 'info' | 'warn' | 'debug'>;

const maxRecordedLines = 1_000;

export function recordingLog(log: RunLog, lines: string[]): RunLog {
  const record = (message: string): void => {
    lines.push(message);
    if (lines.length > maxRecordedLines) {
      lines.splice(0, lines.length - maxRecordedLines);
    }
  };
  return {
    info: (message) => {
      record(message);
      log.info(message);
    },
    warn: (message) => {
      record(message);
      log.warn(message);
    },
    debug: (message) => {
      record(message);
      log.debug(message);
    },
  };
}

function headerList(headers: Headers): string {
  return maskHeaders(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
}

export function logRunStart(log: RunLog, method: string, url: string): void {
  log.info(`→ ${method.toUpperCase()} ${maskUrl(url)}`);
}

export function logRunWaiting(log: RunLog, run: RunSnapshot): void {
  log.info(`… ${maskValues(run.label, run.sensitiveValues)} waits for ${run.waitingFor ?? ''}`);
}

export function logRunEnd(log: RunLog, run: RunSnapshot): void {
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
