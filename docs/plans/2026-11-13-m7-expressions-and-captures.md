# M7 Expressions and Captures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** no more copying ids by hand. A request captures values from its response or from individual streamed events with `# @capture`, and later requests use them as `{{request.name}}` or `{{name}}`, waiting for a value that has not arrived yet, or are blocked with a precise message.

**Architecture:**

- **`src/expressions/`** (pure, M7a):
  - a lexer and parser for the design's capture grammar, with exact error positions;
  - an evaluator with lossless numbers;
  - a static safety check for regular expressions;
  - a thin wrapper around the approved JSONPath library.
- **`src/capture/`** (pure, no `vscode`):
  - a tracker per run that evaluates each capture as events arrive;
  - a session registry of capture states with provenance;
  - waiting with a timeout and cancellation;
  - evaluation of REST Client response references.
- **Integration (M7b):**
  - the parser turns `# @capture` lines into structured, diagnosed definitions;
  - the run feeds headers, events and its end to the tracker, and waits before sending when a value is pending;
  - the resolver reads captures first, as FR-N4 says;
  - the editor shows inlay hints, hovers and completion;
  - the panel draws the captured-values strip.

**Tech Stack:** TypeScript 6.0.3, VS Code API 1.101 (inlay hints, hover, completion, CodeLens, status bar), esbuild (a third bundle entry for the body worker), Vitest 5, `@vscode/test-cli`. One new runtime dependency, `@swaggerexpert/jsonpath`, approved in `CLAUDE.md`.

**Spec:**

- **`docs/design.md`:**
  - section 2: FR-A3 (invalid expressions), FR-V7, FR-C1 to FR-C5, FR-C7, FR-N4;
  - section 3 (budgets);
  - section 8 (lossless numbers);
  - section 9 (event model, reply assembly: the `text` source);
  - section 10 in full: capture lines, grammar, sources, semantics, resolution order, waiting;
  - section 11 (the `Waiting` state);
  - sections 13 to 16: inlay hints, captures in state management, masking, errors.
- **`docs/roadmap.md`:** M7.
- **The mockup** `docs/mockups/response-view.html`: the captured-values strip.
- **`CLAUDE.md`:** Security (JSONPath library, no `eval`), Performance and Architecture.

## Global Constraints

- **Grammar and semantics:** design section 10, verbatim:
  - the grammar block;
  - the Sources table;
  - the Semantics table;
  - Resolution order;
  - Waiting.

  Decisions 3 to 8 below settle what section 10 leaves to the builder.

- **Capture behaviour** (FR-C1 to FR-C5, FR-C7):
  - `# @capture [secret] name = expression` goes on the producing request;
  - `{{request.name}}` reads a capture of a specific request, and `{{name}}` the most recent capture with that name in the session;
  - `first` and `nth` resolve as soon as the matching event arrives; `last`, `all`, `count` and `text` resolve when the stream ends;
  - a request that needs a pending capture waits for it (default 30 s, `streamscope.capture.waitTimeout`), showing "waiting for startRun › threadId" with a cancel action, and is blocked with an error if the value fails or times out;
  - a new run of the producer resets its captures to pending;
  - after a run, an inlay hint after each `# @capture` line shows the value (masked if secret) or the failure.
- **Captured-values summary** (FR-V7): it lists each capture of the request as pending, resolved (value, masked if secret) or failed (reason).
- **Precedence** (FR-N4): for a bare `{{name}}`, the order is capture, file variable, active environment, `$shared`.
- **Never auto-run producers** (`CLAUDE.md`): "captured values wait up to 30 s and never auto-run producers". If the producer has never run in this session, the request is blocked at once with a "Run startRun" action (design section 10, Waiting). Nothing runs until the user clicks it.
- **Acceptance** (roadmap M7):
  - the threadId/messageId scenario works end to end against a synthetic AG-UI NDJSON server, including sending the follow-up while the first stream is still running;
  - every failure mode blocks the request with a precise message;
  - large integer ids keep their digits.
- **Budgets** (design section 3, verbatim):
  - "An event is visible at most 100 ms (p95) after its last byte arrives, at sustained 500 events/s of 1 KiB events".
  - "No synchronous task of the extension blocks the extension host for more than 50 ms".
  - "Extension heap stays under 150 MB regardless of stream length".
  - "Bundled extension under 400 KB".
- **Safety:**
  - no `eval`, `new Function` or `vm`;
  - JSONPath only through `@swaggerexpert/jsonpath`, never `jsonpath-plus`, `jsonpath` or JSONata;
  - patterns are checked before they run (decision 5).
- **Masking** (section 15): a `secret` capture's value never appears in:
  - hovers, inlay hints, the captured-values strip;
  - CodeLens and status bar texts;
  - blocked and failed messages;
  - the log, history and error toasts.

  The response content that carried it is still shown as sent.

- **Performance** (`CLAUDE.md`):
  - per-event capture work does not grow with the stream;
  - every collection a capture keeps, and the registry, has a bound that a unit test pins;
  - body evaluation over 1 MiB runs off the extension host thread;
  - each hot-path change states its time and space cost in the PR description.
- **Layers:**
  - `src/expressions/` imports nothing from the project;
  - `src/capture/` imports `src/expressions`, `src/http-file/model.ts`, `src/streaming/json.ts`, and the types of `src/events/model.ts`, `src/transport/model.ts` and `src/runs/observer.ts`;
  - `src/runs/` reaches captures only through the `RunObserver` and `RunCaptures` interfaces it defines;
  - only `src/vscode/` and `src/extension.ts` import `vscode`.
- **Dependencies:** exactly one new runtime dependency, `@swaggerexpert/jsonpath` `4.0.5` (with its dependency `apg-lite`), bundled by esbuild. The JSONPath Compliance Test Suite is vendored as a test fixture, not installed.
- **Process:**
  - no code comments;
  - synthetic data only;
  - TDD;
  - branch `m7-captures` from `origin/main` after PR #20, one commit per task;
  - push and pull request only with the user's go-ahead;
  - `vscode-api-verifier` and `extension-security-reviewer` run at the end;
  - `npm run bench -- throughput` runs before Task 5 and after the last task, because Task 5 changes `src/events`.

## Decisions this plan makes (builder's call, approval of this plan approves them)

