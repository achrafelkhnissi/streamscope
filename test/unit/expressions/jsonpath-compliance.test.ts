import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Value } from '../../../src/expressions/ast';
import { checkJsonPath, queryJsonPath } from '../../../src/expressions/jsonpath';

interface ComplianceCase {
  name: string;
  selector: string;
  document?: Value;
  result?: Value[];
  results?: Value[][];
  invalid_selector?: boolean;
}

const suite = JSON.parse(
  readFileSync(new URL('../../fixtures/jsonpath-cts/cts.json', import.meta.url), 'utf8'),
) as { tests: ComplianceCase[] };

function expectedResults(entry: ComplianceCase): Value[][] {
  return entry.results ?? (entry.result === undefined ? [] : [entry.result]);
}

describe('JSONPath Compliance Test Suite', () => {
  it('has the pinned number of cases', () => {
    expect(suite.tests).toHaveLength(715);
    expect(suite.tests.filter((entry) => entry.invalid_selector === true)).toHaveLength(249);
    expect(suite.tests.filter((entry) => entry.results !== undefined)).toHaveLength(9);
  });

  it('passes the JSONPath Compliance Test Suite', () => {
    const failures: string[] = [];
    let rejected = 0;
    let selected = 0;

    for (const entry of suite.tests) {
      const problem = checkJsonPath(entry.selector);
      if (entry.invalid_selector === true) {
        rejected += 1;
        if (problem === undefined) {
          failures.push(`${entry.name}: ${JSON.stringify(entry.selector)} was accepted`);
        }
        continue;
      }
      selected += 1;
      if (problem !== undefined) {
        failures.push(`${entry.name}: ${JSON.stringify(entry.selector)} was rejected`);
        continue;
      }
      const outcome = queryJsonPath(entry.document ?? null, entry.selector);
      if (!outcome.ok) {
        failures.push(`${entry.name}: ${JSON.stringify(entry.selector)} failed: ${outcome.reason}`);
      } else if (
        !expectedResults(entry).some((candidate) => isDeepStrictEqual(outcome.nodes, candidate))
      ) {
        failures.push(
          `${entry.name}: ${JSON.stringify(entry.selector)} gave ${JSON.stringify(outcome.nodes)}`,
        );
      }
    }

    expect(failures).toEqual([]);
    expect(rejected).toBe(249);
    expect(selected).toBe(466);
  });

  it('makes queryJsonPath return a reason for every invalid selector', () => {
    const accepted = suite.tests
      .filter((entry) => entry.invalid_selector === true)
      .filter((entry) => queryJsonPath(entry.document ?? null, entry.selector).ok)
      .map((entry) => entry.name);

    expect(accepted).toEqual([]);
  });
});
