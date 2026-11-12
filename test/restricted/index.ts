import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { startHttpServer } from '../support/servers';

const extensionId = 'achrafelkhnissi.streamscope';

function restrictedMessage(expression: string): string {
  return `Not sent: \`{{${expression}}}\` is not available in a restricted workspace. Trust the workspace to use it.`;
}

async function outcomes(uri: vscode.Uri): Promise<Map<number, string>> {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return new Map(
    lenses
      .filter((lens) => lens.command?.title !== 'Send Request')
      .map((lens) => [lens.range.start.line, lens.command?.title ?? '']),
  );
}

async function hoverText(uri: vscode.Uri, position: vscode.Position): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    uri,
    position,
  );
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (content instanceof vscode.MarkdownString ? content.value : ''))
    .join('\n')
    .replace(/&nbsp;/g, ' ');
}

async function blocksEverythingRestricted(folder: string): Promise<void> {
  const server = await startHttpServer((_request, response) => {
    response.end('should not be reached');
  });
  try {
    const lines = [
      `GET ${server.url}/secret`,
      'X-Token: {{$secret apiToken}}',
      '',
      '###',
      `GET ${server.url}/{{$dotenv API_KEY}}`,
      '',
      '###',
      `GET ${server.url}/{{$processEnv HOME}}`,
      '',
      '###',
      `GET ${server.url}/{{privateOnly}}`,
      '',
      '###',
      `POST ${server.url}/upload`,
      '',
      '< ./payload.json',
    ];
    const file = path.join(folder, 'requests.http');
    writeFileSync(file, lines.join('\n'));
    const uri = vscode.Uri.file(file);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    const requestLines = [0, 4, 7, 10, 13];
    for (const line of requestLines) {
      await vscode.commands.executeCommand('streamscope.sendRequest', uri, line);
    }

    const titles = await outcomes(uri);
    assert.equal(titles.get(0), restrictedMessage('$secret apiToken'));
    assert.equal(titles.get(4), restrictedMessage('$dotenv API_KEY'));
    assert.equal(titles.get(7), restrictedMessage('$processEnv HOME'));
    assert.equal(
      titles.get(10),
      'Not sent: `{{privateOnly}}` is not defined in this file or `$shared` (no environment selected). A restricted workspace does not read http-client.private.env.json.',
    );
    assert.equal(
      titles.get(13),
      'Not sent: Body files are not read in a restricted workspace. Trust the workspace to send them.',
    );
    assert.equal(server.sockets.opened, 0);
  } finally {
    await server.close();
  }
}

async function usesOnlyTheFolderForItsOwnFiles(folder: string): Promise<void> {
  const inside = path.join(folder, 'inside.http');
  writeFileSync(inside, 'GET https://api.example.test/{{publicOnly}}');
  const outsideFolder = mkdtempSync(path.join(tmpdir(), 'streamscope-outside-'));
  const outside = path.join(outsideFolder, 'outside.http');
  writeFileSync(outside, 'GET https://api.example.test/{{publicOnly}}');
  const position = new vscode.Position(0, 33);

  for (const file of [inside, outside]) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  }

  assert.ok((await hoverText(vscode.Uri.file(inside), position)).includes('from-public-file'));
  assert.ok((await hoverText(vscode.Uri.file(outside), position)).includes('is not defined'));
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `${extensionId} is not loaded`);
  assert.equal(vscode.workspace.isTrusted, false, 'the workspace should be restricted');
  await extension.activate();

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(folder, 'the restricted fixture folder is not open');

  assert.equal(vscode.workspace.getConfiguration('streamscope.request').get('caFile'), '');
  await blocksEverythingRestricted(folder);
  await usesOnlyTheFolderForItsOwnFiles(folder);
}
