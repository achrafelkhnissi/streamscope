import {
  ASTTranslator,
  CSTOptimizedTranslator,
  JSONPathEvaluateError,
  JSONPathParseError,
  evaluate,
  functions,
  parse,
  type ASTTree,
  type CSTNode,
} from '@swaggerexpert/jsonpath';
import type { Value } from './ast';
import { BoundedCache } from './bounded-cache';
import { iRegexpProblem } from './iregexp';
import { compilePattern, type CompiledPattern, type CompileResult } from './regex';

export interface JsonPathProblem {
  message: string;
  offset: number;
}

export type JsonPathResult = { ok: true; nodes: readonly Value[] } | { ok: false; reason: string };

type Container = readonly Value[] | { readonly [key: string]: Value };

interface CompiledPatterns {
  whole?: CompiledPattern | null;
  partial?: CompiledPattern | null;
}

const maxPatternLength = 500;
const maxCachedPatterns = 256;
const maxCachedChecks = 256;
const maxDepth = 1000;
const maxQueryLength = 384;
const maxParentheses = 3;
const maxBrackets = 32;
const knownFunctions = new Set(['length', 'count', 'match', 'search', 'value']);
const lengthMessage = 'the query is longer than 384 characters';
const complexMessage = 'the query is too complex to check';
const parenthesesMessage = `the query nests too deeply (more than ${String(maxParentheses)} levels of parentheses)`;
const bracketsMessage = `the query nests too deeply (more than ${String(maxBrackets)} levels of brackets)`;
const patternFlags = 'u';

const compiledPatterns = new Map<string, CompiledPatterns>();
const checkedQueries = new BoundedCache<JsonPathProblem | null>(maxCachedChecks);

function toLinearSyntax(pattern: string): string {
  let result = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === '\\') {
      result +=
        pattern.charAt(index + 1) === '-' && !inClass ? '-' : pattern.slice(index, index + 2);
      index += 1;
    } else if (char === '[' && !inClass) {
      inClass = true;
      result += char;
    } else if (char === ']' && inClass) {
      inClass = false;
      result += char;
    } else if (char === '.' && !inClass) {
      result += '[^\\n\\r]';
    } else {
      result += char;
    }
  }
  return result;
}

function compileSource(pattern: string, whole: boolean): CompileResult {
  const problem = iRegexpProblem(pattern);
  if (problem !== undefined) {
    return { ok: false, message: problem, offset: 0, length: pattern.length };
  }
  const mapped = toLinearSyntax(pattern);
  return compilePattern(whole ? `^(?:${mapped})$` : mapped, patternFlags);
}

function patternsFor(pattern: string): CompiledPatterns {
  let entry = compiledPatterns.get(pattern);
  if (entry === undefined) {
    if (compiledPatterns.size >= maxCachedPatterns) {
      const oldest = compiledPatterns.keys().next();
      if (!oldest.done) {
        compiledPatterns.delete(oldest.value);
      }
    }
    entry = {};
    compiledPatterns.set(pattern, entry);
  }
  return entry;
}

function compiled(pattern: string, whole: boolean): CompiledPattern | null {
  if (pattern.length > maxPatternLength) {
    return null;
  }
  const entry = patternsFor(pattern);
  const key = whole ? 'whole' : 'partial';
  let program = entry[key];
  if (program === undefined) {
    const result = compileSource(pattern, whole);
    program = result.ok ? result.pattern : null;
    entry[key] = program;
  }
  return program;
}

function singleValue(argument: unknown): unknown {
  if (Array.isArray(argument) && (argument as { _isNodelist?: unknown })._isNodelist === true) {
    return argument.length === 1 ? argument[0] : undefined;
  }
  return argument;
}

function testPattern(subject: unknown, pattern: unknown, whole: boolean): boolean {
  const text = singleValue(subject);
  const source = singleValue(pattern);
  if (typeof text !== 'string' || typeof source !== 'string') {
    return false;
  }
  return compiled(source, whole)?.test(text) === true;
}

const patternFunctions = {
  ...functions,
  match: (_realm: unknown, subject: unknown, pattern: unknown) =>
    testPattern(subject, pattern, true),
  search: (_realm: unknown, subject: unknown, pattern: unknown) =>
    testPattern(subject, pattern, false),
};

function utf16Offset(text: string, codePoints: number): number {
  let index = 0;
  for (let count = 0; count < codePoints && index < text.length; count += 1) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
}

function decodeStringLiteral(literal: string): string | undefined {
  if (!literal.includes('\\')) {
    return literal.slice(1, -1);
  }
  const selector = parse(`$[${literal}]`).tree?.segments[0]?.selector;
  const name = selector?.type === 'BracketedSelection' ? selector.selectors[0] : undefined;
  return name?.type === 'NameSelector' ? name.value : undefined;
}

interface FunctionCall {
  name: CSTNode;
  pattern: CSTNode | undefined;
}

function optimizedTree(translator: ASTTranslator): CSTNode {
  return CSTOptimizedTranslator.prototype.getTree.call(translator);
}

function functionCalls(root: CSTNode): FunctionCall[] {
  const found: FunctionCall[] = [];
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'function-expr') {
      const name = node.children.find((child) => child.type === 'function-name');
      const literal = node.children
        .filter((child) => child.type === 'function-argument')
        .at(1)
        ?.children.at(0)
        ?.children.at(0);
      if (name !== undefined) {
        found.push({ name, pattern: literal?.type === 'string-literal' ? literal : undefined });
      }
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        pending.push(child);
      }
    }
  }
  return found;
}

