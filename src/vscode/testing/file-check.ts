import * as vscode from 'vscode';
import { testFileProblem } from '../../runs/test-file';

export async function closedFileProblem(uri: vscode.Uri): Promise<string | undefined> {
  const { type, size } = await vscode.workspace.fs.stat(uri);
  return testFileProblem({
    symbolicLink: (type & vscode.FileType.SymbolicLink) !== 0,
    file: (type & vscode.FileType.File) !== 0,
    size,
  });
}
