import type { CompareOperator, Expr, Filter, ListItem, SourceNode, Span, Step, Value } from './ast';
import {
  Lexer,
  type AtToken,
  type IdentifierToken,
  type KeywordToken,
  type NumberToken,
  type RegexToken,
  type Token,
} from './lexer';
import { checkPatternCached } from './regex';

export type ExpressionContext = 'capture' | 'expect' | 'condition';

export interface ExpressionError {
  message: string;
  span: Span;
}

export type ParseResult = { ok: true; expr: Expr } | { ok: false; error: ExpressionError };

type PlainSourceName = 'status' | 'headers' | 'cookies' | 'body' | 'text';
type EventsName = 'first' | 'last' | 'all' | 'count';
type CheckName = 'exists' | 'before' | 'unique';

type LiteralNode = ListItem | { kind: 'regex'; pattern: string; flags: string; span: Span };

const maxLength = 4096;
const maxDepth = 64;
const maxPosition = 2_147_483_647;
const plainSources: ReadonlySet<string> = new Set(['status', 'headers', 'cookies', 'body', 'text']);
const expectedLiteral = 'Expected a string, number, true, false, null, regular expression or list.';
const expectedStep = 'Expected an index, a string, `*` or `?`.';
const expectedFilter = 'Expected default, join, json or match.';
const wholeNumberIndex =
  'An index must be a whole number from -9,007,199,254,740,991 to 9,007,199,254,740,991.';
const positionRange = 'nth(…) takes a whole number from 1 to 2,147,483,647.';

class SyntaxFailure extends Error {
  readonly span: Span;

  constructor(message: string, span: Span) {
    super(message);
    this.span = span;
  }
}

function isPlainSource(name: string): name is PlainSourceName {
  return plainSources.has(name);
}

function comparisonOperator(token: Token): CompareOperator | undefined {
  if (token.kind === 'keyword') {
    switch (token.text) {
      case 'in':
      case 'contains':
      case 'startsWith':
      case 'matches':
        return token.text;
      default:
        return undefined;
    }
  }
  if (token.kind === 'punctuation') {
    switch (token.text) {
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        return token.text;
      default:
        return undefined;
    }
  }
  return undefined;
}

class Parser {
  private readonly lexer: Lexer;
  private current: Token;
  private lastEnd = 0;
  private depth = 0;
  private condition: boolean;

  constructor(
    private readonly text: string,
    private readonly context: ExpressionContext,
  ) {
    this.lexer = new Lexer(text);
    this.current = this.lexer.next();
    this.condition = context === 'condition';
  }

  parse(): Expr {
    const expr = this.or();
    if (this.current.kind !== 'end') {
      this.unexpected();
    }
    return expr;
  }

  private advance(): Token {
    const token = this.current;
    this.lastEnd = token.span.end;
    this.current = this.lexer.next();
    return token;
  }

  private fail(message: string, token: Token = this.current): never {
    if (token.kind === 'error') {
      throw new SyntaxFailure(token.message, token.span);
    }
    throw new SyntaxFailure(message, token.span);
  }

  private failAt(message: string, span: Span): never {
    throw new SyntaxFailure(message, span);
  }

  private unexpected(): never {
    const { kind, span } = this.current;
    if (kind === 'end') {
      return this.fail('Unexpected end of the expression.');
    }
    return this.fail(`Unexpected \`${this.text.slice(span.start, span.end)}\`.`);
  }

  private spanFrom(start: number): Span {
    return { start, end: this.lastEnd };
  }

  private isPunctuation(text: string): boolean {
    return this.current.kind === 'punctuation' && this.current.text === text;
  }

  private expectPunctuation(text: string): void {
    if (!this.isPunctuation(text)) {
      this.fail(`Expected "${text}".`);
    }
    this.advance();
  }

  private enter(opening: Token): void {
    this.depth += 1;
    if (this.depth > maxDepth) {
      this.fail('The expression nests too deeply.', opening);
    }
  }

  private leave(): void {
    this.depth -= 1;
  }