class RecordingTranslator extends ASTTranslator {
  calls: FunctionCall[] = [];

  override getTree(): ASTTree {
    this.calls = functionCalls(optimizedTree(this));
    return super.getTree();
  }
}

function unknownFunctionProblem(
  query: string,
  calls: readonly FunctionCall[],
): JsonPathProblem | undefined {
  const unknown = calls.find((call) => !knownFunctions.has(call.name.text));
  return unknown === undefined
    ? undefined
    : {
        message: `Unknown function \`${unknown.name.text}\`; the functions are length, count, match, search and value.`,
        offset: utf16Offset(query, unknown.name.start),
      };
}

function patternProblem(
  query: string,
  calls: readonly FunctionCall[],
): JsonPathProblem | undefined {
  for (const { name, pattern: literal } of calls) {
    if (literal !== undefined && (name.text === 'match' || name.text === 'search')) {
      const pattern = decodeStringLiteral(literal.text);
      const result =
        pattern === undefined ? undefined : compileSource(pattern, name.text === 'match');
      if (result?.ok === false) {
        return { message: result.message, offset: utf16Offset(query, literal.start) };
      }
    }
  }
  return undefined;
}

function limitProblem(query: string): JsonPathProblem | undefined {
  if (query.length > maxQueryLength) {
    return { message: lengthMessage, offset: maxQueryLength };
  }
  let parentheses = 0;
  let brackets = 0;
  let quote = '';
  for (let index = 0; index < query.length; index += 1) {
    const char = query.charAt(index);
    if (quote !== '') {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = '';
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      parentheses += 1;
      if (parentheses > maxParentheses) {
        return { message: parenthesesMessage, offset: index };
      }
    } else if (char === ')' && parentheses > 0) {
      parentheses -= 1;
    } else if (char === '[') {
      brackets += 1;
      if (brackets > maxBrackets) {
        return { message: bracketsMessage, offset: index };
      }
    } else if (char === ']' && brackets > 0) {
      brackets -= 1;
    }
  }
  return undefined;
}

function syntaxProblem(query: string, codePoints: number): JsonPathProblem {
  const offset = utf16Offset(query, codePoints);
  if (offset >= query.length) {
    return { message: 'The JSONPath ends unexpectedly.', offset };
  }
  const char = String.fromCodePoint(query.codePointAt(offset) ?? 0);
  return { message: `Unexpected \`${char}\` in the JSONPath.`, offset };
}

function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

function failureMessage(error: JSONPathParseError): string {
  return isStackOverflow(error.cause) ? complexMessage : (error.cause?.message ?? error.message);
}

function structureProblem(query: string, withPatterns: boolean): JsonPathProblem | undefined {
  try {
    const translator = new RecordingTranslator();
    const { result } = parse(query, { translator });
    if (!result.success) {
      return syntaxProblem(query, result.maxMatched);
    }
    return (
      unknownFunctionProblem(query, translator.calls) ??
      (withPatterns ? patternProblem(query, translator.calls) : undefined)
    );
  } catch (error) {
    if (error instanceof JSONPathParseError) {
      return { message: failureMessage(error), offset: 0 };
    }
    if (error instanceof RangeError) {
      return { message: complexMessage, offset: 0 };
    }
    throw error;
  }
}

export interface KnownCheck {
  problem: JsonPathProblem | undefined;
}

export function knownJsonPathCheck(query: string): KnownCheck | undefined {
  if (query.length > maxQueryLength) {
    return { problem: limitProblem(query) };
  }
  const cached = checkedQueries.get(query);
  return cached === undefined ? undefined : { problem: cached ?? undefined };
}

export function checkJsonPath(query: string): JsonPathProblem | undefined {
  const known = knownJsonPathCheck(query);
  if (known !== undefined) {
    return known.problem;
  }
  const problem = limitProblem(query) ?? structureProblem(query, true);
  if (problem?.message !== complexMessage) {
    checkedQueries.set(query, problem ?? null);
  }
  return problem;
}

function isContainer(value: Value): value is Container {
  return typeof value === 'object' && value !== null;
}

function isList(container: Container): container is readonly Value[] {
  return Array.isArray(container);
}

function exceedsDepth(root: Value, limit: number): boolean {
  let level = 0;
  let frontier: Container[] = isContainer(root) ? [root] : [];
  while (frontier.length > 0) {
    level += 1;
    if (level > limit) {
      return true;
    }
    const next: Container[] = [];
    for (const container of frontier) {
      for (const child of isList(container) ? container : Object.values(container)) {
        if (isContainer(child)) {
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return false;
}

export function queryJsonPath(value: Value, query: string): JsonPathResult {
  const limit = limitProblem(query);
  if (limit !== undefined) {
    return { ok: false, reason: limit.message };
  }
  if (exceedsDepth(value, maxDepth)) {
    return {
      ok: false,
      reason: 'the value is nested too deeply for jsonpath() (more than 1,000 levels)',
    };
  }
  const problem = structureProblem(query, false);
  if (problem !== undefined) {
    return { ok: false, reason: `invalid JSONPath: ${problem.message}` };
  }
  try {
    const nodes = evaluate<Value>(value, query, { functions: patternFunctions, trace: false });
    return { ok: true, nodes };
  } catch (error) {
    if (error instanceof JSONPathParseError) {
      return { ok: false, reason: `invalid JSONPath: ${failureMessage(error)}` };
    }
    if (error instanceof JSONPathEvaluateError) {
      return { ok: false, reason: `jsonpath() failed: ${error.cause?.message ?? error.message}` };
    }
    throw error;
  }
}
