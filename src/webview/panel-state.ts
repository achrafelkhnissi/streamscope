import { panelViews, type PanelStatus, type PanelView } from '../response/panel-protocol';

export function visibleViews(status: PanelStatus | undefined): PanelView[] {
  return panelViews.filter((view) => view !== 'reply' || status?.reply === true);
}

export function effectiveView(requested: PanelView, status: PanelStatus | undefined): PanelView {
  return visibleViews(status).includes(requested) ? requested : 'events';
}

export function canSave(status: PanelStatus | undefined): boolean {
  return status !== undefined && status.state !== 'sending';
}

export function canOpen(status: PanelStatus | undefined): boolean {
  return status?.released !== true;
}

export interface Focusable {
  focus(options: { preventScroll: boolean }): void;
}

export function setDisabledKeepingFocus(
  button: { disabled: boolean },
  disabled: boolean,
  focused: boolean,
  fallback: Focusable,
): void {
  button.disabled = disabled;
  if (disabled && focused) {
    fallback.focus({ preventScroll: true });
  }
}
