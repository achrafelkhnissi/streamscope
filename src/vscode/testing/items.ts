import * as vscode from 'vscode';
import type { HttpFile, HttpRequest } from '../../http-file/model';
import { maskUrl } from '../../masking/masking';
import { requestLabel } from '../../response/labels';
import { requestKey } from '../../runs/run';

export const maxTestFiles = 1_000;

export interface RequestTest {
  item: vscode.TestItem;
  request: HttpRequest;
  index: number;
  key: string;
  duplicateOf: string | undefined;
}

export interface TestItemState {
  id: string;
  label: string;
  description: string | undefined;
  sortText: string | undefined;
  range: [number, number] | undefined;
  children: TestItemState[];
}

function description(request: HttpRequest): string | undefined {
  if (request.name === undefined && request.title === undefined) {
    return undefined;
  }
  const { method, url } = request.requestLine;
  return `${method.toUpperCase()} ${maskUrl(url)}`;
}

function rangeOf(request: HttpRequest): vscode.Range {
  const { start, end } = request.range;
  return new vscode.Range(start.line, start.character, end.line, end.character);
}

function stateOf(item: vscode.TestItem): TestItemState {
  const children: TestItemState[] = [];
  for (const [, child] of item.children) {
    children.push(stateOf(child));
  }
  return {
    id: item.id,
    label: item.label,
    description: item.description,
    sortText: item.sortText,
    range: item.range === undefined ? undefined : [item.range.start.line, item.range.end.line],
    children,
  };
}

export class HttpTestItems {
  private readonly tests = new Map<string, readonly RequestTest[]>();

  constructor(private readonly controller: vscode.TestController) {}

  get(uri: vscode.Uri): vscode.TestItem | undefined {
    return this.controller.items.get(uri.toString());
  }

  fileItem(uri: vscode.Uri): vscode.TestItem {
    const existing = this.get(uri);
    if (existing !== undefined) {
      return existing;
    }
    const item = this.controller.createTestItem(
      uri.toString(),
      vscode.workspace.asRelativePath(uri),
      uri,
    );
    item.canResolveChildren = true;
    this.controller.items.add(item);
    return item;
  }

  sync(uri: vscode.Uri, file: HttpFile): void {
    const fileItem = this.fileItem(uri);
    const documentUri = uri.toString();
    const seen = new Set<string>();
    const tests: RequestTest[] = [];
    for (const [index, request] of file.requests.entries()) {
      const key = requestKey(documentUri, request, index);
      const duplicate = seen.has(key);
      seen.add(key);
      const id = duplicate ? `${key}\n#${String(index)}` : key;
      const item =
        fileItem.children.get(id) ?? this.controller.createTestItem(id, requestLabel(request), uri);
      item.label = requestLabel(request);
      item.description = description(request);
      item.range = rangeOf(request);
      item.sortText = String(index).padStart(5, '0');
      tests.push({
        item,
        request,
        index,
        key,
        duplicateOf: duplicate ? (request.name ?? key) : undefined,
      });
    }
    fileItem.children.replace(tests.map(({ item }) => item));
    fileItem.canResolveChildren = false;
    this.tests.set(documentUri, tests);
  }

  remove(uri: vscode.Uri): void {
    this.controller.items.delete(uri.toString());
    this.tests.delete(uri.toString());
  }

  isResolved(uri: vscode.Uri): boolean {
    return this.tests.has(uri.toString());
  }

  requestsOf(fileItem: vscode.TestItem): readonly RequestTest[] {
    return this.tests.get(fileItem.id) ?? [];
  }

  files(): vscode.TestItem[] {
    const files: vscode.TestItem[] = [];
    for (const [, item] of this.controller.items) {
      files.push(item);
    }
    return files;
  }

  describe(uri: vscode.Uri | undefined): TestItemState[] {
    if (uri === undefined) {
      return this.files().map(stateOf);
    }
    const item = this.get(uri);
    return item === undefined ? [] : [stateOf(item)];
  }
}
