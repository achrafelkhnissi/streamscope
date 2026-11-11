import { maskHeaders, maskUrl } from '../masking/masking';
import type { RunSnapshot } from '../runs/run';
import type { Headers, Timing } from '../transport/model';
import { formatBytes, formatDuration } from './labels';

function headerLines(headers: Headers): string[] {
  return maskHeaders(headers).map(([name, value]) => `${name}: ${value}`);
}

function timingLine(timing: Timing): string {
  const parts: [string, number | undefined][] = [
    ['DNS', timing.dnsMs],
    ['Connect', timing.connectMs],
    ['TLS', timing.tlsMs],
    ['First byte', timing.firstByteMs],
    ['Total', timing.totalMs],
  ];
  return parts
    .flatMap(([label, ms]) => (ms === undefined ? [] : [`${label} ${formatDuration(ms)}`]))
    .join(' · ');
}

function opening(run: RunSnapshot): string[] {
  if (run.head) {
    const { httpVersion, status, statusText, headers } = run.head;
    return [`HTTP/${httpVersion} ${String(status)} ${statusText}`, ...headerLines(headers)];
  }
  switch (run.status) {
    case 'failed':
      return ['### Failed', run.failure?.message ?? ''];
    case 'blocked':
      return [
        '### Not sent',
        ...run.problems.map(
          (problem) => `${problem.message} (line ${String(problem.range.start.line + 1)})`,
        ),
      ];
    case 'cancelled':
      return ['### Cancelled', `Cancelled after ${formatDuration(run.elapsedMs)}.`];
    default:
      return ['### Sending'];
  }
}

export function renderHeadersDocument(run: RunSnapshot): string {
  const sections: string[][] = [opening(run)];
  if (run.sent) {
    sections.push([
      '### Request',
      `${run.sent.method} ${maskUrl(run.sent.url)}`,
      ...headerLines(run.sent.headers),
    ]);
  }
  if (run.hops.length > 0) {
    sections.push([
      '### Redirects',
      ...run.hops.map(
        (hop) =>
          `${hop.request.method} ${maskUrl(hop.request.url)} → ${String(hop.status)} ${hop.statusText}`,
      ),
    ]);
  }
  if (run.timing) {
    sections.push([
      '### Timing',
      timingLine(run.timing),
      `Received ${formatBytes(run.body.length)} (${formatBytes(run.wireBytes)} on the wire)`,
    ]);
  }
  return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}
