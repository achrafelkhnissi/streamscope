# M8 Click-to-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** capture any value without typing an expression. The user clicks a JSON value in an expanded event or in the Body tab, or puts the cursor on one in an event or Body document, runs **Capture This Value…**, confirms a suggested name, and a correct `# @capture` line appears on the request that produced the response.

**Architecture:**

- **One shared core** behind both entry points, as the M5 decision asks:
  1. a pure JSON position scanner turns a text and a character offset into path segments (`src/response/json-position.ts`);
  2. a pure builder turns segments, the event's discriminator and its occurrence into an expression, a suggested name and a line (`src/capture/capture-line.ts`);
  3. a pure counter finds which occurrence of its condition an event is, using the same test the capture tracker applies (`src/capture/occurrence.ts`);
  4. a pure planner joins them for one value (`src/capture/value-capture.ts`);
  5. a pure placement finds where the line goes in the `.http` document (`src/http-file/capture-placement.ts`).
- **The panel** gets a **Capture This Value…** button in the expanded event and in the Body tab. The webview records where the user's selection is and sends only the event index and a character offset. The extension rebuilds the text it showed and does everything else.
- **The editor documents** (Open in Editor for an event or the Body) get the same command from the context menu and the Command Palette, using the cursor.
- **The command** asks for the name in a native input box, then parses the document again, places the line with a `WorkspaceEdit` on the producing request only, and selects it.

**Tech Stack:** TypeScript 6.0.3, VS Code API 1.101 (commands, menus, `showInputBox`, `withProgress`, `WorkspaceEdit`), the M6 webview, Vitest, `@vscode/test-cli`. No new dependency.

**Spec:**

- **`docs/design.md`:**
  - section 2: FR-C1, FR-C6, FR-C7, FR-A4 (credential names);
  - section 3 (budgets);
  - section 9 (event model and labels);
  - section 10: capture lines, grammar, sources, semantics and limits;
  - section 13: Decision (M5);
  - section 15: masking;
  - section 19: the "Capture This Value" command.
- **`docs/roadmap.md`:** M8.
- **`docs/decisions/response-surface.md`:** Decision, Questions for the M6 plan (the JSON position scanner), and Consequences for M6 (messages from the webview are untrusted input).
- **`CLAUDE.md`:** Architecture conventions, Performance, Security requirements.

## Global Constraints

- **FR-C6, verbatim:** "Click-to-capture: in event detail and Body views, "Capture This Value…" on a JSON value writes a `# @capture` line on the producing request, with a suggested name, the event condition (`first(type == "…")` or the discriminator in use) and the path. The user can edit the name before it is written."
- **Roadmap M8 acceptance, verbatim:** "for any value in a fixture, the generated expression evaluates back to that value; the generated line is valid and placed on the right request." Tests: "round-trip unit tests (value → expression → value); integration test of the command."
- **The M5 decision, verbatim except for the one change in decision 2 below:** "The extension builds the `# @capture` expression, checks it against the capture grammar, rejects control characters, asks for the name in a native input box validated as an identifier, and inserts the line with a `WorkspaceEdit` on the producing request only." Messages from the webview are untrusted: each is checked against a schema, events are read by index only, and "the webview never supplies a URL, command id or file path".
- **Grammar limits (section 10):** an expression is at most 4,096 characters; a request has at most 64 `# @capture` lines; a name captured twice on one request is an error; capture names match `[A-Za-z_]\w*` (`src/http-file/captures.ts` `capturePattern`).
- **Tracker semantics the generated expression relies on (section 10 and `src/capture/tracker.ts`):** only events of kind `json` and `text` are seen by `first`, `nth` and their conditions; malformed events never match; `nth(k, …)` counts from 1.
- **Budgets (section 3), verbatim:** "No synchronous task of the extension blocks the extension host for more than 50 ms". Counting and scanning run in slices of at most `captureSliceMs` (10 ms).
- **Performance (`CLAUDE.md`):** nothing here runs per event. The only change in `src/events` is a read-only getter, but `CLAUDE.md` asks for `npm run bench -- throughput` before and after any change there, so run it.
- **Layers:**
  - `src/response/json-position.ts` and `src/http-file/capture-placement.ts` import nothing outside their own folder except types;
  - `src/capture/` imports `src/expressions`, `src/http-file/model.ts`, `src/masking`, `src/response/json-position.ts` (types) and the types of `src/events`;
  - `src/webview/` imports only `src/response/panel-protocol.ts` and its own files;
  - only `src/vscode/**` and `src/extension.ts` import `vscode`.