1. **What M7 evaluates.**
   - Captures are evaluated.
   - `# @expect` and `# @until` arguments are parsed for diagnostics only. Checks are evaluated in M9 and `@until` in M10.
   - `exists`, `before` and `unique` parse anywhere but are an error outside `# @expect`.
   - Click-to-capture is M8.
   - REST Client `request.*` references and XPath stay unsupported, with a precise message.
2. **Request identity for captures** is the existing request key (`src/runs/run.ts` `requestKey`).
   - `{{name.x}}` refers to the request named `name` in the same file, as REST Client does.
   - A bare `{{x}}` reads the capture named `x` whose producing run started most recently, in any file.
   - The registry keeps the captures of at most 500 request keys, evicting the key whose latest run started longest ago.
3. **Expression details the grammar leaves open:**
   - Strings use double or single quotes with JSON escapes.
   - Identifiers are `[A-Za-z_$][A-Za-z0-9_$]*`.
   - Numbers use JSON number syntax with an optional `-`. Integers outside the safe range parse as `bigint`.
   - Regex flags are limited to `i`, `m`, `s` and `u`.
   - `nth(k, …)` counts from 1; `k` is a whole number from 1 to 2,147,483,647.
   - A path index is a whole number, and a negative one counts from the end.
   - An expression is at most 4,096 characters and nests at most 64 levels.
   - A request has at most 64 `# @capture` lines, and a name used twice on one request is an error.
4. **Conditions:**
   - Inside `first(…)`, `last(…)`, `nth(…)`, `all(…)`, `count(…)`, `# @until` and `[?…]`, every bare identifier is a field of the current item, including words that name sources. `@` is the item itself, and `@sse` is the event's SSE fields.
   - A condition holds when its value is present and is neither `false` nor `null`.
   - Comparisons never coerce types.
     - Numbers and `bigint` compare exactly.
     - Strings compare by code unit.
     - `==` compares arrays and objects deeply.
   - `in` tests membership in a list. `contains` tests for a substring or a list element. `startsWith` works on strings, and `matches` tests a string against a regex.
   - Malformed events never match and are counted.
5. **Regular expressions:** design section 10's 100 ms budget is replaced.
   - **Why:** a JavaScript regex cannot be interrupted on the extension host, and letting one run for 100 ms would break the 50 ms responsiveness budget.
   - **Pattern check:** every pattern, in the capture language and in `jsonpath()` `match()`/`search()`, is checked when it is parsed. A pattern is rejected with a diagnostic when it:
     - has a backreference or lookaround;
     - has a quantified group that contains a quantifier;
     - is longer than 500 characters.
   - **Long subjects:**
     - a condition tested against a string over 100,000 characters is false;
     - a `match(…)` filter on such a string fails the capture;
     - `jsonpath()` `match()`/`search()` return false.
   - **Docs:** the Safety row in design section 10 is updated in Task 12.
6. **When a capture resolves:**
   - An expression whose sources are only `status`, `headers` and `cookies` resolves when the headers arrive.
   - An expression whose only event source is one `first(…)` or `nth(…)` resolves when that event arrives. Everything else resolves when the run ends.
   - `body`, and `jsonpath()` on a body, wait for the whole body.
   - On an event stream, `body` fails with "the response is an event stream; use first(…), last(…) or all(…)". On a non-stream response, an event source fails with "the response is not an event stream".
   - A run that ends cancelled, failed or blocked fails its pending captures with the reason.
7. **Values:**
   - Strings are inserted as they are. Integers keep their digits (`bigint`), and other numbers are inserted as JavaScript prints them, so `1.50` becomes `1.5`.
   - Objects and lists are inserted as compact JSON with large integers kept.
   - `json` forces JSON. `join(s)` joins a list's inserted items.
   - `match(re)` gives the first group, or the whole match when there is no group.
   - `jsonpath("…")` gives:
     - the value when exactly one node matches;
     - a list when several match;
     - a missing value when none match, the same as REST Client's `{{x.response.body.$…}}`.
   - `headers` alone is an object of lower-cased names, with repeated headers joined by `, `. `cookies` alone is an object of the response's `Set-Cookie` pairs.
   - A captured value whose inserted text is over 1 MiB (1,048,576 characters) fails with "the value is larger than 1 MiB".
8. **Bounds:**
   - Each capture keeps O(1) state, except `all(…)` and `jsonpath()` over a stream. These keep at most 10,000 event values and 16 MiB of their raw bytes, then fail with "all(…) matched more than 10,000 events" (or the jsonpath equivalent).
   - Captures stop evaluating once they resolve, and conditions are evaluated only while a capture is pending.
   - Bodies up to 1 MiB are evaluated on the extension host. Larger bodies go to a worker (`dist/capture-worker.js`) that is terminated after each job, as the formatter does.
9. **Waiting** is a run status, `waiting`, before `sending`.
   - The resolver stays synchronous. It reports which captures and response references are pending, and the run waits for them with one timeout (`streamscope.capture.waitTimeout`, default `30s`, the duration pattern of the request settings), then resolves again.
   - Stop, a re-send, and closing VS Code cancel the wait.
   - A request that waits for its own capture is blocked at once ("startRun cannot use its own capture threadId."). So are two runs waiting for each other ("startRun and continue wait for each other's captures.").
10. **Precise messages.** Tests pin these strings:
    - **Producer never run:** `` `{{threadId}}` comes from startRun, which has not run in this session. `` The blocked toast offers "Run startRun".
    - **Capture failed:** `startRun › threadId failed: <reason>.`
    - **Timed out:** `startRun › threadId did not arrive within 30 s.`
    - **Unknown capture:** `startRun has no capture named threadI.`
    - **Reasons:**
      - `no event matched first(type == "RUN_STARTED") (12 events, 1 malformed)`;
      - `event 3 has no value at result.messageId ("messageId" is missing)`;
      - `the body has no value at items[5] (the list has 3 items)`;
      - `startRun was cancelled before threadId resolved`;
      - `startRun failed before threadId resolved: <failure>`;
      - `startRun was not sent: <problem>`.
    - **Request references:** ``Request references such as `{{login.request.headers.X}}` are not supported; use `{{login.response.…}}`.``
    - **XPath:** ``XPath is not supported in `{{login.response.body…}}`; use a JSONPath starting with `$`.``
