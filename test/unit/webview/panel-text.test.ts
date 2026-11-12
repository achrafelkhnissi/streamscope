import { describe, expect, it } from 'vitest';
import type { PanelStatus } from '../../../src/response/panel-protocol';
import { maxReplyLength } from '../../../src/streaming/limits';
import {
  bodyNote,
  historyNote,
  rawNote,
  replyNote,
  stateAnnouncement,
  stateLabels,
  statusLine,
} from '../../../src/webview/panel-text';

function status(overrides: Partial<PanelStatus> = {}): PanelStatus {
  return {
    state: 'receiving',
    text: 'Running · 3 events · 1.2 s',
    running: true,
    events: 3,
    warnings: 0,
    format: undefined,
    reply: false,
    replyCut: false,
    released: false,
    rawGone: false,
    replyGone: false,
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

describe('stateAnnouncement', () => {
  it('announces the first status of a run with its status line', () => {
    expect(stateAnnouncement(undefined, status())).toBe('Receiving. Running · 3 events · 1.2 s');
  });

  it('announces a change of state with the status line at that moment', () => {
    expect(
      stateAnnouncement(
        'receiving',
        status({ state: 'completed', text: '200 OK · 3 events · 1.2 s', running: false }),
      ),
    ).toBe('Completed. 200 OK · 3 events · 1.2 s');
    expect(stateAnnouncement('sending', status({ format: 'SSE (from Content-Type)' }))).toBe(
      'Receiving. Running · 3 events · 1.2 s · SSE (from Content-Type)',
    );
  });

  it('says nothing while only the counts, time or warnings change', () => {
    expect(stateAnnouncement('receiving', status({ text: 'Running · 900 events · 30.0 s' }))).toBe(
      undefined,
    );
    expect(stateAnnouncement('receiving', status({ warnings: 4 }))).toBe(undefined);
  });
});

describe('bodyNote', () => {
  it('says nothing about a body shown in full or not there yet', () => {
    expect(bodyNote({ kind: 'none' })).toBe('');
    expect(bodyNote({ kind: 'text', language: 'json', text: '{}' })).toBe('');
  });

  it('says when the body can no longer be read', () => {
    expect(bodyNote({ kind: 'unavailable' })).toBe('This body is no longer available.');
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

describe('historyNote', () => {
  it('says when the run is no longer in history, and nothing while it is', () => {
    expect(historyNote(status({ released: true }))).toBe('This run is no longer in history.');
    expect(historyNote(status({ released: false }))).toBe('');
    expect(historyNote(undefined)).toBe('');
  });
});

describe('rawNote', () => {
  it('says when the raw data is no longer available, and nothing while it is', () => {
    expect(rawNote(status({ rawGone: true }))).toBe('This raw data is no longer available.');
    expect(rawNote(status({ rawGone: false }))).toBe('');
    expect(rawNote(undefined)).toBe('');
  });
});

describe('replyNote', () => {
  it('says where the reply was cut off, and nothing while it is whole', () => {
    expect(replyNote(status({ reply: true, replyCut: true }))).toBe(
      'The reply was cut off at 1,048,576 characters.',
    );
    expect(replyNote(status({ reply: true }))).toBe('');
    expect(replyNote(undefined)).toBe('');
  });

  it('says the reply is no longer available, before it says it was cut off', () => {
    expect(replyNote(status({ reply: true, replyGone: true }))).toBe(
      'This reply is no longer available.',
    );
    expect(replyNote(status({ reply: true, replyGone: true, replyCut: true }))).toBe(
      'This reply is no longer available.',
    );
  });

  it('names the limit the reply assembler stops at', () => {
    expect(maxReplyLength).toBe(1_048_576);
  });
});
