import {
  CSTTranslator,
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

interface CompiledPatterns {
  whole?: CompiledPattern | null;
  partial?: CompiledPattern | null;
}

const maxPatternLength = 500;
const maxCachedPatterns = 256;
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

function syntaxProblem(query: string, codePoints: number): JsonPathProblem {
  const offset = utf16Offset(query, codePoints);
  if (offset >= query.length) {
    return { message: 'The JSONPath ends unexpectedly.', offset };
  }
  const char = String.fromCodePoint(query.codePointAt(offset) ?? 0);
  return { message: `Unexpected \`${char}\` in the JSONPath.`, offset };
}

export function checkJsonPath(query: string): JsonPathProblem | undefined {
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

export function queryJsonPath(value: Value, query: string): readonly Value[] {
  return evaluate<Value>(value, query, { functions: patternFunctions, trace: false });
}