11. **Where captures show:**
    - **Inlay hints** after each `# @capture` line, for the request's latest run:
      - resolved: `= value`, cut at 60 characters, `••••••` when secret;
      - pending: `…`;
      - failed: `✗ reason`, cut at 60 characters.

      The tooltip has the full text (still masked) and the provenance (run, event, time).

    - **The captured-values strip** in the panel lists the captures of the shown run, as chips cut at 200 characters, and is hidden when the request has none.
    - **Hover** on `{{…}}` shows the capture's state and provenance.
    - **Completion** after `{{` offers `request.name` and bare names for the file's captures.
12. **Undefined-variable diagnostics:**
    - They are no longer reported for `{{name.x}}` when request `name` in the file declares `x`, nor for a bare `{{x}}` that a request in the file declares or that is in the registry.
    - `{{name.x}}` for a request without capture `x` is an error.
    - `{{name.response.body.$…}}` JSONPath syntax is checked.
    - `{{name.request.…}}` is an error, where it used to be exempt.

## Review Focus

1. **The producer is re-sent while a consumer waits.**
   - Its captures go back to pending for the new run.
   - The consumer keeps waiting and receives the new run's value, never the old one.
   - Task 6 pins this with "a re-run producer resolves its waiting consumer with the new run's value".
2. **A request waits for itself, or two requests wait for each other.**
   - Both are blocked at once with decision 9's messages, not after a 30 s timeout.
   - Task 6 pins this with "a cycle of waits is blocked at once".
3. **Large or hostile values.**
   - A `body` capture of a 50 MB JSON body is evaluated in the worker.
   - `all(…)` over 50,000 matching events fails at its bound.
   - JSON nested 10,000 levels deep does not overflow the stack.
   - A catastrophic pattern such as `/(a+)+$/` is rejected before it runs.
   - Tasks 2, 5 and 1 pin these.
4. **Secret captures stay masked.**
   - A `secret` value is absent from hovers, inlay hints, the strip, CodeLens outcomes, blocked messages, the log and history.
   - Task 11 pins this with "a secret capture never appears outside the response content".
5. **Big integer ids.**
   - `{"id": 12345678901234567890}` captured from an event and inserted into a URL, a header and a JSON body keeps every digit.
   - `first(id == 12345678901234567890)` matches it.
   - Tasks 2 and 11 pin this.

---

### Task 1: Expression syntax

**Files:**

- Create:
  - `src/expressions/ast.ts`;
  - `src/expressions/lexer.ts`;
  - `src/expressions/parse.ts`;
  - `src/expressions/regex.ts`.
- Test:
  - `test/unit/expressions/lexer.test.ts`;
  - `test/unit/expressions/parse.test.ts`;
  - `test/unit/expressions/regex.test.ts`.

**Interfaces:**

- Produces, in `ast.ts`:

  ```ts
  export interface Span {
    start: number;
    end: number;
  }
  export type Value =
    | null
    | boolean
    | number
    | bigint
    | string
    | readonly Value[]
    | { readonly [key: string]: Value };
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
  ```

  Spans are character offsets in the expression text.

- Produces, in `parse.ts`:
  - `type ExpressionContext = 'capture' | 'expect' | 'condition'`;
  - `parseExpression(text: string, context: ExpressionContext): { ok: true; expr: Expr } | { ok: false; error: { message: string; span: Span } }`;
  - `sourcesOf(expr: Expr): readonly SourceNode[]`, outermost first, excluding sources inside conditions.

  `condition` is the context of `# @until`: every bare identifier is a field.

- Produces, in `regex.ts`: `checkPattern(pattern: string, flags: string): string | undefined`. It returns decision 5's message or `undefined`, and `parseExpression` uses it for regex literals and `match(…)`.

- [ ] **Step 1: Write the failing tests**
  - **`lexer.test.ts`:**
    - "tokenizes every operator, keyword and literal with its span";
    - "keeps integers beyond 2^53 as bigint": `12345678901234567890` becomes `12345678901234567890n`;
    - "reads both quote styles and JSON escapes";
    - "reads a regex with flags i, m, s and u, and rejects g".
  - **`parse.test.ts`:** one test per grammar rule, with the design section 10 examples:
    - `first(type == "RUN_STARTED").threadId`;
    - `last(type == "RUN_FINISHED").result.messageId`;
    - `headers["x-session-token"]`;
    - `nth(2, type == "TEXT_MESSAGE_CONTENT").delta`;
    - `all(type == "TEXT_MESSAGE_CONTENT").delta | join("")`;
    - `body.items[?status == "ok"][*].id`;
    - `body.items[-1]`;
    - `count(@sse.event == "ping") > 3`;
    - `cookies.session | default("none")`;
    - `jsonpath("$.items[*].id")`;
    - `text | match(/id=(\d+)/)`;
    - `!(status in [500, 502]) && status >= 200`.

    Precedence `||` < `&&` < `!` < comparison < pipe < access. Errors, with exact spans:
    - `first(type == "x"` → `Expected ")".` at offset 17 to 17;
    - `frist(type == "x")` → ``Unknown source `frist`. Expected status, headers, cookies, body, text, first, last, nth, all, count or jsonpath.`` at 0 to 5;
    - `"abc` → `Unterminated string.` at 0 to 4;
    - `status 200` → ``Unexpected `200`.`` at 7 to 10;
    - `nth(0, x)` → `nth(…) counts from 1.` at 4 to 5;
    - `exists(body.x)` in `capture` → `exists(…) is only available in # @expect.` at 0 to 14;
    - a 4,097-character text → `An expression is at most 4,096 characters.`;
    - 65 nested parentheses → `The expression nests too deeply.`

  - **`parse.test.ts` "treats bare identifiers in a condition as fields":** `first(status == "done")` holds a `field` named `status` inside the condition.
  - **`regex.test.ts`:**
    - "accepts plain patterns";
    - "rejects backreferences, lookaround, nested quantified groups and patterns over 500 characters", including `(a+)+$`, `(a|aa)*b`, `(\w+\s?)*$`, `(?=x)` and `\1`, each with a message naming the problem.
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/expressions`
  Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** a hand-written lexer and a recursive-descent parser with a depth counter. `checkPattern` scans the pattern text, without compiling it, for the shapes decision 5 names.
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Parse the capture expression language with exact error positions`

### Task 2: Evaluating expressions

**Files:**

- Create:
  - `src/expressions/compare.ts`;
  - `src/expressions/evaluate.ts`;
  - `src/expressions/insert.ts`.
- Test:
  - `test/unit/expressions/compare.test.ts`;
  - `test/unit/expressions/evaluate.test.ts`;
  - `test/unit/expressions/insert.test.ts`.

**Interfaces:**