- **Process:**
  - no code comments;
  - synthetic data only;
  - TDD;
  - branch `m8-click-to-capture` from `origin/main` at `1cc4ccc` (M7 merged), one commit per task;
  - push and pull request only with the user's go-ahead;
  - `vscode-api-verifier` and `extension-security-reviewer` run after Task 6;
  - the gate before the pull request: `npm run check`, `npm run test:integration` (both labels) and `npm run verify:vsix` (the manifest changes).

## Decisions this plan makes (builder's call, approval of this plan approves them)

1. **Entry points.**
   - In the panel: a **Capture This Value…** button below the expanded event, beside **Open Event in Editor**, and one beside **Open in Editor** in the Body tab, shown only when the Body is JSON. The user clicks or selects a value first. Without a recorded selection the webview shows and announces a hint instead of sending anything.
   - In the editor: the command `streamscope.captureValue` ("Capture This Value…", category Streamscope) in the editor context menu and the Command Palette of a response document, using the cursor.
   - From the Command Palette while the panel is active: the command asks the panel for its recorded selection, and the panel answers as if its button had been pressed.
   - Keyboard and screen-reader users cannot place a caret inside the panel's text, so the hint points them to the editor document, where VS Code provides both. A Quick Pick of every value and a webview context-menu entry are not part of M8.
2. **The webview sends a character offset, not path segments.** This changes one phrase of the M5 decision ("sends only an event index and JSON path segments").
   - **Why:** one scanner on the extension side serves the panel and the documents, and the webview stays free of parsing. A whole number in a known range is the smallest thing to validate.
   - **How the text is rebuilt:** the event detail's text is a pure function of the event, extracted from `PanelFeed.detail` into `detailText(event)`, which both use. The Body text is the `PanelBody` the feed last sent. A new run changes the panel's run id, and the extension ignores messages for any other run.
3. **The JSON position scanner is hand-written** (`src/response/json-position.ts`). This settles the decision record's open question; `jsonc-parser` is not added.
4. **Which value an offset selects.**
   - The token under the offset, or else the next token on the same line, or else the previous token on the same line.
   - A string, number, `true`, `false` or `null` token selects that value. A key, or the `:` after it, selects the member's value. A `,` selects the value before it. A `{`, `[`, `}` or `]` selects the object or array it opens or closes.
   - A text event (kind `text`) always selects the whole event, wherever the offset is.
5. **The expression.**
   - **Event source:** the first matching event is `first(C)`, and the k-th is `nth(k, C)`. Without a discriminator these become `first()` and `nth(k)`.
   - **Body source:** `body`, used only when the response is not an event stream.
   - **Path:** a key matching `^[A-Za-z_$][A-Za-z0-9_$]*$` that is not a lexer keyword (`true`, `false`, `null`, `in`, `contains`, `startsWith`, `matches`) becomes `.key`; any other key becomes `["…"]`. An index becomes `[n]`.
   - **Literals** are JSON strings with every character of the Unicode categories Cc, Cf, Zl and Zp written as `\uXXXX`. This covers C0 and C1 controls, bidi controls, zero-width characters, U+2028 and U+2029. Integers keep every digit; other numbers print as JavaScript prints them.
   - **Checks:** the result must parse with `parseExpression(text, 'capture')` and be at most 4,096 characters, or the capture is refused.
6. **The discriminator** follows `eventLabel` (`src/events/label.ts`), using the `typeFields` the run used:
   - the first field present with a non-empty string or a number gives `field == literal`. A field name that is not identifier-safe is written `@["…"]`;
   - otherwise an SSE event name gives `@sse.event == "…"`;
   - otherwise there is no condition.

   The run's `typeFields` come from a new `StreamSession.typeFields` getter, not from the current settings.

7. **Counting the occurrence.**
   - **The test:** an earlier event counts when its kind is `json` or `text` and `holds(C, { value, sse, malformed: false })`. No condition means every event of those kinds counts.
   - **The pre-filter:** for a condition on `typeFields[0]`, an earlier event whose index label is known and differs from the selected event's label cannot match, so it is skipped without being read. That holds because `eventLabel` takes that field first. For every other condition, each earlier `json` or `text` event is read, from memory or the spill file.
   - **Cost:** O(i) index lookups and O(candidates) event reads, in slices of at most 10 ms with a `setImmediate` between them, with O(1) memory.
   - **Progress:** a cancellable notification appears when counting passes 500 ms.
   - **Refusal:** if any earlier event is no longer indexed (past `maxIndexedEvents`) or can no longer be read, the capture is refused (message below).
8. **The suggested name.**
   - **Source:** the last string segment of the path; else the discriminator's value; else `value`.
   - **Words:** split at every character outside `[A-Za-z0-9]`.
   - **Case:** the first word is lower-cased entirely if it is all capitals, or else its first letter is lower-cased. Each later word is title-cased if it is all capitals, or else its first letter is upper-cased.
   - **Fixes:** a name starting with a digit gets a leading `_`, an empty result becomes `value`, and the name is cut at 64 characters.
   - **Clashes:** if the request already captures the name, `2`, `3` and so on are appended.
