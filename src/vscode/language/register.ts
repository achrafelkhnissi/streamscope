import * as vscode from 'vscode';
import type { HttpFile, HttpRequest, ParseDiagnostic, Range } from '../../http-file/model';
import { ParseCache } from './parse-cache';

const languageId = 'http';
const selector: vscode.DocumentSelector = { language: languageId };
const diagnosticDelayMs = 200;

function toRange(range: Range): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function requestDetail(request: HttpRequest): string {
  return `${request.requestLine.method} ${request.requestLine.url}`;
}

function documentSymbols(file: HttpFile): vscode.DocumentSymbol[] {
  const variables = file.fileVariables.map(
    (variable) =>
      new vscode.DocumentSymbol(
        variable.name,
        '',
        vscode.SymbolKind.Variable,
        toRange(variable.range),
        toRange(variable.nameRange),
      ),
  );
  const requests = file.requests.map(
    (request) =>
      new vscode.DocumentSymbol(
        request.name ?? request.title ?? requestDetail(request),
        requestDetail(request),
        vscode.SymbolKind.Method,
        toRange(request.range),
        toRange(request.requestLine.range),
      ),
  );
  return [...variables, ...requests];
}

function toDiagnostic(problem: ParseDiagnostic): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    toRange(problem.range),
    problem.message,
    problem.severity === 'error'
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.code = problem.code;
  diagnostic.source = 'Streamscope';
  return diagnostic;
}

export function registerLanguageFeatures(context: vscode.ExtensionContext): void {
  const cache = new ParseCache();
  const diagnostics = vscode.languages.createDiagnosticCollection('streamscope');
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const refresh = (document: vscode.TextDocument): void => {
    if (document.languageId === languageId) {
      diagnostics.set(document.uri, cache.get(document).diagnostics.map(toDiagnostic));
    }
  };

  const cancelPending = (uri: vscode.Uri): void => {
    const key = uri.toString();
    clearTimeout(pending.get(key));
    pending.delete(key);
  };

  const scheduleRefresh = (document: vscode.TextDocument): void => {
    if (document.languageId !== languageId) {
      return;
    }
    cancelPending(document.uri);
    pending.set(
      document.uri.toString(),
      setTimeout(() => {
        pending.delete(document.uri.toString());
        refresh(document);
      }, diagnosticDelayMs),
    );
  };

  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: (document) => documentSymbols(cache.get(document)),
    }),
    vscode.languages.registerFoldingRangeProvider(selector, {
      provideFoldingRanges: (document) =>
        cache
          .get(document)
          .requests.map(
            (request) => new vscode.FoldingRange(request.range.start.line, request.range.end.line),
          ),
    }),
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => {
      scheduleRefresh(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancelPending(document.uri);
      diagnostics.delete(document.uri);
      cache.delete(document.uri);
    }),
    {
      dispose: () => {
        for (const timer of pending.values()) {
          clearTimeout(timer);
        }
        pending.clear();
      },
    },
  );

  vscode.workspace.textDocuments.forEach(refresh);
}
