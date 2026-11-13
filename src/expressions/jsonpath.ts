import {
  CSTTranslator,
  JSONPathEvaluateError,
  JSONPathParseError,
  evaluate,
  functions,
  parse,
  type CSTNode,
} from '@swaggerexpert/jsonpath';
import type { Value } from './ast';
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
const maxDepth = 1000;
const maxParentheses = 8;
const nestingMessage = `the query nests too deeply (more than ${String(maxParentheses)} levels of parentheses)`;
const patternFlags = 'u';

const compiledPatterns = new Map<string, CompiledPatterns>();

function toLinearSyntax(pattern: string): string {
  let result = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === '\\') {
      result += pattern.slice(index, index + 2);
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
  const selector = parse(`$[${literal}]`).tree?.segments[0]?.selector;
  const name = selector?.type === 'BracketedSelection' ? selector.selectors[0] : undefined;
  return name?.type === 'NameSelector' ? name.value : undefined;
}

function functionCalls(node: CSTNode, found: CSTNode[] = []): CSTNode[] {
  if (node.type === 'function-expr') {
    found.push(node);
  }
  for (const child of node.children) {
    functionCalls(child, found);
  }
  return found;
}

function checkPatterns(query: string): JsonPathProblem | undefined {
  if (!query.includes('match(') && !query.includes('search(')) {
    return undefined;
  }
  const translator = new CSTTranslator();
  parse(query, { translator });
  for (const call of functionCalls(translator.getTree())) {
    const name = call.children.find((child) => child.type === 'function-name')?.text;
    if (name !== 'match' && name !== 'search') {
      continue;
    }
    const literal = call.children
      .filter((child) => child.type === 'function-argument')
      .at(1)
      ?.children.at(0)
      ?.children.at(0);
    if (literal?.type !== 'string-literal') {
      continue;
    }
    const pattern = decodeStringLiteral(literal.text);
    if (pattern === undefined) {
      continue;
    }
    const result = compileSource(pattern, name === 'match');
    if (!result.ok) {
      return { message: result.message, offset: utf16Offset(query, literal.start) };
    }
  }
  return undefined;
}

function overdeepParenthesis(query: string): number | undefined {
  let depth = 0;
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
      depth += 1;
      if (depth > maxParentheses) {
        return index;
      }
    } else if (char === ')' && depth > 0) {
      depth -= 1;
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

export function checkJsonPath(query: string): JsonPathProblem | undefined {
  const nesting = overdeepParenthesis(query);
  if (nesting !== undefined) {
    return { message: nestingMessage, offset: nesting };
  }
  try {
    const { result } = parse(query);
    if (!result.success) {
      return syntaxProblem(query, result.maxMatched);
    }
  } catch (error) {
    if (error instanceof JSONPathParseError) {
      return { message: error.cause?.message ?? error.message, offset: 0 };
    }
    throw error;
  }
  return checkPatterns(query);
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
  if (exceedsDepth(value, maxDepth)) {
    return {
      ok: false,
      reason: 'the value is nested too deeply for jsonpath() (more than 1,000 levels)',
    };
  }
  if (overdeepParenthesis(query) !== undefined) {
    return { ok: false, reason: nestingMessage };
  }
  try {
    const nodes = evaluate<Value>(value, query, { functions: patternFunctions, trace: false });
    return { ok: true, nodes };
  } catch (error) {
    if (error instanceof JSONPathParseError) {
      return {
        ok: false,
        reason: `invalid JSONPath: ${checkJsonPath(query)?.message ?? error.message}`,
      };
    }
    if (error instanceof JSONPathEvaluateError) {
      return { ok: false, reason: `jsonpath() failed: ${error.cause?.message ?? error.message}` };
    }
    throw error;
  }
}
