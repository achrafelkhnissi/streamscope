export interface CompetingLens {
  extensionId: string;
  displayName: string;
  section: string;
  turnOff: (current: unknown) => unknown;
}

export interface ExtensionProbe {
  isInstalled(id: string): boolean;
  setting(section: string, key: string): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function competingSendLenses(probe: ExtensionProbe): CompetingLens[] {
  const lenses: CompetingLens[] = [];
  if (
    probe.isInstalled('humao.rest-client') &&
    probe.setting('rest-client', 'enableSendRequestCodeLens') !== false
  ) {
    lenses.push({
      extensionId: 'humao.rest-client',
      displayName: 'REST Client',
      section: 'rest-client.enableSendRequestCodeLens',
      turnOff: () => false,
    });
  }
  const httpyac = probe.setting('httpyac', 'codelens');
  if (
    probe.isInstalled('anweber.vscode-httpyac') &&
    !(isRecord(httpyac) && httpyac.send === false)
  ) {
    lenses.push({
      extensionId: 'anweber.vscode-httpyac',
      displayName: 'httpyac',
      section: 'httpyac.codelens',
      turnOff: (current) => ({ ...(isRecord(current) ? current : {}), send: false }),
    });
  }
  return lenses;
}
