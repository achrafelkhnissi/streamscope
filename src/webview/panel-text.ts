import type {
  PanelBody,
  PanelCapture,
  PanelRunState,
  PanelStatus,
} from '../response/panel-protocol';

export const stateLabels: Record<PanelRunState, string> = {
  waiting: 'Waiting',
  sending: 'Sending',
  receiving: 'Receiving',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
};

const units = ['KB', 'MB', 'GB'];

function sizeText(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? ''}`;
}

function lineCount(text: string): number {
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function statusLine(status: PanelStatus): string {
  const parts = [status.text];
  if (status.format !== undefined) {
    parts.push(status.format);
  }
  if (status.warnings > 0) {
    parts.push(plural(status.warnings, 'warning'));
  }
  return parts.join(' · ');
}

export function stateAnnouncement(
  previous: PanelRunState | undefined,
  status: PanelStatus,
): string | undefined {
  return status.state === previous
    ? undefined
    : `${stateLabels[status.state]}. ${statusLine(status)}`;
}

export function replyNote(status: PanelStatus | undefined): string {
  if (status?.replyGone === true) {
    return 'This reply is no longer available.';
  }
  return status?.replyCut === true ? 'The reply was cut off at 1,048,576 characters.' : '';
}

export function rawNote(status: PanelStatus | undefined): string {
  return status?.rawGone === true ? 'This raw data is no longer available.' : '';
}

export function historyNote(status: PanelStatus | undefined): string {
  return status?.released === true ? 'This run is no longer in history.' : '';
}

export function bodyNote(body: PanelBody): string {
  switch (body.kind) {
    case 'arriving':
      return 'The body is still arriving. Raw shows it as it arrives.';
    case 'stream':
      return 'This response is a stream. See Events and Raw, or save it.';
    case 'unavailable':
      return 'This body is no longer available.';
    case 'preview':
      return `Showing the first ${plural(lineCount(body.text), 'line')} of a ${sizeText(body.totalBytes)} body.`;
    default:
      return '';
  }
}

export function captureText(capture: PanelCapture): string {
  switch (capture.state) {
    case 'pending':
      return `${capture.name} · waiting`;
    case 'resolved':
      return `${capture.name} · ${capture.text}`;
    case 'failed':
      return `${capture.name} · ✗ ${capture.text}`;
  }
}
