import * as vscode from 'vscode';
import { directiveKinds, type HttpFile } from '../../http-file/model';
import { scanReferences } from '../../http-file/references';
import { maskedValue } from '../../masking/masking';
import { describeReference, secretCandidates, variableCompletions } from '../../variables/inspect';
import type { VariableSources } from '../../variables/sources';
import type { EnvironmentStore } from '../environments/environment-store';
import { readDotenv } from '../requests/variables';
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
      const { catalog, privateFileIgnored } = await environments.catalogFor(document.uri);
      const values = new Map<string, string>();
      if (!restricted) {
        for (const name of secrets.names()) {
          const value = await secrets.get(name);
          if (value !== undefined) {
            values.set(name, value);
          }
        }
      }
      return {
        system: liveSystemContext,
        restricted,
        environmentName: catalog.active,
        environment: catalog.variables,
        shared: catalog.shared,
        secrets: values,
        dotenv: restricted
          ? { kind: 'restricted' }
          : await readDotenv(document.uri, catalog.active),
        processEnv: restricted ? {} : process.env,
        privateFileIgnored,
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
      markdown.appendCodeblock(
        `${reference} = ${description.sensitive ? maskedValue : description.value}`,
        'text',
      );
      markdown.appendText(description.origin);
      break;
    case 'secret':
      markdown.appendCodeblock(reference, 'text');
      markdown.appendText(
        description.stored
          ? 'Stored in secret storage.'
          : 'Not set. Streamscope asks for it when you send.',
      );
      break;
    case 'generated':
      markdown.appendCodeblock(reference, 'text');
      markdown.appendText(description.description);
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
    await secrets.set(variable.name, variable.value);
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
          if (directivePrefix.test(before)) {
            return directiveKinds.map(
              (kind) => new vscode.CompletionItem(kind, vscode.CompletionItemKind.Keyword),
            );
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
