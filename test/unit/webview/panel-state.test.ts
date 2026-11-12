import { describe, expect, it } from 'vitest';
import { panelViews, type PanelStatus } from '../../../src/response/panel-protocol';
import { canOpen, canSave, effectiveView, visibleViews } from '../../../src/webview/panel-state';

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
    ...overrides,
  };
}

describe('visibleViews', () => {
  it('shows Reply only when the status says a reply was recognised', () => {
    expect(visibleViews(status({ reply: true }))).toEqual(panelViews);
    expect(visibleViews(status({ reply: false }))).toEqual([
      'events',
      'raw',
      'headers',
      'body',
      'checks',
    ]);
  });

  it('hides Reply before the first status arrives', () => {
    expect(visibleViews(undefined)).not.toContain('reply');
  });
});

describe('effectiveView', () => {
  it('keeps any view that is visible', () => {
    for (const view of panelViews) {
      expect(effectiveView(view, status({ reply: true }))).toBe(view);
    }
    expect(effectiveView('raw', status())).toBe('raw');
    expect(effectiveView('body', undefined)).toBe('body');
  });

  it('shows Events instead of Reply while there is no reply', () => {
    expect(effectiveView('reply', status({ reply: false }))).toBe('events');
    expect(effectiveView('reply', undefined)).toBe('events');
  });
});

describe('canSave', () => {
  it('allows saving once the run is past sending', () => {
    for (const state of ['receiving', 'completed', 'failed', 'cancelled', 'blocked'] as const) {
      expect(canSave(status({ state }))).toBe(true);
    }
  });

  it('allows saving a run shown read-only from history', () => {
    expect(canSave(status({ state: 'completed', running: false }))).toBe(true);
  });

  it('does not allow saving while sending or before the first status', () => {
    expect(canSave(status({ state: 'sending' }))).toBe(false);
    expect(canSave(undefined)).toBe(false);
  });
});

describe('canOpen', () => {
  it('allows opening in the editor while the run is in history', () => {
    expect(canOpen(status({ released: false }))).toBe(true);
    expect(canOpen(undefined)).toBe(true);
  });

  it('does not allow opening a run that has left history', () => {
    expect(canOpen(status({ released: true }))).toBe(false);
  });
});
