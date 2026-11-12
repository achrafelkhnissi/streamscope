import { describe, expect, it } from 'vitest';
import { workbenchTarget } from '../../benchmark/view/devtools';

describe('workbenchTarget', () => {
  it('picks the workbench page over frames, workers and other pages', () => {
    const workbench = {
      type: 'page',
      url: 'vscode-file://vscode-app/x/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/1',
    };
    const targets = [
      { type: 'iframe', url: 'vscode-webview://abc/index.html' },
      { type: 'service_worker', url: 'vscode-webview://abc/service-worker.js' },
      { type: 'page', url: 'about:blank' },
      workbench,
    ];

    expect(workbenchTarget(targets)).toBe(workbench);
  });

  it('finds nothing in an empty list', () => {
    expect(workbenchTarget([])).toBeUndefined();
  });
});