9. **Name input and `secret`.**
   - **The prompt** shows the expression, cut to 200 characters, never the value.
   - **The input** is a name, optionally preceded by `secret ` to write the keyword.
   - **Credential names:** a name that `looksLikeCredential` (FR-A4) gets `secret` even without the prefix, so the value is carried into sibling captures as section 15 describes.
10. **Where the line goes.**
    - After the request's last `@capture` line, or else directly above its request line.
    - With the same comment marker (`#` or `//`) as that capture line or the request's `@name` line, or else `#`, and with the document's line ending.
    - After the name prompt closes, the document is parsed again and the request found again by the run's key (`findRequest`). The limit of 64 captures and the free name are checked again before the edit. The edit is made only after that check.
    - The new line is selected in its editor, and the status bar shows "Added threadId to startRun; it takes its value the next time startRun runs." for 5 s.
    - The new capture is not evaluated against the run already shown.
11. **Known gap:** a JSON body with a duplicate key yields the key's path, and the capture then reads the value the parser keeps, which is not necessarily the one clicked.

### Messages (exact copy)

| Case                             | Message                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Panel, no selection in the event | Click a value in the event first, or open the event in the editor and run Capture This Value there.                          |
| Panel, no selection in the Body  | Click a value in the body first, or open the body in the editor and run Capture This Value there.                            |
| Text at the offset is not JSON   | Capture This Value needs a JSON value, and the text here is not JSON.                                                        |
| No value at the offset           | There is no value at this position.                                                                                          |
| Deeper than 256 levels           | This value is nested too deeply to capture (more than 256 levels).                                                           |
| Expression over 4,096 characters | The path to this value is too long for a capture (more than 4,096 characters).                                               |
| Malformed event                  | Event N is not valid JSON, so a capture cannot read it.                                                                      |
| Oversize event                   | Event N was cut at streamscope.stream.maxEventSize, so a capture cannot read it.                                             |
| SSE comment                      | Event N is an SSE comment, and captures do not see comments.                                                                 |
| Earlier events gone              | The events before event N are no longer kept, so Streamscope cannot tell which occurrence it is. Write this capture by hand. |
| Event or run released            | This response is no longer available.                                                                                        |
| Body of an event stream          | This response is an event stream; capture a value from one of its events instead.                                            |
| Headers document                 | Capture This Value works in an event or Body document.                                                                       |
| Request gone                     | The request that produced this response is no longer in FILE.                                                                |
| 64 captures                      | This request already has 64 captures, the most a request can have.                                                           |
| Invalid name                     | A capture name starts with a letter or _ and has only letters, digits and _.                                                 |
| Name taken                       | This request already captures NAME.                                                                                          |

## Review Focus

1. **Keys that need care:** `true`, `in`, `a.b`, `""`, `__proto__`, `0` as an object key, a key with U+202E or U+2028, and a key with a lone surrogate. Each must produce a single-line expression that parses and reads the clicked value back. Pinned in Task 2.
2. **The `.http` document changing while the name prompt is open:** the request moves, gets the same capture name, reaches 64 captures, or is deleted. The line lands on the right request or is refused with the message above. Pinned in Task 4 and Task 6.
3. **An event deep in a long stream:** past the 10,000 events kept in memory, with more than 4,096 distinct labels, and with a condition on a later type field. `k` must stay exact and the host stall under 100 ms. Pinned in Task 3.
4. **Offsets that are not on a value token:** indentation, brackets, commas, keys, inside a long string, past the 64 KiB cut of a truncated detail, and past the end. The rule of decision 4 applies, or the scanner refuses. Pinned in Task 1.
5. **A stale panel message:** one for another run, for an index beyond the event count, or with an offset beyond the text. It is ignored or refused, and nothing is written. Pinned in Task 5 and Task 6.

---

### Task 1: JSON position scanner

**Files:**

- Create: `src/response/json-position.ts`
- Test: `test/unit/response/json-position.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type PathSegment = string | number;
  export type PositionProblem = 'not-json' | 'no-value' | 'too-deep';
  export type PositionResult =
    { ok: true; segments: PathSegment[] } | { ok: false; problem: PositionProblem };
  export class JsonPositionScanner {
    constructor(text: string, offset: number);
    step(maxChars: number): PositionResult | undefined;
  }
  export function jsonPathAt(text: string, offset: number): PositionResult;
  ```

  `step` returns `undefined` until it has scanned enough to answer. `jsonPathAt` runs `step` to the end. The scanner reads at most the text up to the end of the selected token, keeps one entry per nesting level, decodes keys with `JSON.parse` on the key token, and stops at 256 levels with `too-deep`.

