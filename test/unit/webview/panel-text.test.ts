import { describe, expect, it } from 'vitest';
import type { PanelStatus } from '../../../src/response/panel-protocol';
import { bodyNote, stateLabels, statusLine } from '../../../src/webview/panel-text';

function status(overrides: Partial<PanelStatus> = {}): PanelStatus {
  return {
    state: 'receiving',
    text: 'Running · 3 events · 1.2 s',
    running: true,
    events: 3,
    warnings: 0,
    format: undefined,
    reply: false,
    ...overrides,
  };
}

describe('stateLabels', () => {
  it('names every run state', () => {
    expect(stateLabels).toEqual({
      sending: 'Sending',
      receiving: 'Receiving',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      blocked: 'Blocked',
    });
  });
});

describe('statusLine', () => {
  it('shows the status text on its own', () => {
    expect(statusLine(status())).toBe('Running · 3 events · 1.2 s');
  });

  it('adds the detected format and the warnings', () => {
    expect(statusLine(status({ format: 'NDJSON (detected)', warnings: 2 }))).toBe(
      'Running · 3 events · 1.2 s · NDJSON (detected) · 2 warnings',
    );
    expect(statusLine(status({ warnings: 1 }))).toBe('Running · 3 events · 1.2 s · 1 warning');
  });
});

describe('bodyNote', () => {
  it('says nothing about a body shown in full or not there yet', () => {
    expect(bodyNote({ kind: 'none' })).toBe('');
    expect(bodyNote({ kind: 'text', language: 'json', text: '{}' })).toBe('');
  });

  it('points a stream to Events and Raw', () => {
    expect(bodyNote({ kind: 'stream' })).toBe(
      'This response is a stream. See Events and Raw, or save it.',
    );
  });

  it('says how much of a large body the preview shows', () => {
    const text = Array.from({ length: 200 }, (_, line) => `line ${String(line)}`).join('\n');

    expect(bodyNote({ kind: 'preview', language: 'json', text, totalBytes: 2_097_152 })).toBe(
      'Showing the first 200 lines of a 2.0 MB body.',
    );
    expect(
      bodyNote({ kind: 'preview', language: 'json', text: `${text}\n`, totalBytes: 1_572_864 }),
    ).toBe('Showing the first 200 lines of a 1.5 MB body.');
    expect(
      bodyNote({ kind: 'preview', language: 'text', text: 'one', totalBytes: 3_221_225_472 }),
    ).toBe('Showing the first 1 line of a 3.0 GB body.');
    expect(bodyNote({ kind: 'preview', language: 'text', text: 'a\nb', totalBytes: 1536 })).toBe(
      'Showing the first 2 lines of a 1.5 KB body.',
    );
    expect(bodyNote({ kind: 'preview', language: 'text', text: 'a\nb', totalBytes: 900 })).toBe(
      'Showing the first 2 lines of a 900 B body.',
    );
  });
});
