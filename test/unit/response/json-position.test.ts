import { describe, expect, it } from 'vitest';
import type { JsonValue, StreamEvent } from '../../../src/events/model';
import { StreamSession } from '../../../src/events/session';
import { formatBody } from '../../../src/response/format-body';
import {
  JsonPositionScanner,
  jsonPathAt,
  type PathSegment,
  type PositionResult,
} from '../../../src/response/json-position';
import { eventText } from '../../../src/response/panel-content';
import { parseJson } from '../../../src/streaming/json';
import { streamFixtures } from '../../support/stream-fixtures';

const fixture = [
  '{',
  '  "type": "RUN_STARTED",',
  '  "threadId": "thread-1",',
  '  "result": {',
  '    "ids": [7, 12345678901234567890],',
  '    "ok": true',
  '  }',
  '}',
].join('\n');

const marker = '\u0001marker\u0001';
const { rawJSON } = JSON as unknown as { rawJSON: (text: string) => unknown };

function at(text: string, needle: string, from = 0, shift = 0): number {
  const found = text.indexOf(needle, from);
  if (found === -1) {
    throw new Error(`Missing ${needle}`);
  }
  return found + shift;
}

function path(...segments: PathSegment[]): PositionResult {
  return { ok: true, segments };
}

function stepped(text: string, offset: number, size: number): PositionResult {
  const scanner = new JsonPositionScanner(text, offset);
  for (;;) {
    const result = scanner.step(size);
    if (result !== undefined) {
      return result;
    }
  }
}

function isContainer(value: JsonValue): value is readonly JsonValue[] | Record<string, JsonValue> {
  return typeof value === 'object' && value !== null;
}

function allPaths(value: JsonValue, prefix: PathSegment[] = []): PathSegment[][] {
  const found: PathSegment[][] = [prefix];
  if (Array.isArray(value)) {
    value.forEach((item: JsonValue, index) => {
      found.push(...allPaths(item, [...prefix, index]));
    });
  } else if (isContainer(value)) {
    for (const [key, item] of Object.entries(value as Record<string, JsonValue>)) {
      found.push(...allPaths(item, [...prefix, key]));
    }
  }
  return found;
}

function marked(value: JsonValue, segments: readonly PathSegment[]): JsonValue {
  if (segments.length === 0) {
    return marker;
  }
  const copy = structuredClone(value) as Record<string | number, JsonValue>;
  let node: Record<string | number, JsonValue> = copy;
  for (const segment of segments.slice(0, -1)) {
    node = node[segment] as Record<string | number, JsonValue>;
  }
  node[segments.at(-1) ?? ''] = marker;
  return copy;
}

function compact(value: JsonValue): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? rawJSON(item.toString()) : item,
  );
}

function fixtureEvents(): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const { bytes, contentType } of streamFixtures) {
    const session = new StreamSession({
      contentType,
      directive: undefined,
      spill: undefined,
      now: () => 0,
      onUpdate: () => undefined,
      onText: () => undefined,
      onEvent: (event) => {
        events.push(event);
      },
    });
    session.write(bytes);
    session.end();
    session.dispose();
  }
  return events.filter((event) => event.kind === 'json');
}