- [ ] **Step 1: Write the failing tests**

  Over the fixture `{\n  "type": "RUN_STARTED",\n  "threadId": "thread-1",\n  "result": {\n    "ids": [7, 12345678901234567890],\n    "ok": true\n  }\n}`, with each offset taken by `indexOf` on the fixture:

  - `it('selects the value of the key or colon under the offset')`: on `"threadId"` and on the `:` after it → `['threadId']`.
  - `it('selects a value token under the offset')`: inside `"thread-1"` → `['threadId']`; on `12345678901234567890` → `['result', 'ids', 1]`; on `true` → `['result', 'ok']`.
  - `it('selects the container a bracket opens or closes')`: on the `{` after `"result":` and on its `}` → `['result']`; on `[` → `['result', 'ids']`; on the first `{` → `[]`.
  - `it('uses the next token on the line for indentation and the previous one for a trailing comma')`: on the indentation before `"threadId"` → `['threadId']`; on the `,` after `"thread-1"` → `['threadId']`.
  - `it('decodes escaped keys')`: `{"a\\"b": 1, "\\u00e9": 2}` → `['a"b']` and `['é']`.
  - `it('answers from a cut text before the cut and refuses after it')`: the fixture cut in the middle of `"thread-1"` → `['type']` before the cut, `{ ok: false, problem: 'no-value' }` inside the cut token.
  - `it('refuses text that is not JSON, and offsets past the end')`: `'hello'` → `not-json`; offset `text.length + 1` → `no-value`.
  - `it('refuses nesting past 256 levels')`: `'['.repeat(257) + '1'` at the `1` → `too-deep`; `'['.repeat(256) + '1'` → 256 zeros as segments.
  - `it('gives the same answer in steps of any size')`: for every offset of the fixture and step sizes 1, 7 and 64, the stepped result equals `jsonPathAt`.
  - `it('finds every path of an event at the start of its value in the panel text')`: for every event value of `streamFixtures` and every path in it, the offset of that value's first token in `eventText(event, 65_536).text` returns that path. Do the same for `formatBody` output over a JSON body fixture.

- [ ] **Step 2: Run the tests and watch them fail**

  Run: `npx vitest run test/unit/response/json-position.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `JsonPositionScanner` and `jsonPathAt`**

- [ ] **Step 4: Run the tests and watch them pass**

  Run: `npx vitest run test/unit/response/json-position.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "Find the JSON path of the value at a text offset"`

---

### Task 2: Capture expression, name and line builder

**Files:**

- Create: `src/capture/capture-line.ts`
- Modify: `src/expressions/lexer.ts` (export `isKeyword(word: string): boolean`; the set exists)
- Test: `test/unit/capture/capture-line.test.ts`

**Interfaces:**

- Consumes: `PathSegment` (Task 1), `JsonValue` and `SseFields` (`src/events/model.ts`), `looksLikeCredential` (`src/masking/masking.ts`).
- Produces:

  ```ts
  export type EventCondition =
    | { kind: 'field'; field: string; value: string | number | bigint }
    | { kind: 'sse'; value: string };
  export type CaptureSource =
    { kind: 'event'; occurrence: number; condition: EventCondition | undefined } | { kind: 'body' };
  export type BuiltExpression = { ok: true; text: string } | { ok: false; message: string };
  export function eventCondition(
    value: JsonValue,
    sse: SseFields | undefined,
    typeFields: readonly string[],
  ): EventCondition | undefined;
  export function conditionText(condition: EventCondition): string;
  export function captureExpression(
    source: CaptureSource,
    segments: readonly PathSegment[],
  ): BuiltExpression;
  export function suggestedCaptureName(
    segments: readonly PathSegment[],
    condition: EventCondition | undefined,
    taken: ReadonlySet<string>,
  ): string;
  export function captureLine(
    marker: '#' | '//',
    name: string,
    secret: boolean,
    expression: string,
  ): string;
  export function parseCaptureNameInput(
    input: string,
  ): { name: string; secret: boolean } | undefined;
  ```

  `captureLine` returns `${marker} @capture ${secret ? 'secret ' : ''}${name} = ${expression}`. `parseCaptureNameInput` accepts `^(?:secret\s+)?([A-Za-z_]\w*)$` after trimming, and sets `secret` when the prefix is present or the name `looksLikeCredential`.

- [ ] **Step 1: Write the failing tests**

  - `it('builds first and nth expressions with the condition and path')`: `{ kind: 'event', occurrence: 1, condition: { kind: 'field', field: 'type', value: 'RUN_STARTED' } }` with `['threadId']` → `first(type == "RUN_STARTED").threadId`; occurrence 3 with `['result', 'ids', 1]` → `nth(3, type == "RUN_STARTED").result.ids[1]`; no condition, occurrence 1 and 4 → `first()` and `nth(4)`; `@sse.event == "message"` for an SSE condition; `body.items[0].id` for the body.
  - `it('writes keys that are not plain identifiers as bracketed strings')`: for each of `true`, `in`, `a.b`, `""`, `__proto__`, `0`, `has space`, `é`, `x‮y`, `x y` and `\ud800`, the expression parses with `parseExpression(…, 'capture')`. Evaluating it against `{ body: { [key]: 'v' } }` gives `v`, and the text matches no character of `/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u`.
  - `it('writes a non-identifier type field through @')`: field `event-type` → `first(@["event-type"] == "A")`; the condition parses in the `condition` context and `holds` on `{ "event-type": "A" }`.
  - `it('keeps every digit of an integer discriminator')`: value `12345678901234567890n` → `type == 12345678901234567890`; `holds` is true on that event and false on `…891`.
  - `it('picks the discriminator the way eventLabel does')`: with `typeFields` `['type', 'event']`:
    - `{ type: '', event: 'A' }` → field `event`;
    - `{ type: 5 }` → field `type` with value 5;
    - `{}` with `sse.event` `'x'` → `sse`;
    - `{}` without SSE → `undefined`.
  - `it('refuses an expression over 4,096 characters')`: a key of 4,100 characters → `{ ok: false, message: 'The path to this value is too long for a capture (more than 4,096 characters).' }`.
  - `it('suggests a name from the path, the discriminator or "value"')`:
    - `['threadId']` → `threadId`;
    - `['message_id']` → `messageId`;
    - `['x-session-token']` → `xSessionToken`;
    - `['items', 0]` → `items`;
    - `[]` with discriminator `RUN_STARTED` → `runStarted`;
    - `['2fa']` → `_2fa`;
    - `['…']` → `value`;
    - `['threadId']` with `taken` `{threadId, threadId2}` → `threadId3`.
  - `it('reads secret from the prefix or a credential-looking name')`: `'secret runId'` → `{ name: 'runId', secret: true }`; `'accessToken'` → `secret: true`; `'threadId'` → `secret: false`; `'2x'` and `'a b'` → `undefined`.

- [ ] **Step 2: Run the tests and watch them fail**

  Run: `npx vitest run test/unit/capture/capture-line.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement the builder**