- Consumes: `Expr`, `SourceNode`, `Value` and `checkPattern` from Task 1.
- Produces:

  ```ts
  export type Outcome =
    | { present: true; value: Value; event?: number; path: string }
    | { present: false; reason: string };
  export interface Sources {
    value(node: SourceNode): Outcome;
  }
  export interface ConditionItem {
    value: Value;
    sse: { event?: string; id?: string; retry?: number } | undefined;
    malformed: boolean;
  }
  export function evaluate(expr: Expr, sources: Sources): Outcome;
  export function holds(condition: Expr, item: ConditionItem): boolean;
  export function compareValues(left: Value, right: Value): -1 | 0 | 1 | undefined;
  export function equalValues(left: Value, right: Value): boolean;
  export function insertText(value: Value): string;
  export function compactJson(value: Value): string;
  ```

  `path` is the textual path reached, for example `result.messageId` or `items[5]`, and is used for provenance. A missing `reason` follows decision 10, for example `has no value at result.messageId ("messageId" is missing)`. The capture layer adds "event 3" or "the body".

- [ ] **Step 1: Write the failing tests**
  - **`compare.test.ts`:**
    - "compares numbers and bigints exactly": `12345678901234567890n` against `12345678901234567891n`, `2n` against `2`, and `2n` against `2.5`;
    - "never coerces": `"1" == 1` is false;
    - "compares arrays and objects deeply";
    - "orders strings by code unit".
  - **`evaluate.test.ts`:**
    - "walks names, indexes, negative indexes, wildcards and [?…]";
    - "maps a path over all(…) results";
    - "default(…) replaces a missing value and nothing else";
    - "join, json and match filters";
    - "names the missing segment": `body.items[5]` on a 3-item list gives `has no value at items[5] (the list has 3 items)`;
    - "a condition holds only for present values other than false and null";
    - "malformed items never match";
    - "@sse fields are readable in a condition";
    - "a string over 100,000 characters never matches a regex in a condition";
    - "match(…) on a string over 100,000 characters is missing with a reason";
    - "walks a value nested 10,000 levels deep without overflowing" (a path of depth 10,000, built iteratively).
  - **`insert.test.ts`:**
    - "inserts strings as they are";
    - "keeps the digits of large integers in text and inside compact JSON";
    - "inserts other numbers as JavaScript prints them" (`1.5`);
    - "inserts objects and lists as compact JSON".
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/expressions`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - The evaluator walks the tree with explicit stacks where values can nest deeply, so deep values never use recursion proportional to their depth.
  - `compactJson` writes `bigint` as raw digits, matching `compactEventJson`.
  - Regexes are compiled once per node and cached in a `WeakMap` keyed by the node.
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Evaluate capture expressions with lossless numbers`

### Task 3: JSONPath

**Files:**

- Modify: `package.json` and `package-lock.json` (dependency `@swaggerexpert/jsonpath` `4.0.5`).
- Create:
  - `src/expressions/jsonpath.ts`;
  - `test/fixtures/jsonpath-cts/cts.json`, `LICENSE` and `NOTICE`, from `jsonpath-standard/jsonpath-compliance-test-suite` at commit `20ebdcce5008c8a777ee9c80ad853ecf606950b5`;
  - `test/fixtures/jsonpath-cts/README.md`: one line naming the source, the commit and BSD-2-Clause.
- Test:
  - `test/unit/expressions/jsonpath.test.ts`;
  - `test/unit/expressions/jsonpath-compliance.test.ts`.

**Interfaces:**

- Produces:
  - `checkJsonPath(query: string): { message: string; offset: number } | undefined` validates RFC 9535 syntax and well-typedness, and applies `checkPattern` to every `match()`/`search()` pattern it finds.
  - `queryJsonPath(value: Value, query: string): readonly Value[]` returns the nodelist. It replaces `match` and `search` with versions that enforce decision 5, through the library's `functions` option.
  - `evaluate` in Task 2 maps a `jsonpath` node through `Sources`. The capture layer supplies the body, or the event-value list, and applies decision 7's single, several or none rule.

- [ ] **Step 1: Install the dependency.** Run `npm install @swaggerexpert/jsonpath@4.0.5`. `.npmrc` already sets `save-exact` and `min-release-age`. Record the VSIX size before and after (`npm run package`, then `ls -l *.vsix`).
- [ ] **Step 2: Write the failing tests**
  - **`jsonpath-compliance.test.ts`:**
    - "passes the JSONPath Compliance Test Suite" runs every case in `cts.json` through `checkJsonPath` and `queryJsonPath`.
    - Cases marked `invalid_selector` must be rejected.
    - The others must return `result`, or one of `results` when the order is not fixed.
    - The only skipped cases are those whose `match()`/`search()` pattern decision 5 rejects. The test lists them by name and asserts the count, so a change in that count fails.
  - **`jsonpath.test.ts`:**
    - "selects a large integer and keeps its digits";
    - "rejects a catastrophic pattern in match()";
    - "match() and search() return false on strings over 100,000 characters";
    - "reports the offset of a syntax error".
- [ ] **Step 3: Run them to see them fail**

  Run: `npx vitest run test/unit/expressions/jsonpath`
  Expected: FAIL.

- [ ] **Step 4: Implement** the wrapper. It imports only from `@swaggerexpert/jsonpath`.
- [ ] **Step 5: Run the gate and the size check**

  Run: `npm run check && npm run build:production && npm run verify:vsix`
  Expected: PASS, with the VSIX under 409,600 bytes. Put the before and after sizes in the commit message body.

- [ ] **Step 6: Commit** `Add RFC 9535 JSONPath with the compliance suite`

### Task 4: Capture directives and expression diagnostics

**Files:**

- Modify:
  - `src/http-file/model.ts` (`CaptureDirective`, `HttpRequest.captures`, new `DiagnosticCode`s);
  - `src/http-file/directives.ts`;
  - `src/http-file/parse.ts`.
- Create: `src/http-file/captures.ts`.
- Test:
  - `test/unit/http-file/captures.test.ts`;
  - `test/unit/http-file/diagnostics.test.ts`.

**Interfaces:**