describe('jsonPathAt', () => {
  it('selects the value of the key or colon under the offset', () => {
    expect(jsonPathAt(fixture, at(fixture, '"threadId"', 0, 3))).toEqual(path('threadId'));
    expect(jsonPathAt(fixture, at(fixture, ':', at(fixture, '"threadId"')))).toEqual(
      path('threadId'),
    );
  });

  it('selects a value token under the offset', () => {
    expect(jsonPathAt(fixture, at(fixture, '"thread-1"', 0, 4))).toEqual(path('threadId'));
    expect(jsonPathAt(fixture, at(fixture, '12345678901234567890', 0, 5))).toEqual(
      path('result', 'ids', 1),
    );
    expect(jsonPathAt(fixture, at(fixture, 'true', 0, 2))).toEqual(path('result', 'ok'));
    expect(jsonPathAt(fixture, at(fixture, '7'))).toEqual(path('result', 'ids', 0));
  });

  it('selects the container a bracket opens or closes', () => {
    const resultOpen = at(fixture, '{', at(fixture, '"result"'));
    expect(jsonPathAt(fixture, resultOpen)).toEqual(path('result'));
    expect(jsonPathAt(fixture, fixture.lastIndexOf('}', fixture.length - 2))).toEqual(
      path('result'),
    );
    expect(jsonPathAt(fixture, at(fixture, '['))).toEqual(path('result', 'ids'));
    expect(jsonPathAt(fixture, at(fixture, ']'))).toEqual(path('result', 'ids'));
    expect(jsonPathAt(fixture, 0)).toEqual(path());
    expect(jsonPathAt(fixture, fixture.length - 1)).toEqual(path());
  });

  it('uses the next token on the line for indentation and the previous one for a trailing comma', () => {
    expect(jsonPathAt(fixture, at(fixture, '"threadId"', 0, -2))).toEqual(path('threadId'));
    expect(jsonPathAt(fixture, at(fixture, '"thread-1",', 0, 10))).toEqual(path('threadId'));
    expect(jsonPathAt('{"a": 1,   \n "b": 2}', 9)).toEqual(path('a'));
    expect(jsonPathAt('[1, 2]', 2)).toEqual(path(0));
    expect(jsonPathAt('[1 , 2]', 2)).toEqual(path(0));
    expect(jsonPathAt('{\n\n  "a": 1\n}', 1)).toEqual(path());
    expect(jsonPathAt('{\n\n  "a": 1\n}', 2)).toEqual({ ok: false, problem: 'no-value' });
  });

  it('decodes escaped keys', () => {
    const text = '{"a\\"b": 1, "\\u00e9": 2, "x\\ud800y": 3}';
    expect(jsonPathAt(text, at(text, '1'))).toEqual(path('a"b'));
    expect(jsonPathAt(text, at(text, '2'))).toEqual(path('é'));
    expect(jsonPathAt(text, at(text, '3'))).toEqual(path('x\ud800y'));
  });

  it('answers from a cut text before the cut and refuses after it', () => {
    const cut = fixture.slice(0, at(fixture, '"thread-1"', 0, 4));
    expect(jsonPathAt(cut, at(cut, '"RUN_STARTED"', 0, 2))).toEqual(path('type'));
    expect(jsonPathAt(cut, cut.length - 1)).toEqual({ ok: false, problem: 'no-value' });
    expect(jsonPathAt(cut, cut.length)).toEqual({ ok: false, problem: 'no-value' });
    expect(jsonPathAt('[tr', 2)).toEqual({ ok: false, problem: 'no-value' });
  });

  it('refuses text that is not JSON, and offsets past the end', () => {
    expect(jsonPathAt('hello', 1)).toEqual({ ok: false, problem: 'not-json' });
    expect(jsonPathAt('{"a": tru e}', 7)).toEqual({ ok: false, problem: 'not-json' });
    expect(jsonPathAt('{"a" 1}', 5)).toEqual({ ok: false, problem: 'not-json' });
    expect(jsonPathAt('{"a": 1} x', 9)).toEqual({ ok: false, problem: 'not-json' });
    expect(jsonPathAt('{"a": 01}', 6)).toEqual({ ok: false, problem: 'not-json' });
    expect(jsonPathAt('{"\\x": 1}', 7)).toEqual({ ok: false, problem: 'not-json' });
    expect(jsonPathAt(fixture, fixture.length + 1)).toEqual({ ok: false, problem: 'no-value' });
    expect(jsonPathAt(fixture, -1)).toEqual({ ok: false, problem: 'no-value' });
    expect(jsonPathAt('   ', 1)).toEqual({ ok: false, problem: 'no-value' });
  });

  it('refuses nesting past 256 levels', () => {
    const tooDeep = `${'['.repeat(257)}1`;
    expect(jsonPathAt(tooDeep, tooDeep.length - 1)).toEqual({ ok: false, problem: 'too-deep' });
    const deepest = `${'['.repeat(256)}1`;
    expect(jsonPathAt(deepest, deepest.length - 1)).toEqual(path(...Array<number>(256).fill(0)));
  });

  it('gives the same answer in steps of any size', () => {
    const texts = [fixture, '{"a": [1, {"b": "c, d"}], "e": null}', fixture.slice(0, 60)];
    for (const text of texts) {
      for (let offset = 0; offset <= text.length; offset += 1) {
        const whole = jsonPathAt(text, offset);
        for (const size of [1, 7, 64]) {
          expect(stepped(text, offset, size), `${text} @${String(offset)}/${String(size)}`).toEqual(
            whole,
          );
        }
      }
    }
  });

  it('finds every path of an event at the start of its value in the panel text', () => {
    const events = fixtureEvents();
    expect(events.length).toBeGreaterThan(10);
    for (const event of events) {
      const { text } = eventText(event, 65_536);
      for (const segments of allPaths(event.value)) {
        const offset = eventText(
          { ...event, value: marked(event.value, segments) },
          65_536,
        ).text.indexOf(JSON.stringify(marker));
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(jsonPathAt(text, offset), `${text} ${JSON.stringify(segments)}`).toEqual(
          path(...segments),
        );
      }
    }
  });

  it('finds every path of a JSON body at the start of its value in the formatted body', () => {
    const raw =
      '{"items":[{"id":1,"name":"a"},{"id":"x-2","tags":[],"meta":{}}],"count":2,' +
      '"big":12345678901234567890,"ok":null,"nested":{"a.b":true,"":"empty","deep":[[[-1.5e3]]]}}';
    const parsed = parseJson(raw);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    const encoder = new TextEncoder();
    const body = compact(parsed.value);
    const { text, languageId } = formatBody(encoder.encode(body), 'application/json');
    expect(languageId).toBe('json');
    for (const segments of allPaths(parsed.value)) {
      const markedText = formatBody(
        encoder.encode(compact(marked(parsed.value, segments))),
        'application/json',
      ).text;
      const offset = markedText.indexOf(JSON.stringify(marker));
      expect(jsonPathAt(text, offset), JSON.stringify(segments)).toEqual(path(...segments));
    }
  });
});