- [ ] **Step 4: Run the tests and watch them pass**

  Run: `npx vitest run test/unit/capture/capture-line.test.ts test/unit/expressions`
  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "Build a capture expression, name and line for a value"`

---

### Task 3: Occurrence counter, value plan and the round trip

**Files:**

- Create: `src/capture/occurrence.ts`, `src/capture/value-capture.ts`
- Modify:
  - `src/events/session.ts`: add `get typeFields(): readonly string[]`, returning the limits it already resolved;
  - `src/response/panel-content.ts`: add `detailText(event: StreamEvent | undefined): { text: string; truncated: boolean }`, moved out of `PanelFeed.detail`;
  - `src/response/panel-feed.ts`: `detail` calls `detailText`.
- Test: `test/unit/capture/occurrence.test.ts`, `test/unit/capture/value-capture.test.ts`, `test/unit/response/panel-content.test.ts`

**Interfaces:**

- Consumes: Tasks 1 and 2; `holds` (`src/expressions/evaluate.ts`); `TaskClock` and `captureSliceMs` (`src/capture/task-budget.ts`).
- Produces:

  ```ts
  export interface OccurrenceEvents {
    readonly count: number;
    summary(index: number): EventSummary | undefined;
    read(index: number): Promise<StreamEvent | undefined>;
  }
  export type OccurrenceResult =
    { ok: true; occurrence: number } | { ok: false; reason: 'events-gone' | 'cancelled' };
  export function countOccurrence(input: {
    events: OccurrenceEvents;
    index: number;
    condition: Expr | undefined;
    label: string | undefined;
    signal: AbortSignal;
    clock?: TaskClock;
  }): Promise<OccurrenceResult>;

  export type ValueTarget = { kind: 'event'; event: StreamEvent } | { kind: 'body' };
  export type ValuePlan =
    | { ok: true; expression: string; condition: EventCondition | undefined; suggestedName: string }
    | { ok: false; message: string }
    | { ok: false; cancelled: true };
  export function planValueCapture(input: {
    target: ValueTarget;
    segments: readonly PathSegment[];
    stream: { events: OccurrenceEvents; typeFields: readonly string[] } | undefined;
    taken: ReadonlySet<string>;
    signal: AbortSignal;
    clock?: TaskClock;
  }): Promise<ValuePlan>;
  ```

  `EventStore` satisfies `OccurrenceEvents` structurally. `label` is the pre-filter of decision 7: `events.summary(index)?.label` (the store's own, cut label) when the condition's field is `typeFields[0]`, otherwise `undefined`. The counter compares it with `summary(j).label` and treats an `undefined` label on either side as unknown. `condition` is `conditionText(…)` parsed with `parseExpression(…, 'condition')`, the same parse the tracker's watches use. `stream` is set when `isEventStream` (`src/response/panel-content.ts`) is true for the run. `planValueCapture` does the following:
  - refuses malformed, oversize and comment events with the messages of the table;
  - uses `[]` for text events;
  - checks that the path exists in `event.value`;
  - derives the condition, counts, and builds the expression.

- [ ] **Step 1: Write the failing tests**

  `occurrence.test.ts`, over an `EventStore` with a real spill file (`useSpillArea`) and `memoryEvents` 100:
  - `it('counts earlier matching events of kind json and text only')`: malformed, oversize and comment events between matches do not count, with or without a condition.
  - `it('reads only candidates when the condition is on the first type field')`: 50,000 events of 5 types. For the last `RUN_FINISHED`, the count is exact, and a spy on `read` sees only `RUN_FINISHED` events and events whose label is unknown.
  - `it('stays exact when a later type field decides')`: `typeFields` `['type', 'event']`, the selected event has only `event: "A"`, and earlier events have `type: "B", event: "A"`. They count, and `label` is `undefined`.
  - `it('stays exact past 4,096 distinct labels')`: 5,000 distinct types, then a repeat of type `t4500` → occurrence 2.
  - `it('refuses when earlier events are no longer indexed')`: `maxIndexedEvents` 65,536 and 140,000 events → `events-gone` for event 140,000.
  - `it('stops when cancelled')`: abort after the first slice → `cancelled`, and `read` is not called again.
  - `it('keeps the host stall under 100 ms counting 200,000 spilled events')`: `fastestOf` of `longestStall` (the existing helpers) is under 100.

  `value-capture.test.ts`:
  - `it('evaluates every generated expression back to its value')`: the acceptance test. For each `streamFixtures` entry:
    1. run it through `startRun` against a local server, as `stream-captures.test.ts` does;
    2. for every `json` or `text` event and every path in its value, call `planValueCapture`;
    3. run the request again from `.http` text whose request carries the generated lines (`captureLine`), 64 per request, so the `.http` parser reads each line with no diagnostic;
    4. check that each capture resolves to `insertText` of the value at its path.

    The same test covers a JSON body fixture with nested arrays, a 20-digit integer, keys from Task 2's tricky list, and `body`.

  - `it('refuses events captures cannot read')`: one test per row of the message table for malformed, oversize and comment events, and for the body of an event stream.
  - `it('suggests a name not taken on the request')`.

  `panel-content.test.ts`: `it('detailText is what the feed posts for an event')`.

- [ ] **Step 2: Run the tests and watch them fail**

  Run: `npx vitest run test/unit/capture/occurrence.test.ts test/unit/capture/value-capture.test.ts test/unit/response/panel-content.test.ts`
  Expected: FAIL, modules and `detailText` not found.

- [ ] **Step 3: Run the throughput benchmark before touching `src/events`**

  Run: `npm run bench -- throughput --format ndjson` and `--format sse`, three runs each. Record the medians in the task report.

- [ ] **Step 4: Implement `StreamSession.typeFields`, `detailText`, `countOccurrence` and `planValueCapture`**

- [ ] **Step 5: Run the tests and watch them pass, then run the benchmark again**

  Run: `npx vitest run test/unit/capture test/unit/response test/unit/events`
  Expected: PASS. The benchmark medians stay within noise of Step 3.

- [ ] **Step 6: Commit**

  `git commit -m "Count an event's occurrence and plan a capture of one of its values"`

---

### Task 4: Placement of the line in the `.http` document

**Files:**

- Create: `src/http-file/capture-placement.ts`
- Test: `test/unit/http-file/capture-placement.test.ts`

**Interfaces:**

- Consumes: `HttpRequest` (`src/http-file/model.ts`), `captureLine` (Task 2).
- Produces:

  ```ts
  export type PlacementResult =
    { ok: true; line: number; text: string } | { ok: false; message: string };
  export function placeCapture(input: {
    request: HttpRequest;
    lines: readonly string[];
    name: string;
    secret: boolean;
    expression: string;
  }): PlacementResult;
  export function capturedNames(request: HttpRequest): ReadonlySet<string>;
  ```

  `text` has no line ending. The caller inserts `text + eol` at `(line, 0)`. The request is found by the caller with `findRequest` (`src/runs/run.ts`).

- [ ] **Step 1: Write the failing tests**

  Each test parses a synthetic file with `parseHttpFile`, applies the placement to its lines, and parses the result again:
  - `it('puts the line after the last capture')`: the new capture is last in `request.captures` and the file has no diagnostics.
  - `it('puts the line directly above the request line when there is no capture')`: it is placed below `# @name startRun` and any plain comment lines.
  - `it('uses the comment marker of the request's directives')`: `// @name x` gives `// @capture …`, and a request without directives gives `#`.
  - `it('refuses a name the request already captures')`: the message is `This request already captures threadId.`
  - `it('refuses a 65th capture')`: 64 existing captures give `This request already has 64 captures, the most a request can have.`
  - `it('writes secret when asked')`.
  - `it('places on the right request after the file changed')`: insert a request above, add a capture to the target and rename another request, then call `findRequest` with the original key and `placeCapture`. The line lands on the target. With the target's `@name` removed, `findRequest` gives `undefined`.

