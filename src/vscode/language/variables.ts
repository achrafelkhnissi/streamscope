import * as vscode from 'vscode';
import { directiveKinds, type HttpFile } from '../../http-file/model';
import { scanReferences } from '../../http-file/references';
import { maskedValue, maskUrl } from '../../masking/masking';
import { unescapeFileVariable } from '../../variables/resolve';
import { describeReference, secretCandidates, variableCompletions } from '../../variables/inspect';
import { emptyCaptureLookup, type VariableSources } from '../../variables/sources';
import type { EnvironmentStore } from '../environments/environment-store';
import { readDotenv, usesDotenv } from '../requests/variables';
import type { SecretStore } from '../secrets/secret-store';
import { liveSystemContext } from '../system-context';
import type { ParseCache } from './parse-cache';
import { httpSelector } from './register';

export interface LanguageVariables extends vscode.Disposable {
  readonly onDidChange: vscode.Event<void>;
  sourcesFor(document: vscode.TextDocument): Promise<VariableSources>;
}

const secretNamePattern = /^[\w.-]+$/;
const variablePrefix = /\{\{\s*([\w$.-]*)$/;
const directivePrefix = /^\s*(?:#|\/\/)\s*@([\w-]*)$/;

export function createLanguageVariables(
  context: vscode.ExtensionContext,
  environments: EnvironmentStore,
  secrets: SecretStore,
): LanguageVariables {
  const changed = new vscode.EventEmitter<void>();
  const subscriptions = [
    environments.onDidChange(() => {
      changed.fire();
    }),
    context.secrets.onDidChange(() => {
      changed.fire();
    }),
  ];
  return {
    onDidChange: changed.event,
    sourcesFor: async (document) => {
      const restricted = !vscode.workspace.isTrusted;
      const catalog = await environments.catalogFor(document.uri);
      return {
        system: liveSystemContext,
        restricted,
        environmentName: catalog.active,
        environment: catalog.variables,
        shared: catalog.shared,
        secrets: new Map(
          restricted ? [] : secrets.names().map((name): [string, string] => [name, maskedValue]),
        ),
        dotenv: restricted
          ? { kind: 'restricted' }
          : usesDotenv(document.getText(), catalog)
            ? await readDotenv(document.uri, catalog.active)
            : { kind: 'missing' },
        processEnv: restricted ? {} : process.env,
        captures: emptyCaptureLookup,
      };
    },
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      changed.dispose();
    },
  };
}

function hover(
  file: HttpFile,
  expression: string,
  sources: VariableSources,
): vscode.MarkdownString {
  const description = describeReference(file, expression, sources);
  const markdown = new vscode.MarkdownString();
  const reference = `{{${expression}}}`;
  switch (description.kind) {
    case 'value':
      markdown.appendText(
        `${reference} = ${description.sensitive ? maskedValue : maskUrl(description.value)}`,
      );
      markdown.appendMarkdown('\n\n');
      markdown.appendText(description.origin);
      break;
    case 'secret':
      markdown.appendText(`${reference}: `);
      markdown.appendText(
        description.stored
          ? 'Stored in secret storage.'
          : 'Not set. Streamscope asks for it when you send.',
      );
      break;
    case 'generated':
      markdown.appendText(`${reference}: ${description.description}`);
      break;
    default:
      markdown.appendText(description.message);
  }
  return markdown;
}

export function registerVariableFeatures(
  context: vscode.ExtensionContext,
  cache: ParseCache,
  variables: LanguageVariables,
  secrets: SecretStore,
): void {
  const moveToSecretStorage = async (uri: vscode.Uri, line: number): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(uri);
    const variable = secretCandidates(cache.get(document)).find(
      (candidate) => candidate.range.start.line === line,
    );
    if (!variable || !secretNamePattern.test(variable.name)) {
      return;
    }
    const value = unescapeFileVariable(variable.value);
    const existing = await secrets.get(variable.name);
    if (existing !== undefined && existing !== value) {
      const choice = await vscode.window.showWarningMessage(
        `A different value is already stored for ${variable.name}. Replace it?`,
        { modal: true, detail: 'Other .http files that use this secret will send the new value.' },
        'Replace',
      );
      if (choice !== 'Replace') {
        return;
      }
    }
    await secrets.set(variable.name, value);
    const edit = new vscode.WorkspaceEdit();
    const { start, end } = variable.valueRange;
    edit.replace(
      uri,
      new vscode.Range(start.line, start.character, end.line, end.character),
      `{{$secret ${variable.name}}}`,
    );
    await vscode.workspace.applyEdit(edit);
    void vscode.window.showInformationMessage(
      `Moved ${variable.name} into secret storage for this workspace.`,
    );
  };

  context.subscriptions.push(
    variables,
    vscode.commands.registerCommand('streamscope.moveToSecretStorage', moveToSecretStorage),
    vscode.languages.registerHoverProvider(httpSelector, {
      provideHover: async (document, position) => {
        const reference = scanReferences(
          document.lineAt(position.line).text,
          position.line,
        ).references.find(
          ({ range }) =>
            range.start.character <= position.character && position.character < range.end.character,
        );
        if (!reference) {
          return undefined;
        }
        const { start, end } = reference.range;
        return new vscode.Hover(
          hover(cache.get(document), reference.expression, await variables.sourcesFor(document)),
          new vscode.Range(start.line, start.character, end.line, end.character),
        );
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      httpSelector,
      {
        provideCompletionItems: async (document, position) => {
          const before = document.lineAt(position.line).text.slice(0, position.character);
          const variable = variablePrefix.exec(before);
          if (variable) {
            const typed = variable[1] ?? '';
            const range = new vscode.Range(
              position.line,
              position.character - typed.length,
              position.line,
              position.character,
            );
            return variableCompletions(
              cache.get(document),
              await variables.sourcesFor(document),
            ).map(({ label, detail }) => {
              const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Variable);
              item.detail = detail;
              item.range = range;
              return item;
            });
          }
          const directive = directivePrefix.exec(before);
          if (directive) {
            const typed = directive[1] ?? '';
            const range = new vscode.Range(
              position.line,
              position.character - typed.length,
              position.line,
              position.character,
            );
            return directiveKinds.map((kind) => {
              const item = new vscode.CompletionItem(kind, vscode.CompletionItemKind.Keyword);
              item.range = range;
              return item;
            });
          }
          return undefined;
        },
      },
      '{',
      '@',
    ),
    vscode.languages.registerCodeActionsProvider(
      httpSelector,
      {
        provideCodeActions: (document, range) =>
          secretCandidates(cache.get(document))
            .filter(
              (variable) =>
                secretNamePattern.test(variable.name) &&
                variable.range.start.line <= range.end.line &&
                range.start.line <= variable.range.end.line,
            )
            .map((variable) => {
              const action = new vscode.CodeAction(
                'Move to secret storage',
                vscode.CodeActionKind.QuickFix,
              );
              action.command = {
                title: 'Move to secret storage',
                command: 'streamscope.moveToSecretStorage',
                arguments: [document.uri, variable.range.start.line],
              };
              return action;
            }),
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
}