  private openCall(): void {
    if (!this.isPunctuation('(')) {
      this.fail('Expected "(".');
    }
    this.enter(this.advance());
  }

  private closeCall(): void {
    this.expectPunctuation(')');
    this.leave();
  }

  private conditionExpression(): Expr {
    const outer = this.condition;
    this.condition = true;
    const expr = this.or();
    this.condition = outer;
    return expr;
  }

  private or(): Expr {
    const start = this.current.span.start;
    let left = this.and();
    while (this.isPunctuation('||')) {
      this.advance();
      const right = this.and();
      left = { kind: 'logical', operator: '||', left, right, span: this.spanFrom(start) };
    }
    return left;
  }

  private and(): Expr {
    const start = this.current.span.start;
    let left = this.not();
    while (this.isPunctuation('&&')) {
      this.advance();
      const right = this.not();
      left = { kind: 'logical', operator: '&&', left, right, span: this.spanFrom(start) };
    }
    return left;
  }

  private not(): Expr {
    if (!this.isPunctuation('!')) {
      return this.comparison();
    }
    const start = this.advance().span.start;
    const operand = this.comparison();
    return { kind: 'not', operand, span: this.spanFrom(start) };
  }

  private comparison(): Expr {
    const start = this.current.span.start;
    const left = this.pipe();
    const operator = comparisonOperator(this.current);
    if (operator === undefined) {
      return left;
    }
    this.advance();
    const right = this.pipe();
    return { kind: 'compare', operator, left, right, span: this.spanFrom(start) };
  }

  private pipe(): Expr {
    const start = this.current.span.start;
    let target = this.access();
    while (this.isPunctuation('|')) {
      this.advance();
      const filter = this.filter();
      target = { kind: 'filter', target, filter, span: this.spanFrom(start) };
    }
    return target;
  }

  private filter(): Filter {
    const token = this.current;
    if (token.kind !== 'identifier' && token.kind !== 'keyword') {
      return this.fail(expectedFilter);
    }
    switch (token.text) {
      case 'json':
        this.advance();
        return { kind: 'json' };
      case 'join': {
        this.advance();
        this.openCall();
        const separator = this.current;
        if (separator.kind !== 'string') {
          this.fail('Expected a string.');
        }
        this.advance();
        this.closeCall();
        return { kind: 'join', separator: separator.value };
      }
      case 'default': {
        this.advance();
        this.openCall();
        const value = this.valueOf(this.literal() ?? this.fail(expectedLiteral));
        this.closeCall();
        return { kind: 'default', value };
      }
      case 'match': {
        this.advance();
        this.openCall();
        const regex = this.current;
        if (regex.kind !== 'regex') {
          this.fail('Expected a regular expression.');
        }
        this.checkRegex(regex);
        this.advance();
        this.closeCall();
        return { kind: 'match', pattern: regex.pattern, flags: regex.flags };
      }
      default:
        return this.fail(`Unknown filter \`${token.text}\`. ${expectedFilter}`, token);
    }
  }

