import * as vscode from 'vscode';
import { CaptureChanges } from '../../capture/changes';
import type { CaptureRegistry } from '../../capture/registry';
import type { HttpFile, HttpRequest, ParseDiagnostic, Range } from '../../http-file/model';
import { requestKeyDocument } from '../../runs/run';
import { variableDiagnostics } from '../../variables/inspect';
import { CaptureInlayHints } from './captures';
import type { ParseCache } from './parse-cache';
import type { LanguageVariables } from './variables';

const languageId = 'http';
const supportedSchemes: ReadonlySet<string> = new Set(['file', 'untitled']);

export const httpSelector: vscode.DocumentFilter[] = [
  { language: languageId, scheme: 'file' },
  { language: languageId, scheme: 'untitled' },
];

function isSupported(document: vscode.TextDocument): boolean {
  return document.languageId === languageId && supportedSchemes.has(document.uri.scheme);
}
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

function referencesAny(file: HttpFile, names: ReadonlySet<string>): boolean {
  return file.requests.some((request) =>
    request.variableReferences.some(({ expression }) => names.has(expression)),
  );
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

export function registerLanguageFeatures(
  context: vscode.ExtensionContext,
  cache: ParseCache,
  variables: LanguageVariables,
  captures: CaptureRegistry,
): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('streamscope');
  const hints = new CaptureInlayHints(cache, captures);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const update = async (document: vscode.TextDocument): Promise<void> => {
    const version = document.version;
    const file = cache.get(document);
    diagnostics.set(document.uri, file.diagnostics.map(toDiagnostic));
    const sources = await variables.sourcesFor(document);
    if (document.isClosed || document.version !== version) {
      return;
    }
    diagnostics.set(
      document.uri,
      [...file.diagnostics, ...variableDiagnostics(file, sources)].map(toDiagnostic),
    );
  };

  const refresh = (document: vscode.TextDocument): void => {
    if (isSupported(document)) {
      void update(document);
    }
  };

  const cancelPending = (uri: vscode.Uri): void => {
    const key = uri.toString();
    clearTimeout(pending.get(key));
    pending.delete(key);
  };

  const scheduleRefresh = (document: vscode.TextDocument): void => {
    if (!isSupported(document)) {
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

  const changes = new CaptureChanges(captures, (requests, names) => {
    const changed = new Set([...requests].map(requestKeyDocument));
    let hintsChanged = false;
    for (const document of vscode.workspace.textDocuments) {
      if (!isSupported(document)) {
        continue;
      }
      hintsChanged ||= changed.has(document.uri.toString());
      if (referencesAny(cache.get(document), names)) {
        refresh(document);
      }
    }
    if (hintsChanged) {
      hints.refresh();
    }
  });

  context.subscriptions.push(
    diagnostics,
    hints,
    changes,
    vscode.languages.registerInlayHintsProvider(httpSelector, hints),
    vscode.languages.registerDocumentSymbolProvider(httpSelector, {
      provideDocumentSymbols: (document) => documentSymbols(cache.get(document)),
    }),
    vscode.languages.registerFoldingRangeProvider(httpSelector, {
      provideFoldingRanges: (document) =>
        cache
          .get(document)
          .requests.map(
            (request) => new vscode.FoldingRange(request.range.start.line, request.range.end.line),
          ),
    }),
    vscode.workspace.onDidOpenTextDocument(refresh),
    variables.onDidChange(() => {
      vscode.workspace.textDocuments.forEach(refresh);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) {
        scheduleRefresh(event.document);
      }
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
