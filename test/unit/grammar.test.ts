import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Rule {
  name?: string;
  contentName?: string;
  match?: string;
  begin?: string;
  end?: string;
  while?: string;
  captures?: Record<string, Rule>;
  beginCaptures?: Record<string, Rule>;
  endCaptures?: Record<string, Rule>;
  patterns?: Rule[];
}

interface Grammar extends Rule {
  scopeName: string;
  repository?: Record<string, Rule>;
}

const grammar = JSON.parse(
  readFileSync(new URL('../../syntaxes/http.tmLanguage.json', import.meta.url), 'utf8'),
) as Grammar;

function allRules(rule: Rule): Rule[] {
  const nested = [
    ...(rule.patterns ?? []),
    ...Object.values(rule.captures ?? {}),
    ...Object.values(rule.beginCaptures ?? {}),
    ...Object.values(rule.endCaptures ?? {}),
  ];
  return [rule, ...nested.flatMap(allRules)];
}

const rules = [grammar, ...Object.values(grammar.repository ?? {})].flatMap(allRules);

describe('http grammar', () => {
  it('declares the Streamscope scope', () => {
    expect(grammar.scopeName).toBe('source.http.streamscope');
  });

  it('compiles every pattern', () => {
    const patterns = rules.flatMap((rule) =>
      [rule.match, rule.begin, rule.end, rule.while].filter(
        (pattern): pattern is string => pattern !== undefined,
      ),
    );

    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(() => new RegExp(pattern), pattern).not.toThrow();
    }
  });

  it('covers each line kind', () => {
    const names = new Set(rules.flatMap((rule) => [rule.name, rule.contentName]));

    for (const scope of [
      'meta.separator.http',
      'comment.line.http',
      'keyword.other.directive.http',
      'variable.other.definition.http',
      'keyword.control.method.http',
      'entity.name.tag.header.http',
      'variable.other.reference.http',
    ]) {
      expect(names, scope).toContain(scope);
    }
  });
});