- [ ] **Step 2: Run the tests and watch them fail**

  Run: `npx vitest run test/unit/http-file/capture-placement.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `placeCapture` and `capturedNames`**

- [ ] **Step 4: Run the tests and watch them pass**

  Run: `npx vitest run test/unit/http-file`
  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "Place a capture line on its request"`

---

### Task 5: Panel messages and the webview buttons

**Files:**

- Modify:
  - `src/response/panel-protocol.ts`;
  - `src/webview/main.ts`;
  - `src/response/panel-html.ts` (the Body toolbar button and the hint element);
  - `src/webview/panel-text.ts` (the two hints).
- Test: `test/unit/response/panel-protocol.test.ts`, `test/unit/response/panel-html.test.ts`

**Interfaces:**

- Produces, in `panel-protocol.ts`:

  ```ts
  | { type: 'capture'; run: number; target: 'event'; index: number; offset: number }
  | { type: 'capture'; run: number; target: 'body'; offset: number }
  ```

  in `FromPanel`, and `| { type: 'captureSelection' }` in `ToPanel`. `parsePanelMessage` accepts a `capture` only with exactly those keys, a valid `run`, `index` from 1 to the event count, and an integer `offset` from 0 to `panelLimits.inlineBodyBytes`.

- **The webview:**
  - **Recording:** on `selectionchange`, it records `{ target, index, offset }` when the selection starts inside the text of the expanded event's `<pre>` or the Body `<pre>`. The offset is the start of the selection in that text.
  - **Clearing:** the record is cleared when the detail closes, the Body changes or a `reset` arrives.
  - **Buttons:** each sends the record for its own target. `captureSelection` sends the record of the visible tab.
  - **No record:** the webview shows the matching hint under the button and passes it to `announce`.
  - **Visibility:** the Body button appears only when the Body's `language` is `json` and its kind is `text` or `preview`.

