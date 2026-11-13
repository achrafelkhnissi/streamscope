import { describe, expect, it } from 'vitest';
import { panelViews } from '../../../src/response/panel-protocol';
import { panelHtml } from '../../../src/response/panel-html';

const options = {
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/response-view.js',
  nonce: 'bm9uY2UtZm9yLXRoZS10ZXN0LTEyMzQ1Ng==',
  title: 'GET /items',
};

function html(overrides: Partial<typeof options> = {}): string {
  return panelHtml({ ...options, ...overrides });
}

function policy(page: string): string | undefined {
  return /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page)?.[1];
}

function stylesheet(): string {
  return /<style[^>]*>([\s\S]*)<\/style>/.exec(html())?.[1] ?? '';
}

function rule(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(stylesheet())?.[1];
}

function openingTags(page: string, name: string): string[] {
  return [...page.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

describe('panelHtml', () => {
  it('sets exactly the content security policy the decision record calls for', () => {
    expect(policy(html())).toBe(
      `default-src 'none'; script-src 'nonce-${options.nonce}'; style-src 'nonce-${options.nonce}'; img-src ${options.cspSource}; font-src ${options.cspSource}; form-action 'none'; base-uri 'none'`,
    );
  });

  it('has one policy, and it comes before any script or style', () => {
    const page = html();

    expect(page.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<style'));
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<script'));
  });

  it('never allows inline or eval scripts, or anything beyond the nonce', () => {
    const content = policy(html()) ?? '';

    expect(content).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|https?:\/\/(?!file\+)/);
    expect(content).not.toContain('connect-src');
    expect(content).not.toContain('frame-src');
  });

  it('carries the nonce on the one script and the one style', () => {
    const page = html();
    const scripts = openingTags(page, 'script');
    const styles = openingTags(page, 'style');

    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(scripts[0]).toContain(`nonce="${options.nonce}"`);
    expect(styles[0]).toContain(`nonce="${options.nonce}"`);
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page.match(/<\/style>/g)).toHaveLength(1);
  });

  it('loads the page script from the given uri and has no inline script', () => {
    const page = html();
    const [script] = openingTags(page, 'script');

    expect(script).toContain(`src="${options.scriptUri}"`);
    expect(page).toMatch(/<script [^>]*><\/script>/);
  });

  it('uses a fresh nonce for each render', () => {
    const first = html({ nonce: 'first-nonce' });
    const second = html({ nonce: 'second-nonce' });

    expect(first).toContain('nonce-first-nonce');
    expect(first).not.toContain('second-nonce');
    expect(second).toContain('nonce="second-nonce"');
    expect(second).not.toContain('first-nonce');
  });

  it('has no event handler attribute, inline style, javascript uri or form', () => {
    const page = html();

    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/\sstyle\s*=/i);
    expect(page).not.toMatch(/javascript:/i);
    expect(page).not.toMatch(/<(form|iframe|object|embed|link|base|img)\b/i);
  });

  it('escapes the title', () => {
    const page = html({ title: '</title><script>alert(1)</script>' });

    expect(page).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(openingTags(page, 'script')).toHaveLength(1);
    expect(page.match(/<title>/g)).toHaveLength(1);
  });

  it('escapes quotes and ampersands in the title, the uri and the sources', () => {
    const page = html({
      title: `a & "b" 'c'`,
      scriptUri: 'https://example.test/x.js?a=1&b="2"',
      cspSource: 'https://x.test" onload="alert(1)',
    });

    expect(page).toContain('<title>a &amp; &quot;b&quot; &#39;c&#39;</title>');
    expect(page).toContain('src="https://example.test/x.js?a=1&amp;b=&quot;2&quot;"');
    expect(policy(page)).toContain('img-src https://x.test&quot; onload=&quot;alert(1)');
  });

  it('is an html5 document with a language and a viewport', () => {
    const page = html();

    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<html lang="en">');
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('name="viewport"');
  });

  it('colours the page only with the editor theme variables', () => {
    const page = html();
    const style = /<style[^>]*>([\s\S]*)<\/style>/.exec(page)?.[1] ?? '';

    expect(style).toContain('var(--vscode-');
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(style).not.toMatch(/@import|url\(/i);
  });

  it('draws text only with text tokens, never icon, chart, gutter or error tokens', () => {
    const textTokens = new Set([
      'foreground',
      'descriptionForeground',
      'button-foreground',
      'badge-foreground',
      'panelTitle-activeForeground',
      'panelTitle-inactiveForeground',
      'list-activeSelectionForeground',
      'debugTokenExpression-name',
      'debugTokenExpression-string',
      'debugTokenExpression-number',
      'debugTokenExpression-boolean',
    ]);
    const colours = [...stylesheet().matchAll(/(?<![-\w])color:\s*([^;}]+)/g)].map((match) =>
      (match[1] ?? '').trim(),
    );

    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) {
      const token = /^var\(--vscode-([\w-]+)\)$/.exec(colour)?.[1];
      expect(colour === 'inherit' || (token !== undefined && textTokens.has(token)), colour).toBe(
        true,
      );
    }
  });

  it('pins the text token of each part of the list, the status and the raw view', () => {
    expect(rule('.label')).toContain('color: var(--vscode-foreground);');
    expect(rule('.index')).toContain('color: var(--vscode-descriptionForeground);');
    expect(rule('.time')).toContain('color: var(--vscode-descriptionForeground);');
    expect(rule('.preview')).toContain('color: var(--vscode-descriptionForeground);');
    expect(rule('#status')).toContain('color: var(--vscode-descriptionForeground);');
    expect(rule('.key, .field')).toBe(' color: var(--vscode-debugTokenExpression-name); ');
    expect(rule('.comment')).toContain('color: var(--vscode-descriptionForeground);');
  });

  it('draws the state pill with the badge pair whatever the state', () => {
    expect(rule('.pill')).toContain(
      'background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);',
    );
    expect(stylesheet()).not.toContain('.pill[data-state');
  });

  it('gives every cell of the selected row the selection foreground', () => {
    expect(rule('.row[aria-selected="true"]')).toBe(
      ' background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); ',
    );
    expect(rule('.row[aria-selected="true"] > span')).toBe(' color: inherit; ');
  });

  it('marks malformed and oversize rows with a coloured edge, not coloured text', () => {
    expect(rule('.row[data-kind="malformed"]')).toBe(
      ' box-shadow: inset 2px 0 var(--vscode-editorError-foreground); ',
    );
    expect(rule('.row[data-kind="oversize"]')).toBe(
      ' box-shadow: inset 2px 0 var(--vscode-editorWarning-foreground); ',
    );
  });

  it('outlines the selected row in high contrast, the focused one always, and a hovered one dashed', () => {
    const page = stylesheet();
    const hover = page.indexOf('body.vscode-high-contrast .row:hover');
    const selected = page.indexOf('body.vscode-high-contrast .row[aria-selected="true"]');

    expect(
      rule('body.vscode-high-contrast .row:hover, body.vscode-high-contrast-light .row:hover'),
    ).toBe(' outline: 1px dashed var(--vscode-contrastActiveBorder); outline-offset: -1px; ');
    expect(
      rule(
        'body.vscode-high-contrast .row[aria-selected="true"], body.vscode-high-contrast-light .row[aria-selected="true"]',
      ),
    ).toBe(' outline: 1px solid var(--vscode-contrastActiveBorder); outline-offset: -1px; ');
    expect(rule('.list:focus .row[aria-selected="true"]')).toBe(
      ' outline: 1px solid var(--vscode-list-focusOutline); outline-offset: -1px; ',
    );
    expect(hover).toBeGreaterThan(-1);
    expect(selected).toBeGreaterThan(hover);
  });

  it('has a tab for every view, each paired with its panel', () => {
    const page = html();

    for (const view of panelViews) {
      expect(page).toContain(`id="tab-${view}"`);
      expect(page).toContain(`aria-controls="panel-${view}"`);
      expect(page).toContain(`id="panel-${view}"`);
    }
    expect(page).toContain('role="tablist"');
    expect(page.match(/role="tab"/g)).toHaveLength(panelViews.length);
    expect(page.match(/role="tabpanel"/g)).toHaveLength(panelViews.length);
  });

  it('has the status line, the stop and open buttons and the event list', () => {
    const page = html();

    for (const id of ['state', 'status', 'stop', 'save', 'open', 'announce', 'list', 'spacer']) {
      expect(page).toContain(`id="${id}"`);
    }
    expect(page).toContain('role="listbox"');
    expect(page).toContain('role="status"');
  });

  it('has a Save Response button next to Stop, disabled until there is something to save', () => {
    const page = html();

    expect(page).toContain(
      '<button type="button" id="save" disabled>Save Response</button><button type="button" id="stop" disabled>Stop</button>',
    );
  });

  it('announces through one live region, apart from the visible status line', () => {
    const page = html();

    expect(page.match(/role="status"|aria-live=/g)).toEqual(['role="status"', 'aria-live=']);
    expect(page).toContain(
      '<div class="visually-hidden" id="announce" role="status" aria-live="polite"></div>',
    );
    expect(page).toContain('<span id="status"></span>');
  });

  it('has a hidden note at the end of the Reply tab for a reply that was cut off', () => {
    expect(html()).toContain('<pre id="reply"></pre><p id="reply-note" hidden></p>');
  });

  it('has a hidden note at the end of the Raw tab for raw data that is no longer available', () => {
    expect(html()).toContain('<pre id="raw"></pre><p id="raw-note" hidden></p>');
  });

  it('has a hidden note between the status bar and the tabs for a run that left history', () => {
    const page = html();

    expect(page).toContain('</header>\n<p id="history-note" hidden></p>\n<div class="tabs"');
  });

  it('the strip is a list labelled Captured values, hidden when empty', () => {
    const page = html();
    const strip = '<ul class="captures" id="captures" aria-label="Captured values" hidden></ul>';

    expect(page.split(strip)).toHaveLength(2);
    expect(page.indexOf(strip)).toBeGreaterThan(page.indexOf('role="tablist"'));
    expect(page.indexOf(strip)).toBeLessThan(page.indexOf('role="tabpanel"'));
    expect(rule('.captures li')).toContain('color: var(--vscode-foreground);');
    expect(rule('.captures li[data-state="pending"], .captures li[data-state="failed"]')).toBe(
      ' color: var(--vscode-descriptionForeground); ',
    );
  });

  it('says there are no checks for this request', () => {
    expect(html()).toContain('<p id="checks">No checks for this request.</p>');
  });

  it('clips the rows to the spacer so they never stretch the scroll range', () => {
    expect(html()).toContain('#spacer { position: relative; overflow: hidden; }');
  });

  it('gives an empty raw line the height of a line', () => {
    expect(html()).toContain('#raw .line { white-space: pre; min-height: 1lh; }');
  });
});
