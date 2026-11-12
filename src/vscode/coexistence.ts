import * as vscode from 'vscode';
import { competingSendLenses } from '../coexistence/send-lenses';

const shownKey = 'streamscope.coexistenceNoticeShown';

function names(displayNames: readonly string[]): string {
  const last = displayNames[displayNames.length - 1] ?? '';
  return displayNames.length > 1 ? `${displayNames.slice(0, -1).join(', ')} and ${last}` : last;
}

export async function offerToHideOtherSendLenses(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(shownKey, false)) {
    return;
  }
  const competing = competingSendLenses({
    isInstalled: (id) => vscode.extensions.getExtension(id) !== undefined,
    setting: (section, key) => vscode.workspace.getConfiguration(section).get(key),
  });
  if (competing.length === 0) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `${names(competing.map((lens) => lens.displayName))} also show a Send link above each request. Turn theirs off so only Streamscope's shows?`,
    'Turn Off',
    'Keep Both',
  );
  await context.globalState.update(shownKey, true);
  if (choice !== 'Turn Off') {
    return;
  }
  const configuration = vscode.workspace.getConfiguration();
  for (const lens of competing) {
    await configuration.update(
      lens.section,
      lens.turnOff(configuration.inspect(lens.section)?.globalValue),
      vscode.ConfigurationTarget.Global,
    );
  }
}
