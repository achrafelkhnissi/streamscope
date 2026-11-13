export interface Span {
  start: number;
  end: number;
}

export type Value =
  null | boolean | number | bigint | string | readonly Value[] | { readonly [key: string]: Value };

export type CompareOperator =
  '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'contains' | 'startsWith' | 'matches';

export type Step =
  | { kind: 'name'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'where'; condition: Expr };

export type Filter =
  | { kind: 'default'; value: Value }
  | { kind: 'join'; separator: string }
  | { kind: 'json' }
  | { kind: 'match'; pattern: string; flags: string };

export type SourceNode =
  | { kind: 'source'; name: 'status' | 'headers' | 'cookies' | 'body' | 'text'; span: Span }
  | {
      kind: 'events';
      name: 'first' | 'last' | 'all' | 'count';
      condition: Expr | undefined;
      span: Span;
    }
  | { kind: 'nth'; position: number; condition: Expr | undefined; span: Span }
  | { kind: 'check'; name: 'exists' | 'before' | 'unique'; args: readonly Expr[]; span: Span }
  | { kind: 'jsonpath'; query: string; querySpan: Span; span: Span };

export type Expr =
  | SourceNode
  | { kind: 'literal'; value: Value; span: Span }
  | { kind: 'regex'; pattern: string; flags: string; span: Span }
  | { kind: 'list'; items: readonly Expr[]; span: Span }
  | { kind: 'field'; name: string; span: Span }
  | { kind: 'item'; span: Span }
  | { kind: 'sse'; span: Span }
  | { kind: 'access'; target: Expr; step: Step; span: Span }
  | { kind: 'filter'; target: Expr; filter: Filter; span: Span }
  | { kind: 'not'; operand: Expr; span: Span }
  | { kind: 'logical'; operator: '&&' | '||'; left: Expr; right: Expr; span: Span }
  | { kind: 'compare'; operator: CompareOperator; left: Expr; right: Expr; span: Span };