- [ ] **Step 1: Write the failing tests**

  - `it('accepts a capture message for an event and for the body')`.
  - `it('refuses capture messages with extra keys, a bad run, an index past the event count, a negative, fractional or oversized offset, or an unknown target')`: one row each.
  - `panel-html.test.ts`: `it('has a Body capture button and a hint region')`. The page's CSP and nonce assertions stay unchanged.

- [ ] **Step 2: Run the tests and watch them fail**

  Run: `npx vitest run test/unit/response/panel-protocol.test.ts test/unit/response/panel-html.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement the protocol, the markup and the webview behaviour**

- [ ] **Step 4: Run the tests and watch them pass**

  Run: `npx vitest run test/unit/response && npm run build`
  Expected: PASS, and `dist/response-view.js` builds.

- [ ] **Step 5: Commit**

  `git commit -m "Send the selected value's position from the response panel"`

---

### Task 6: The Capture This Value command

**Files:**

- Create: `src/vscode/response/capture-value.ts`
- Modify:
  - `src/vscode/response/panels.ts`: handle `capture` and post `captureSelection`;
  - `src/vscode/response/presenter.ts`: `documentFor(uri)` returns `{ run, target: 'body' } | { run, target: 'event', index, jsonStart } | { target: 'headers' } | undefined`. The event documents map becomes `path → { index, jsonStart }`, where `jsonStart` is the length of a prepended note plus 2, or 0;
  - `src/vscode/requests/register.ts`: wiring, and the test commands `streamscope.test.panelMessage(key, message)` and `streamscope.test.answerCaptureName(answer)`, only in `ExtensionMode.Test`;
  - `package.json`: the command, `commandPalette` when `activeWebviewPanelId == 'streamscope.response' || resourceScheme == streamscope-response`, and `editor/context` when `resourceScheme == streamscope-response`.
- Test: `test/integration/capture-value.test.ts`

**Interfaces:**

- Consumes: everything above; `ParseCache`; `findRequest` and `requestKeyDocument` (`src/runs/run.ts`); `captureSliceMs`.
- **Flow:**
  1. **Get the text and offset:** from the panel message (`detailText` of `store.read(index)`, or the feed's Body text), or from the active response document. For a document, the offset is the cursor offset minus `jsonStart`, and the scan covers the text up to the end of the cursor's line, in `step(1_048_576)` slices with `setImmediate` between them.
  2. **Scan:** `jsonPathAt`, or the stepped scanner for a document.
  3. **Find the request:** open the producing document from `requestKeyDocument(run.key)` and run `findRequest`. Refuse when the request is gone or already has 64 captures.
  4. **Plan:** `planValueCapture` with the request's `capturedNames`, behind the delayed progress of decision 7.
  5. **Ask for the name:** `showInputBox` with the suggestion selected, the prompt `Name for ${expression cut to 200}. Start with "secret " to mask the value.`, and `validateInput` from `parseCaptureNameInput` and the taken names.
  6. **Place:** parse the document again, `findRequest` again, then `placeCapture`.
  7. **Edit:** apply a `WorkspaceEdit` on that document only, select the new line, and set the status bar message.

  Every refusal shows the table's message with `showWarningMessage`. A cancelled prompt or count does nothing.

- [ ] **Step 1: Write the failing integration tests**

  Use the stream server from `test/support/stream-server.ts` and a synthetic `.http` file in a temporary folder.
  - `it('captures a value of the first event from the panel and resolves it on the next run')`:
    1. send `startRun`;
    2. inject `{ type: 'capture', run, target: 'event', index: 1, offset }`, where `offset` is the index of `"thread-1"` in event 1's detail text;
    3. answer `threadId`.

    The file now has `# @capture threadId = first(type == "RUN_STARTED").threadId` directly above `POST`. After sending again, `streamscope.test.responseState` lists `threadId = thread-1`.

  - `it('captures the third TEXT_MESSAGE_CONTENT from an event document with the cursor')`: open event 5 with `streamscope.test.openEvent`, put the cursor on `"delta"`, run `streamscope.captureValue` and answer `delta`. The line ends `nth(3, type == "TEXT_MESSAGE_CONTENT").delta`.
  - `it('captures a body value as body.path')`: a JSON response, the Body offset of `"id"` inside `items[1]`, and the line `# @capture id = body.items[1].id`.
  - `it('writes secret for a credential-looking name')`: answer `sessionToken` and get `# @capture secret sessionToken = …`.
  - `it('places the line on the moved request when the file changed during the prompt')`: insert a request above the producer before answering. The line lands on the producer.
  - `it('ignores a capture message for another run, and refuses the Headers document')`: the file is unchanged.
  - `it('does nothing when the name prompt is dismissed')`.

