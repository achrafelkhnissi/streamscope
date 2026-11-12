import { describe, expect, it } from 'vitest';
import { competingSendLenses, type ExtensionProbe } from '../../../src/coexistence/send-lenses';

function probe(installed: string[], settings: Record<string, unknown> = {}): ExtensionProbe {
  return {
    isInstalled: (id) => installed.includes(id),
    setting: (section, key) => settings[`${section}.${key}`],
  };
}

describe('competingSendLenses', () => {
  it('finds neither when neither is installed', () => {
    expect(competingSendLenses(probe([]))).toEqual([]);
  });

  it('finds REST Client while its Send lens is on', () => {
    const [restClient, ...rest] = competingSendLenses(probe(['humao.rest-client']));

    expect(rest).toEqual([]);
    expect(restClient?.extensionId).toBe('humao.rest-client');
    expect(restClient?.displayName).toBe('REST Client');
    expect(restClient?.section).toBe('rest-client.enableSendRequestCodeLens');
    expect(restClient?.turnOff(true)).toBe(false);
  });

  it('ignores REST Client when its lens is off', () => {
    expect(
      competingSendLenses(
        probe(['humao.rest-client'], { 'rest-client.enableSendRequestCodeLens': false }),
      ),
    ).toEqual([]);
  });

  it('finds httpyac while its send lens is on', () => {
    const lenses = competingSendLenses(
      probe(['humao.rest-client', 'anweber.vscode-httpyac'], {
        'httpyac.codelens': { send: true, json: true },
      }),
    );

    expect(lenses.map((lens) => lens.displayName)).toEqual(['REST Client', 'httpyac']);
    expect(
      competingSendLenses(
        probe(['anweber.vscode-httpyac'], { 'httpyac.codelens': { send: false } }),
      ),
    ).toEqual([]);
  });

  it("turns off only httpyac's send lens and keeps its other lens settings", () => {
    const [httpyac] = competingSendLenses(probe(['anweber.vscode-httpyac']));

    expect(httpyac?.section).toBe('httpyac.codelens');
    expect(httpyac?.turnOff({ send: true, json: false, pretty: true })).toEqual({
      send: false,
      json: false,
      pretty: true,
    });
    expect(httpyac?.turnOff(undefined)).toEqual({ send: false });
  });
});
