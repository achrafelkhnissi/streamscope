import { describe, expect, it } from 'vitest';
import { parseReply, workbenchTarget } from '../../benchmark/view/devtools';

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

    expect(workbenchTarget(targets, 9333)).toBe(workbench);
  });

  it('finds nothing in an empty list', () => {
    expect(workbenchTarget([], 9333)).toBeUndefined();
  });

  it('ignores a workbench whose socket is not on the port VS Code reported', () => {
    const elsewhere = [
      {
        type: 'page',
        url: 'vscode-file://vscode-app/x/workbench/workbench.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/page/1',
      },
      {
        type: 'page',
        url: 'vscode-file://vscode-app/x/workbench/workbench.html',
        webSocketDebuggerUrl: 'ws://192.0.2.1:9333/devtools/page/1',
      },
    ];

    expect(workbenchTarget(elsewhere, 9333)).toBeUndefined();
  });
});

describe('parseReply', () => {
  it('reads the id and data of a reply', () => {
    expect(parseReply('{"id":1,"result":{"data":"abc"}}')).toEqual({
      id: 1,
      data: 'abc',
      error: undefined,
    });
  });

  it('reads an error reply', () => {
    expect(parseReply('{"id":1,"error":{"message":"No target"}}')).toEqual({
      id: 1,
      data: undefined,
      error: 'No target',
    });
  });

  it('finds nothing in text that is not a JSON object', () => {
    expect(parseReply('{')).toBeUndefined();
    expect(parseReply('42')).toBeUndefined();
  });
});
