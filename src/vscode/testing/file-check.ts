import * as vscode from 'vscode';
import { resolvesInside } from '../../runs/body-files';
import { testFileProblem } from '../../runs/test-file';

export async function closedFileProblem(uri: vscode.Uri): Promise<string | undefined> {
  const { type, size } = await vscode.workspace.fs.stat(uri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const outside =
    uri.scheme === 'file' &&
    folder !== undefined &&
    !(await resolvesInside(uri.fsPath, folder.uri.fsPath));
  return testFileProblem({
    symbolicLink: (type & vscode.FileType.SymbolicLink) !== 0,
    outside,
    file: (type & vscode.FileType.File) !== 0,
    size,
  });
}
