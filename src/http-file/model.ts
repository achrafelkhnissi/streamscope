import type { Expr } from '../expressions/ast';

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export const directiveKinds = [
  'name',
  'capture',
  'expect',
  'stream',
  'timeout',
  'until',
  'insecure',
  'no-redirect',
  'no-cookie-jar',
  'note',
  'prompt',
] as const;

export type DirectiveKind = (typeof directiveKinds)[number];

export interface Directive {
  kind: DirectiveKind;
  argument: string;
  range: Range;
  argumentRange: Range;
}

export interface CaptureDirective {
  secret: boolean;
  name: string;
  nameRange: Range;
  expressionText: string;
  expressionRange: Range;
  expression: Expr | undefined;
  range: Range;
}

export interface FileVariable {
  name: string;
  value: string;
  range: Range;
  nameRange: Range;
  valueRange: Range;
}

export interface RequestLine {
  method: string;
  methodRange: Range | undefined;
  url: string;
  urlRanges: Range[];
  httpVersion: string | undefined;
  range: Range;
}

export interface Header {
  name: string;
  value: string;
  range: Range;
  nameRange: Range;
  valueRange: Range;
}

export type BodyPart =
  | { kind: 'text'; lines: string[]; range: Range }
  | {
      kind: 'file';
      path: string;
      processVariables: boolean;
      encoding: string | undefined;
      range: Range;
      pathRange: Range;
    };

export interface VariableReference {
  expression: string;
  range: Range;
}

export interface HttpRequest {
  range: Range;
  title: string | undefined;
  name: string | undefined;
  directives: Directive[];
  captures: readonly CaptureDirective[];
  requestLine: RequestLine;
  headers: Header[];
  body: BodyPart[];
  variableReferences: VariableReference[];
}

export type DiagnosticCode =
  | 'unclosed-variable'
  | 'empty-variable'
  | 'invalid-name'
  | 'duplicate-name'
  | 'invalid-capture'
  | 'invalid-expression'
  | 'duplicate-capture'
  | 'too-many-captures'
  | 'empty-expect'
  | 'invalid-stream'
  | 'invalid-timeout'
  | 'empty-until'
  | 'unexpected-argument'
  | 'misplaced-directive'
  | 'header-without-colon'
  | 'directives-without-request'
  | 'undefined-variable'
  | 'invalid-variable';

export interface ParseDiagnostic {
  code: DiagnosticCode;
  message: string;
  severity: 'error' | 'warning';
  range: Range;
}

export interface HttpFile {
  requests: HttpRequest[];
  fileVariables: FileVariable[];
  diagnostics: ParseDiagnostic[];
}
