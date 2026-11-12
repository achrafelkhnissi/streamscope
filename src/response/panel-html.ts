import { panelViews, type PanelView } from './panel-protocol';

export interface PanelHtmlOptions {
  cspSource: string;
  scriptUri: string;
  nonce: string;
  title: string;
}

const viewTitles: Record<PanelView, string> = {
  events: 'Events',
  reply: 'Reply',
  raw: 'Raw',
  headers: 'Headers',
  body: 'Body',
  checks: 'Checks',
};

const panelContents: Record<PanelView, string> = {
  events:
    '<div class="list" id="list" role="listbox" tabindex="0" aria-label="Events"><div id="spacer"></div></div>',
  reply: '<pre id="reply"></pre><p id="reply-note" hidden></p>',
  raw: '<pre id="raw"></pre>',
  headers: '<pre id="headers"></pre>',
  body: '<p id="body-note"></p><pre id="body"></pre>',
  checks: '<p id="checks">No checks for this request.</p>',
};

const styles = `
body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
[hidden] { display: none !important; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.pill { padding: 1px 8px; border-radius: 10px; font-size: 11px; white-space: nowrap; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.pill[data-state="receiving"], .pill[data-state="sending"] { background: var(--vscode-charts-blue); color: var(--vscode-editor-background); }
.pill[data-state="completed"] { background: var(--vscode-charts-green); color: var(--vscode-editor-background); }
.pill[data-state="failed"], .pill[data-state="blocked"] { background: var(--vscode-charts-red); color: var(--vscode-editor-background); }
.pill[data-state="cancelled"] { background: var(--vscode-charts-orange); color: var(--vscode-editor-background); }
#status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
button { font-family: inherit; font-size: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-button-border, transparent); padding: 3px 10px; border-radius: 2px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, .list:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.tab { background: none; color: var(--vscode-panelTitle-inactiveForeground); border: none; border-bottom: 1px solid transparent; border-radius: 0; padding: 6px 10px; }
.tab:hover { background: none; color: var(--vscode-panelTitle-activeForeground); }
.tab[aria-selected="true"] { color: var(--vscode-panelTitle-activeForeground); border-bottom-color: var(--vscode-panelTitle-activeBorder); }
.panel { display: none; flex: 1; min-height: 0; overflow: auto; }
.panel.on { display: block; }
#panel-events.on { display: flex; }
.list { position: relative; flex: 1; overflow-y: auto; overflow-x: hidden; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
#spacer { position: relative; overflow: hidden; }
.row { position: absolute; left: 0; right: 0; height: 22px; line-height: 22px; padding: 0 12px; display: flex; gap: 12px; white-space: nowrap; cursor: pointer; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.index { min-width: 64px; text-align: right; color: var(--vscode-editorLineNumber-foreground); }
.time { min-width: 84px; color: var(--vscode-descriptionForeground); }
.label { min-width: 200px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-symbolIcon-classForeground); }
.preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); }
.row[data-kind="malformed"] .label { color: var(--vscode-errorForeground); }
.row[data-kind="oversize"] .label { color: var(--vscode-editorWarning-foreground); }
.row[data-kind="comment"] .label, .row[data-kind="comment"] .preview { font-style: italic; }
.detail { position: absolute; left: 24px; right: 12px; padding: 8px 12px; border-left: 2px solid var(--vscode-focusBorder); background: var(--vscode-textBlockQuote-background); }
.detail pre { margin: 0 0 8px; padding: 0; max-height: 300px; overflow: auto; word-break: break-all; }
.detail p { padding: 0 0 8px; }
pre { margin: 0; padding: 8px 12px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; word-break: break-word; }
#raw .line { white-space: pre; min-height: 1lh; }
.key, .field { color: var(--vscode-symbolIcon-propertyForeground); }
.string { color: var(--vscode-debugTokenExpression-string); }
.number { color: var(--vscode-debugTokenExpression-number); }
.literal { color: var(--vscode-debugTokenExpression-boolean); }
.comment { color: var(--vscode-descriptionForeground); font-style: italic; }
p { margin: 0; padding: 8px 12px; color: var(--vscode-descriptionForeground); }
`;

const escapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => escapes[character] ?? character);
}

function tabButton(view: PanelView): string {
  const selected = view === 'events';
  return `<button class="tab" role="tab" type="button" id="tab-${view}" aria-controls="panel-${view}" aria-selected="${String(selected)}" tabindex="${selected ? '0' : '-1'}">${viewTitles[view]}</button>`;
}

function panel(view: PanelView): string {
  const on = view === 'events' ? ' on' : '';
  return `<section class="panel${on}" id="panel-${view}" role="tabpanel" aria-labelledby="tab-${view}">${panelContents[view]}</section>`;
}

export function panelHtml(options: PanelHtmlOptions): string {
  const nonce = escapeHtml(options.nonce);
  const source = escapeHtml(options.cspSource);
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src ${source}; font-src ${source}; form-action 'none'; base-uri 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style nonce="${nonce}">${styles}</style>
</head>
<body>
<header class="bar"><span class="pill" id="state"></span><span id="status"></span><button type="button" id="open" hidden>Open in Editor</button><button type="button" id="save" disabled>Save Response</button><button type="button" id="stop" disabled>Stop</button></header>
<p id="history-note" hidden></p>
<div class="tabs" role="tablist" aria-label="Response views">${panelViews.map(tabButton).join('')}</div>
${panelViews.map(panel).join('\n')}
<div class="visually-hidden" id="announce" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>
`;
}