- [ ] **Step 2: Run them and watch them fail**

  Run: `npm run build && npm run test:integration -- --label stable`
  Expected: FAIL, unknown command `streamscope.captureValue`.

- [ ] **Step 3: Implement `capture-value.ts` and the wiring**

- [ ] **Step 4: Run them and watch them pass on both versions**

  Run: `npm run test:integration`
  Expected: PASS on 1.101.0 and stable, with no other test changed.

- [ ] **Step 5: Walk through it by hand in the Extension Development Host**

  - Click a value in the expanded event and in the Body, then press the button.
  - Press the button without a selection and check that the hint appears and is announced.
  - Run the command from the Command Palette with the panel active.
  - Check that the line is selected in its editor and the status bar message shows.

  Note the result in the task report.

- [ ] **Step 6: Commit**

  `git commit -m "Add Capture This Value to the response panel and documents"`

---

### Task 7: Documentation and gate

**Files:**

- Modify:
  - `docs/design.md`: FR-C6, which gets the `nth(k, …)` occurrence, the discriminator rule and the panel and document entry points, and section 13 Decision (M5), which gets the offset message;
  - `docs/decisions/response-surface.md`: under "Questions for the M6 plan", the scanner question answered with a pointer to M8;
  - `README.md`: the capture section gets click-to-capture;
  - `CLAUDE.md`: none, unless the layout table needs the new files (it lists folders, so no).

- [ ] **Step 1: Update the documents**

- [ ] **Step 2: Run the gate**

  - Run `npm run check` and expect all to pass.
  - Run `npm run test:integration` and expect 1.101.0 and stable to pass.
  - Run `npm run verify:vsix` and expect a pass, with the size reported.

- [ ] **Step 3: Run the reviewers**

  - `vscode-api-verifier`, for the command, the menus, `showInputBox`, `withProgress` and `WorkspaceEdit`.
  - `extension-security-reviewer`, for:
    - the new webview message;
    - the file edit;
    - the escaping of decision 5;
    - that no value reaches the prompt, the log or a notification.

  Fix every Critical, Important and Medium finding with a test that fails first.

- [ ] **Step 4: Commit**

  `git commit -m "Document click-to-capture"`