- Consumes: `parseExpression`, `ExpressionContext` (Task 1); `checkJsonPath` (Task 3).
- Produces:

  ```ts
  export interface CaptureDirective {
    secret: boolean;
    name: string;
    nameRange: Range;
    expressionText: string;
    expressionRange: Range;
    expression: Expr | undefined;
    range: Range;
  }
  ```

  - `HttpRequest.captures: readonly CaptureDirective[]` is in source order. `expression` is `undefined` when the expression does not parse; the diagnostic carries the error.
  - New `DiagnosticCode` values: `invalid-expression`, `duplicate-capture` and `too-many-captures`.
  - Expression diagnostics map the error span onto the argument's document range, so they land on the exact columns.

- [ ] **Step 1: Write the failing tests**
  - **`captures.test.ts`:**
    - "splits secret, name and expression with their ranges";
    - "keeps the expression's error at its exact column", for example `# @capture id = first(type == "x"` with the error at the end of the line;
    - "a name used twice on one request is an error on the second";
    - "a 65th capture is an error";
    - "jsonpath() queries are checked";
    - "`# @expect` and `# @until` arguments are checked in their contexts but not stored".
  - **`diagnostics.test.ts`:** every existing case still passes. The old `invalid-capture` message stays for lines that are not `[secret] name = expression`.
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/http-file`
  Expected: FAIL.

- [ ] **Step 3: Implement.** Parse each request's captures once inside `parseHttpFile`, so `ParseCache` covers them.
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Parse capture lines and report expression errors at their columns`

### Task 5: Tracking captures during a run

**Files:**

- Create:
  - `src/capture/tracker.ts`;
  - `src/capture/body.ts` (inline or worker evaluation of body expressions);
  - `src/capture/body-worker.ts`;
  - `src/capture/messages.ts`;
  - `src/runs/observer.ts`.
- Modify:
  - `src/events/session.ts` (`onEvent` option);
  - `src/runs/run.ts` (`RunInput.observer`);
  - `esbuild.mjs` (entry `capture-worker`);
  - `package.json` `files` (`dist/capture-worker.js`);
  - `test/unit/manifest.test.ts`.
- Test:
  - `test/unit/capture/tracker.test.ts`;
  - `test/unit/capture/body.test.ts`;
  - `test/unit/events/session.test.ts`;
  - `test/unit/runs/run.test.ts`.

**Interfaces:**

- Consumes: Tasks 1 to 4; `StreamEvent`, `ResponseHead`, `StreamFormat` and `parseJson` (`src/streaming/json.ts`).
- Produces:

  ```ts
  export interface CaptureDefinition {
    name: string;
    secret: boolean;
    expression: Expr;
    text: string;
  }
  export interface Provenance {
    runId: number;
    event: number | undefined;
    path: string;
    time: number;
  }
  export type CaptureResult =
    | { state: 'pending' }
    | { state: 'resolved'; text: string; provenance: Provenance }
    | { state: 'failed'; reason: string };
  export class CaptureTracker {
    constructor(
      run: { id: number; label: string },
      definitions: readonly CaptureDefinition[],
      onResult: (name: string, result: CaptureResult) => void,
    );
    head(head: ResponseHead): void;
    event(event: StreamEvent): void;
    end(end: RunEnd): Promise<void>;
  }
  ```

- Also produces, in `src/runs/observer.ts` (types only, so `src/capture/` can import it without importing the run):

  ```ts
  export type RunEnd =
    | {
        kind: 'completed';
        format: StreamFormat | undefined;
        contentType: string | undefined;
        readBody: (maxBytes: number) => Promise<Uint8Array | undefined>;
        readReply: () => Promise<string | undefined>;
      }
    | { kind: 'failed'; message: string }
    | { kind: 'cancelled' }
    | { kind: 'blocked'; message: string };
  export interface RunObserver {
    head(head: ResponseHead): void;
    event(event: StreamEvent): void;
    end(end: RunEnd): void;
  }
  ```

  It is set on `RunInput.observer`. The run calls:
  - `head` from `sink.onHead`;
  - `event` through `StreamSessionOptions.onEvent`, which the session calls after `store.append`;
  - `end` exactly once, on every exit path.

  The run does not await `end`.

- Also produces `evaluateBodyExpressions(bytes: Uint8Array, contentType: string | undefined, definitions: readonly CaptureDefinition[], workerFile: string): Promise<ReadonlyMap<string, Outcome>>`. It works inline up to 1,048,576 bytes and in a worker above that. It parses with `parseJson` (lossless) when the content type is JSON or the text starts with `{` or `[`; otherwise the body is its decoded text.

- [ ] **Step 0: Record the throughput baseline.** Run `npm run bench -- throughput` and keep the NDJSON and SSE events/s for Task 12.
- [ ] **Step 1: Write the failing tests.** `tracker.test.ts` scripts event sequences with a fake run:
  - "first(…) resolves at the matching event and stops evaluating": a counting condition proves no evaluation after the match;
  - "nth(2, …) resolves at the second match";
  - "last(…), count(…) and text resolve at the end";
  - "head-only expressions resolve at the headers";
  - "a late event resolves after earlier ones did not match";
  - "no matching event fails at the end with the decision 10 reason, counting malformed events";
  - "malformed events never match";
  - "a cancelled, failed or blocked run fails pending captures with its reason";
  - "a missing path in the matching event fails at once, naming the event and the segment";
  - "default(…) resolves a capture whose event never arrived";
  - "all(…) fails after 10,000 matches and keeps no more than that" (50,000 events; the retained values are pinned at 10,000);
  - "body on an event stream fails" and "first(…) on a JSON body fails", with decision 6's messages;
  - "a secret capture's result is marked secret" (masking itself is in Tasks 8 to 10).

  The other tests:
  - **`body.test.ts`:** "evaluates a 1 MiB body inline and a 2 MiB body in the worker", "keeps a large integer's digits from a body" and "a 50 MB body does not block the calling thread for more than 50 ms", the last measured with a timer that ticks during the call.
  - **`session.test.ts`:** "calls onEvent once per stored event, in order".
  - **`run.test.ts`:** "the observer sees head, events and exactly one end on every exit path": completed, failed, cancelled, blocked and body-too-large.

- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/capture test/unit/events/session.test.ts test/unit/runs/run.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - The tracker classifies each definition by decision 6 using `sourcesOf`.
  - Per event, it evaluates only the conditions of pending event-sourced captures: O(pending captures × condition size) per event, O(1) state per capture except the decision 8 collections.
  - `messages.ts` builds every decision 10 reason, so later tasks reuse them.
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check && npm run build`
  Expected: PASS, with `dist/capture-worker.js` built.

- [ ] **Step 5: Commit** `Evaluate captures while a response streams`

### Task 6: The capture registry, waiting and response references

**Files:**

- Create:
  - `src/capture/registry.ts`;
  - `src/capture/references.ts`.
- Test:
  - `test/unit/capture/registry.test.ts`;
  - `test/unit/capture/references.test.ts`.

**Interfaces:**

- Consumes: `CaptureResult`, `Provenance` and `messages.ts` (Task 5); `queryJsonPath` (Task 3).
- Produces:

  ```ts
  export interface CaptureEntry {
    request: string;
    label: string;
    name: string;
    secret: boolean;
    runId: number;
    runStartedAt: number;
    result: CaptureResult;
  }
  export class CaptureRegistry {
    constructor(limit?: number);
    begin(
      run: { id: number; key: string; label: string; startedAt: number },
      definitions: readonly { name: string; secret: boolean }[],
    ): void;
    update(runId: number, name: string, result: CaptureResult): void;
    get(request: string, name: string): CaptureEntry | undefined;
    latest(name: string): CaptureEntry | undefined;
    forRequest(request: string): readonly CaptureEntry[];
    wait(
      request: string,
      name: string,
      waiter: number,
      options: { timeoutMs: number; signal: AbortSignal },
    ): Promise<CaptureEntry>;
    onDidChange(listener: (entry: CaptureEntry) => void): () => void;
  }
  ```

  - `begin` resets the request's captures to pending for the new run, so FR-C5 holds.
  - `update` from an earlier run of the same request is ignored.
  - `wait` resolves when the entry is resolved or failed. It rejects with a `CaptureWaitError` whose `kind` is `timeout`, `cancelled`, `self` or `cycle`, and whose message follows decisions 9 and 10.
  - The default `limit` is 500.

- Also produces `evaluateResponseReference(run: ReferencedRun, reference: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>` for the REST Client references:
  - `response.body.*`;
  - `response.body.$…`, through `queryJsonPath`;
  - `response.headers.Name`.

  `ReferencedRun = { label; status; head; done: Promise<unknown>; readBody(maxBytes) }` is a structural subset of `RunHandle`. Bodies over 1 MiB go through Task 5's worker.

- [ ] **Step 1: Write the failing tests**
  - **`registry.test.ts`:**
    - "a new run resets its request's captures to pending";
    - "latest(name) is the capture whose run started last";
    - "an update from a superseded run is ignored";
    - "a re-run producer resolves its waiting consumer with the new run's value" (Review Focus 1);
    - "wait times out with the decision 10 message";
    - "an aborted signal cancels the wait and leaves nothing registered";
    - "a request waiting for its own capture is refused at once";
    - "a cycle of waits is blocked at once" (Review Focus 2);
    - "keeps at most 500 requests, evicting the one whose run started longest ago" (the bound);
    - "listeners are removed by the returned function".
  - **`references.test.ts`:**
    - "reads response.body.$.x with JSONPath";
    - "reads response.body.* as the whole body";
    - "reads response.headers case-insensitively and joins repeats";
    - "waits for the referenced run to finish";
    - "rejects request.* and XPath with the decision 10 messages".
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/capture`
  Expected: FAIL.

- [ ] **Step 3: Implement.** The waits graph maps a waiting run to the run it waits for. A cycle check walks it before a wait starts, and each wait removes its edge when it ends.
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Keep captures for the session and wait for pending values`

### Task 7: Resolving captures in requests

**Files:**

- Modify:
  - `src/variables/sources.ts` (`captures` source);
  - `src/variables/resolve.ts`;
  - `src/variables/inspect.ts`.
- Create: `src/variables/references.ts` (the one request-reference pattern, today duplicated in `resolve.ts:56` and `inspect.ts:44`).
- Test:
  - `test/unit/variables/resolve.test.ts`;
  - `test/unit/variables/inspect.test.ts`;
  - `test/unit/variables/sources.test.ts`.

**Interfaces:**

- Consumes: Task 6's `CaptureEntry` shape (structurally); Task 3's `checkJsonPath`.
- Produces:

  ```ts
  export type CaptureLookupResult =
    | { kind: 'value'; text: string; secret: boolean; label: string; provenance: Provenance }
    | { kind: 'pending'; request: string; label: string; name: string }
    | { kind: 'failed'; message: string }
    | { kind: 'not-run'; label: string; producerName: string | undefined };
  export interface CaptureLookup {
    request(requestName: string, captureName: string): CaptureLookupResult | undefined;
    bare(captureName: string): CaptureLookupResult | undefined;
    response(requestName: string, reference: string): CaptureLookupResult | undefined;
  }
  ```

  - `VariableSources.captures: CaptureLookup` (an empty lookup in tests and hovers without a session).
  - `Resolution` gains `waits: readonly CaptureWait[]` on its failure branch:
    - `CaptureWait = { kind: 'capture'; request: string; name: string; label: string } | { kind: 'response'; requestName: string; reference: string }`;
    - a resolution with only waits and no problems means "wait, then resolve again".
  - `ResolutionProblem` gains `producer?: string`, the name of the request the "Run …" action sends.
  - A resolved secret capture's text is added to `sensitiveValues`.

- [ ] **Step 1: Write the failing tests**
  - **`resolve.test.ts`:**
    - "a bare name reads a capture before a file variable of the same name" (FR-N4);
    - "`{{startRun.threadId}}` reads that request's capture";
    - "a pending capture yields a wait, not a problem";
    - "a failed capture blocks with startRun › threadId failed: …";
    - "a producer that never ran blocks with the decision 10 message and its producer name";
    - "a name no request captures falls back to file, environment and $shared";
    - "`{{startRun.threadI}}` blocks with startRun has no capture named threadI.";
    - "response references read through the lookup and wait when needed";
    - "`{{x.request.headers.A}}` and XPath block with the decision 10 messages" (replacing the "not supported yet" test);
    - "a secret capture's value joins sensitiveValues";
    - "a large integer capture is inserted with every digit".
  - **`inspect.test.ts`:**
    - "no undefined-variable warning for a capture the file declares";
    - "an unknown capture on a named request is an error";
    - "a response reference's JSONPath is checked";
    - "describeReference shows a capture's value, masked when secret, with its provenance".
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/variables`
  Expected: FAIL.

- [ ] **Step 3: Implement.** Keep `resolveRequest` synchronous and pure.
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Resolve captured values in requests, capture first`

### Task 8: Waiting runs and the extension wiring

**Files:**

- Modify:
  - `src/runs/run.ts` (status `waiting`, `RunInput.captures`, the wait loop);
  - `src/runs/registry.ts` (`isActive`);
  - `src/response/panel-protocol.ts` (`PanelRunState`);
  - `src/webview/panel-text.ts` ("Waiting");
  - `src/response/labels.ts`;
  - `src/response/run-status.ts`;
  - `src/vscode/requests/register.ts`;
  - `src/vscode/requests/code-lens.ts`;
  - `src/vscode/requests/status-bar.ts`;
  - `src/vscode/requests/settings.ts` (`readCaptureSettings`);
  - `src/vscode/log.ts`;
  - `src/extension.ts`;
  - `package.json` (`streamscope.capture.waitTimeout`);
  - `test/unit/manifest.test.ts`.
- Create:
  - `src/capture/lookup.ts`: the pure `captureLookup(registry: CaptureRegistry, documentUri: string, file: HttpFile, responses: ReadonlyMap<string, CaptureLookupResult>): CaptureLookup`. It maps a request name in the file to its request key, finds the first request in the file that declares a bare name for the "has not run" message, and reads evaluated response references from `responses`.
  - `src/capture/service.ts`: the pure `CaptureService` that implements `RunCaptures`. It holds the registry, builds trackers from `HttpRequest.captures`, evaluates response references into the run's `responses` map, and turns `CaptureWaitError`s into `ResolutionProblem`s.
  - `test/unit/capture/lookup.test.ts`;
  - `test/unit/capture/service.test.ts`.
- Test:
  - `test/unit/runs/run.test.ts`;
  - `test/unit/response/labels.test.ts`;
  - `test/integration/captures.test.ts`.

**Interfaces:**

- Consumes: Tasks 5 to 7.
- Produces:

  ```ts
  export interface RunCaptures {
    lookup: CaptureLookup;
    observer(run: { id: number; label: string }): RunObserver | undefined;
    begin(run: { id: number; key: string; label: string; startedAt: number }): void;
    wait(
      waits: readonly CaptureWait[],
      runId: number,
      options: { timeoutMs: number; signal: AbortSignal },
    ): Promise<{ ok: true } | { ok: false; problem: ResolutionProblem }>;
  }
  ```

  - It is set on `RunInput.captures`, together with `RunInput.waitTimeoutMs`.
  - `RunStatus` gains `'waiting'`.
  - `RunSnapshot.waitingFor: string | undefined`, for example `startRun › threadId`.
  - Setting `streamscope.capture.waitTimeout`: string `^\d+(ms|s|m)$`, default `"30s"`, window scope, described as "How long a request waits for a captured value that has not arrived yet."

- [ ] **Step 1: Write the failing tests**
  - **`run.test.ts`:**
    - "a request waits for a pending capture, then sends with its value";
    - "the wait times out and blocks with the decision 10 message";
    - "cancelling a waiting run ends it cancelled and releases the wait";
    - "a producer never run blocks at once with a producer name on the problem";
    - "begin resets the producer's captures before it resolves".
  - **`labels.test.ts`:** "a waiting run reads Waiting for startRun › threadId · 3 s".
  - **`captures.test.ts`** (integration):
    - "the follow-up waits for the stream's capture and then sends it": a delayed `RUN_STARTED` from the stream server, asserting the CodeLens shows "Waiting for startRun › threadId" and that `server.requests` holds the follow-up with `thread-1`;
    - "Stop cancels a waiting request";
    - "the blocked toast offers Run startRun, and nothing runs until it is clicked", using a test hook that returns the last blocked notification's actions;
    - "a re-send replaces a waiting run".
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/runs test/unit/response && npm run test:integration -- --label stable`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `run()` calls `captures.begin` before resolving.
  - It then resolves in a loop: on waits only, it sets `waiting` with `waitingFor`, calls `captures.wait`, and resolves again. It stops after at most 4 rounds; a fifth wait blocks with "The captured values kept changing while startRun waited."
  - These checks treat a run as active when it is `sending` or `receiving`. Each one includes `waiting` where "active" is meant:
    - `src/runs/registry.ts` (`isActive`);
    - `src/vscode/requests/code-lens.ts`;
    - `src/vscode/response/panels.ts`;
    - `src/response/panel-content.ts`;
    - `src/response/labels.ts`;
    - `src/vscode/response/presenter.ts`;
    - `src/webview/panel-state.ts` (`canSave` stays false for `waiting`).

    The exhaustive `stateLabels` in `src/webview/panel-text.ts` and the `outcomeText` switch in `src/response/labels.ts` get a `waiting` case.

  - The blocked toast gets a "Run <producer>" button that runs `streamscope.sendRequest` on that request's line.
- [ ] **Step 4: Run the gate and the integration tests**

  Run: `npm run check && npm run test:integration`
  Expected: PASS on both labels.

- [ ] **Step 5: Commit** `Wait for captured values before sending, with a timeout and Stop`

### Task 9: Captures in the editor

**Files:**

- Create: `src/vscode/language/captures.ts` (inlay hints).
- Modify:
  - `src/vscode/language/variables.ts` (`sourcesFor` adds the capture lookup, so diagnostics and hovers see captures; hover; completion);
  - `src/vscode/language/register.ts`.
- Test:
  - `test/unit/capture/hints.test.ts` (pure hint text in `src/capture/hints.ts`);
  - `test/integration/captures.test.ts`.

**Interfaces:**

- Consumes: `CaptureRegistry.forRequest` and `onDidChange` (Task 6); `HttpRequest.captures` (Task 4).
- Produces:
  - `captureHint(entry: CaptureEntry | undefined): { label: string; tooltip: string } | undefined`, in `src/capture/hints.ts`. Its texts follow decision 11, with `undefined` for a request that has not run.
  - An `InlayHintsProvider` for `http` documents whose `onDidChangeInlayHints` fires, at most every 200 ms, when an entry of an open document's request changes.

- [ ] **Step 1: Write the failing tests**
  - **`hints.test.ts`:**
    - "resolved, pending and failed texts";
    - "values are cut at 60 characters";
    - "a secret value is •••••• in the label and the tooltip";
    - "the tooltip names the run, event and time".
  - **Integration:**
    - "an inlay hint after the capture line shows the value after the run";
    - "hovering {{startRun.threadId}} shows the value and its provenance";
    - "completion after {{ offers startRun.threadId and threadId".
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/capture && npm run test:integration -- --label stable`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gate and the integration tests**

  Run: `npm run check && npm run test:integration`
  Expected: PASS.

- [ ] **Step 5: Commit** `Show captured values as inlay hints, hovers and completions`

### Task 10: The captured-values strip

**Files:**

- Modify:
  - `src/response/panel-protocol.ts` (`PanelCapture`, the `captures` field on `reset` and `update`);
  - `src/response/panel-feed.ts`;
  - `src/response/panel-html.ts`;
  - `src/webview/main.ts`;
  - `src/vscode/response/panels.ts` (it re-renders on registry changes for the shown run).
- Test:
  - `test/unit/response/panel-feed.test.ts`;
  - `test/unit/response/panel-protocol.test.ts`;
  - `test/unit/response/panel-html.test.ts`;
  - `test/integration/response-panel.test.ts`.

**Interfaces:**

- Produces: `PanelCapture = { name: string; state: 'pending' | 'resolved' | 'failed'; text: string }`.
  - `text` is masked by the extension before it is posted and cut at 200 characters.
  - There are at most 64 per message.
  - `captures` is sent on `reset`, and on `update` only when it changed.

- [ ] **Step 1: Write the failing tests**
  - **Feed:**
    - "posts the shown run's captures and only the changes";
    - "masks secret values before posting";
    - "cuts text at 200 characters and sends at most 64".
  - **Protocol:** "`captures` is part of `ToPanel` and pinned by type".
  - **HTML:** "the strip is a list labelled Captured values, hidden when empty".
  - **Integration:** "the strip shows threadId pending, then resolved, during a stream".
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/response && npm run test:integration -- --label stable`
  Expected: FAIL.

- [ ] **Step 3: Implement.** The page writes chips with `textContent` only, as `<ul aria-label="Captured values">`, with each item reading `name · value`, `name · waiting` or `name · ✗ reason`. Colours use text tokens, as the M6 accessibility fix did.
- [ ] **Step 4: Run the gate and the integration tests**

  Run: `npm run check && npm run test:integration`
  Expected: PASS.

- [ ] **Step 5: Commit** `Show the run's captured values in the response panel`

### Task 11: End-to-end acceptance against a synthetic agent server

**Files:**

- Create:
  - `test/support/agent-server.ts`;
  - `test/integration/capture-flow.test.ts`.
- Test: `test/unit/support.test.ts` (the server's own behaviour).

**Interfaces:**

- Produces `startAgentServer(): Promise<LocalServer>`:
  - **`POST /agent/run`** streams AG-UI NDJSON:
    - `RUN_STARTED` with a fresh `threadId`;
    - three `TEXT_MESSAGE_CONTENT` events;
    - `RUN_FINISHED` with `result.messageId` and `result.sequence: 12345678901234567890`.
  - **Response headers:** `X-Session-Token: synthetic-session` and `Set-Cookie: session=synthetic; Path=/`.
  - **Query parameters:**
    - `delayMs` (before `RUN_STARTED`);
    - `gapMs` (between events);
    - `omit=started|finished`;
    - `malformed=1` (one bad line);
    - `fail=mid` (destroys the socket after `RUN_STARTED`).
  - **`POST /agent/continue`** answers 200 with the request body echoed as JSON.

- [ ] **Step 1: Write the failing tests** in `capture-flow.test.ts`, using the design section 10 example file pointed at the server:
  - "continue carries startRun's threadId and messageId";
  - "continue sent while startRun is still streaming waits and then sends" (`gapMs=1000`);
  - "large integer ids keep their digits in the URL, a header and the JSON body";
  - "a secret capture never appears outside the response content": it checks the inlay hint, the strip state, the CodeLens titles, the hover, the log output channel through a test hook, and the history items;
  - one test per failure mode, each asserting the exact decision 10 message:
    - `omit=started`;
    - `omit=finished`;
    - `fail=mid`;
    - Stop on startRun;
    - a timeout with `streamscope.capture.waitTimeout` set to `1s`;
    - a producer never run;
    - an unknown capture name;
    - `malformed=1` counted in the reason.
- [ ] **Step 2: Run them to see them fail**

  Run: `npm run test:integration -- --label stable`
  Expected: FAIL until the server exists. After that, every failure points at a real gap in Tasks 1 to 10; fix those with a unit test first.

- [ ] **Step 3: Implement the server, then make the flow pass.**
- [ ] **Step 4: Run the full gate**

  Run: `npm run check && npm run test:integration && npm run test:restricted`
  Expected: PASS on both labels. Captures work the same in restricted mode, with the confirmation before sending.

- [ ] **Step 5: Commit** `Prove the capture flow end to end against a synthetic agent server`

### Task 12: Measurements and documentation

**Files:**

- Modify:
  - `docs/benchmarks.md` (an M7 section);
  - `docs/design.md`: section 10's Safety row per decision 5, plus decisions 3, 6 and 7 where section 10 is silent; FR-C4's waiting text if it changed;
  - `README.md` (a Captures section that replaces "come in later versions", with the section 10 example);
  - `CLAUDE.md` (layout rows for `src/expressions/` and `src/capture/`);
  - `test/benchmark/throughput.ts` and `test/benchmark/main.ts` (the `--captures` option).

- [ ] **Step 1: Measure**
  - `npm run bench -- throughput`: compare with Task 5's baseline. Expected: within 5%.
  - `npm run bench -- soak --minutes 5`: memory flat.
  - Add a capture case to the throughput bench, `--captures 4`, which runs four `first(…)` captures that never match and one `count(…)`, so every event is evaluated. Report its events/s next to the plain run.
- [ ] **Step 2: Write the docs.** Every number comes from a run in this task.
- [ ] **Step 3: Run the gate**

  Run: `npm run check && npm run test:integration && npm run test:restricted && npm run verify:vsix`
  Expected: PASS, VSIX under 409,600 bytes.

- [ ] **Step 4: Commit** `Record the M7 measurements and document captures`

### After the tasks

- **Final review:** a whole-branch review on the most capable model, plus:
  - `extension-security-reviewer`: the expression evaluator and regex check, the body worker, masking of secret captures, waiting and cancellation, and the new dependency;
  - `vscode-api-verifier`: the inlay hints provider, hover and completion changes, the setting, and the manifest.
- **Then:** one fix pass, and the push and pull request on the user's go-ahead. The PR description states the time and space cost of each hot-path change, for the per-event tracker and the body worker.