  private valueOf(node: LiteralNode): Value {
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'list':
        return node.items.map((item) => this.valueOf(item));
      case 'regex':
        return this.failAt('default(…) cannot take a regular expression.', node.span);
    }
  }

  private access(): Expr {
    const start = this.current.span.start;
    let target = this.primary();
    for (;;) {
      if (this.isPunctuation('.')) {
        this.advance();
        const name = this.current;
        if (name.kind !== 'identifier' && name.kind !== 'keyword') {
          this.fail('Expected a name after ".".');
        }
        this.advance();
        target = {
          kind: 'access',
          target,
          step: { kind: 'name', name: name.text },
          span: this.spanFrom(start),
        };
      } else if (this.isPunctuation('[')) {
        this.enter(this.advance());
        const step = this.bracketStep();
        this.expectPunctuation(']');
        this.leave();
        target = { kind: 'access', target, step, span: this.spanFrom(start) };
      } else {
        return target;
      }
    }
  }

  private bracketStep(): Step {
    const token = this.current;
    switch (token.kind) {
      case 'string':
        this.advance();
        return { kind: 'name', name: token.value };
      case 'number':
        return this.indexStep(token);
      case 'punctuation':
        if (token.text === '*') {
          this.advance();
          return { kind: 'wildcard' };
        }
        if (token.text === '?') {
          this.advance();
          return { kind: 'where', condition: this.conditionExpression() };
        }
        return this.fail(expectedStep);
      default:
        return this.fail(expectedStep);
    }
  }

  private indexStep(token: NumberToken): Step {
    const { value } = token;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return this.fail(wholeNumberIndex, token);
    }
    this.advance();
    return { kind: 'index', index: value === 0 ? 0 : value };
  }

  private primary(): Expr {
    const literal = this.literal();
    if (literal !== undefined) {
      return literal;
    }
    const token = this.current;
    switch (token.kind) {
      case 'at':
        return this.at(token);
      case 'identifier':
      case 'keyword':
        return this.word(token);
      case 'punctuation':
        if (token.text === '(') {
          return this.group();
        }
        return this.unexpected();
      default:
        return this.unexpected();
    }
  }

  private group(): Expr {
    this.enter(this.advance());
    const inner = this.or();
    this.expectPunctuation(')');
    this.leave();
    return inner;
  }

  private literal(): LiteralNode | undefined {
    const token = this.current;
    if (token.kind !== 'regex') {
      return this.plainLiteral();
    }
    this.checkRegex(token);
    this.advance();
    return { kind: 'regex', pattern: token.pattern, flags: token.flags, span: token.span };
  }

  private plainLiteral(): ListItem | undefined {
    const token = this.current;
    switch (token.kind) {
      case 'string':
      case 'number':
        this.advance();
        return { kind: 'literal', value: token.value, span: token.span };
      case 'keyword':
        return this.keywordLiteral(token);
      case 'punctuation':
        return token.text === '[' ? this.list() : undefined;
      default:
        return undefined;
    }
  }

  private keywordLiteral(token: KeywordToken): ListItem | undefined {
    if (token.text === 'true' || token.text === 'false') {
      this.advance();
      return { kind: 'literal', value: token.text === 'true', span: token.span };
    }
    if (token.text === 'null') {
      this.advance();
      return { kind: 'literal', value: null, span: token.span };
    }
    return undefined;
  }

  private list(): ListItem {
    const open = this.advance();
    this.enter(open);
    const items = [this.listItem()];
    while (this.isPunctuation(',')) {
      this.advance();
      items.push(this.listItem());
    }
    this.expectPunctuation(']');
    this.leave();
    return { kind: 'list', items, span: this.spanFrom(open.span.start) };
  }

  private listItem(): ListItem {
    if (this.current.kind === 'regex') {
      return this.fail('A regular expression cannot be a list item.');
    }
    return this.plainLiteral() ?? this.fail(expectedLiteral);
  }

  private checkRegex(token: RegexToken): void {
    const result = checkPatternCached(token.pattern, token.flags);
    if (!result.ok) {
      const patternEnd = token.span.start + 1 + token.pattern.length;
      const start = Math.min(token.span.start + 1 + result.offset, patternEnd);
      this.failAt(result.message, { start, end: Math.min(start + result.length, patternEnd) });
    }
  }

  private at(token: AtToken): Expr {
    const written = this.text.slice(token.span.start, token.span.end);
    if (!this.condition) {
      this.fail(`\`${written}\` is only available inside a condition.`);
    }
    if (token.name !== '' && token.name !== 'sse') {
      this.fail(`Unknown \`${written}\`. Expected \`@\` or \`@sse\`.`);
    }
    this.advance();
    return token.name === ''
      ? { kind: 'item', span: token.span }
      : { kind: 'sse', span: token.span };
  }

  private word(token: IdentifierToken | KeywordToken): Expr {
    const name = token.text;
    if (this.condition) {
      this.advance();
      return { kind: 'field', name, span: token.span };
    }
    if (isPlainSource(name)) {
      this.advance();
      return { kind: 'source', name, span: token.span };
    }
    switch (name) {
      case 'first':
      case 'last':
      case 'all':
      case 'count':
        return this.events(token, name);
      case 'nth':
        return this.nth(token);
      case 'jsonpath':
        return this.jsonpath(token);
      case 'exists':
      case 'before':
      case 'unique':
        return this.check(token, name);
      default:
        return this.fail(
          `Unknown source \`${name}\`. Expected status, headers, cookies, body, text, first, last, nth, all, count or jsonpath.`,
          token,
        );
    }
  }

  private events(token: Token, name: EventsName): SourceNode {
    this.advance();
    this.openCall();
    const condition = this.isPunctuation(')') ? undefined : this.conditionExpression();
    this.closeCall();
    return { kind: 'events', name, condition, span: this.spanFrom(token.span.start) };
  }

  private nth(token: Token): SourceNode {
    this.advance();
    this.openCall();
    const position = this.position();
    let condition: Expr | undefined;
    if (this.isPunctuation(',')) {
      this.advance();
      condition = this.conditionExpression();
    }
    this.closeCall();
    return { kind: 'nth', position, condition, span: this.spanFrom(token.span.start) };
  }

  private position(): number {
    const token = this.current;
    if (token.kind !== 'number') {
      this.fail('Expected a whole number.');
    }
    const { value } = token;
    const whole = typeof value === 'bigint' || Number.isInteger(value);
    if (!whole || value > maxPosition) {
      this.fail(positionRange, token);
    }
    if (value < 1) {
      this.fail('nth(…) counts from 1.', token);
    }
    this.advance();
    return Number(value);
  }

  private jsonpath(token: Token): SourceNode {
    this.advance();
    this.openCall();
    const query = this.current;
    if (query.kind !== 'string') {
      this.fail('Expected a string.');
    }
    this.advance();
    this.closeCall();
    return {
      kind: 'jsonpath',
      query: query.value,
      querySpan: query.span,
      span: this.spanFrom(token.span.start),
    };
  }

  private check(token: Token, name: CheckName): SourceNode {
    this.advance();
    this.openCall();
    const args: Expr[] = [];
    if (name === 'before') {
      args.push(this.conditionExpression());
      this.expectPunctuation(',');
      args.push(this.conditionExpression());
    } else {
      args.push(this.or());
    }
    this.closeCall();
    const span = this.spanFrom(token.span.start);
    if (this.context !== 'expect') {
      this.failAt(`${name}(…) is only available in # @expect.`, span);
    }
    return { kind: 'check', name, args, span };
  }
}

export function parseExpression(text: string, context: ExpressionContext): ParseResult {
  if (text.length > maxLength) {
    return {
      ok: false,
      error: {
        message: 'An expression is at most 4,096 characters.',
        span: { start: 0, end: text.length },
      },
    };
  }
  try {
    return { ok: true, expr: new Parser(text, context).parse() };
  } catch (error) {
    if (error instanceof SyntaxFailure) {
      return { ok: false, error: { message: error.message, span: error.span } };
    }
    throw error;
  }
}

export function sourcesOf(expr: Expr): readonly SourceNode[] {
  const sources: SourceNode[] = [];
  const pending: Expr[] = [expr];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    switch (node.kind) {
      case 'source':
      case 'events':
      case 'nth':
      case 'jsonpath':
        sources.push(node);
        break;
      case 'check':
        sources.push(node);
        pending.push(...node.args.toReversed());
        break;
      case 'list':
        pending.push(...node.items.toReversed());
        break;
      case 'access':
      case 'filter':
        pending.push(node.target);
        break;
      case 'not':
        pending.push(node.operand);
        break;
      case 'logical':
      case 'compare':
        pending.push(node.right, node.left);
        break;
      case 'literal':
      case 'regex':
      case 'field':
      case 'item':
      case 'sse':
        break;
    }
  }
  return sources;
}
