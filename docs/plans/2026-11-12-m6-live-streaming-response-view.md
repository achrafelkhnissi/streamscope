# M6 Live Streaming Response View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** events visible live, one at a time. Every response opens in one webview panel per request, with Events, Reply, Raw, Headers, Body and Checks, live status and Stop. Large content opens in the editor, streams can be saved, history keeps the last 50 runs, and the CodeLens and status bar show live state.

**Architecture:**

- **Runs stream.**
  - `startRun` feeds the M4 `StreamSession` from the first response bytes, with a spill file per run.
  - It keeps a bounded raw tail, and keeps the body in memory only when the response is not an event stream.
  - The transport pauses the socket only when the spill file asks it to.
- **Pure response modules** (`src/response/`): the panel's message protocol and its validation, the rows, the size limits and the panel HTML.
- **The page** (`src/webview/`): a browser bundle that draws the panel. It has a virtualized event list with scaled scrolling and inline detail.
- **The `vscode` side** (`src/vscode/response/`): one panel per request. It subscribes to the run's batched updates, posts deltas, validates every message from the page, and opens the M2 documents for Open in Editor.

**Tech Stack:** TypeScript 6.0.3, VS Code API 1.101 (webview panels, file system provider, CodeLens, status bar, quick pick), esbuild (a second, browser bundle), Vitest 5, `@vscode/test-cli`, the M5 view benchmark. No new dependency.

**Spec:**

- `docs/decisions/response-surface.md`: the accepted M5 decision, with its Decision section and Consequences for M6.
- `docs/design.md`:
  - section 2 (FR-V1 to FR-V8, FR-S1, FR-S5);
  - section 3 (budgets);
  - sections 9, 11 and 12 (event model, retention, lifecycle, cancellation);
  - section 13, including the M5 decision;
  - sections 14 to 17 and 19 (settings).
- `docs/roadmap.md`, M6.
- The mockup, `docs/mockups/response-view.html`.
- `CLAUDE.md`, including its Performance section.

## Global Constraints

- **Budgets** (design section 3, verbatim):
  - "An event is visible at most 100 ms (p95) after its last byte arrives, at sustained 500 events/s of 1 KiB events".
  - "No synchronous task of the extension blocks the extension host for more than 50 ms; typing in the editor stays smooth during a 30-minute stream".
  - "Extension heap stays under 150 MB regardless of stream length; older events live on disk".
  - "A 50 MB JSON body opens without freezing VS Code".
  - "Every action is reachable from the keyboard and command palette; views work with screen readers".
- **Viewing** (FR-V1 to FR-V8):
  - the view opens as soon as response headers arrive;
  - Events is the default for streams and remembered per user;
  - Reply appears only when an adapter is recognised;
  - Body is the default for non-streaming responses;
  - live status shows the state, event count, elapsed time, bytes, detected format and how it was detected;
  - Stop is available while streaming;
  - event detail shows the full pretty JSON;
  - streams save as `.ndjson` or `.sse`;
  - one view per request, which a new run replaces;
  - Show History lists the last 50 runs (title, status, events, time) and reopens any of them read-only.
- **Webview safeguards** (decision record, Consequences for M6):
  - `default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; img-src ${cspSource}; font-src ${cspSource}; form-action 'none'; base-uri 'none'`, with a fresh random nonce for each render;
  - `enableForms: false`, `enableCommandUris` off, and `localResourceRoots` set to the bundle folder only;
  - response content only through `textContent`;
  - masking on the extension side before anything is posted;
  - every message from the page checked against a schema, with events read by index only and never a URL, command id or path from the page;
  - messages capped in bytes and rows;
  - `setState` holding only interface state;
  - the benchmark commands registered only when `STREAMSCOPE_BENCHMARK=1` and the extension mode is not `Production`, never contributed, and accepting only `http://127.0.0.1` URLs.
- **Masking** (section 15): request headers in Headers, the history list, outcome texts and errors are masked. Response content (Events, Reply, Raw, Body, saved streams) is shown exactly as sent.
- **Performance** (`CLAUDE.md`):
  - nothing per event grows with the stream;
  - every long-lived buffer, queue, map and history has a bound that a unit test pins;
  - hot-path changes state their time and space cost in the PR description;
  - every performance claim is backed by a measurement.
- **Layers:** only `src/vscode/` and `src/extension.ts` import `vscode`. `src/webview/` is browser code: it imports only `src/response/panel-protocol.ts` and its own files, and uses `acquireVsCodeApi()`.
- **Transport:** `node:http`/`node:https` only. Never add headers.
- **No new dependency.**
- **Process:**
  - no code comments;
  - synthetic data only;
  - TDD;
  - branch `m6-response-view` from `origin/main` once PR #19 has merged, one commit per task;
  - push and pull request only with the user's go-ahead;
  - run `vscode-api-verifier` and `extension-security-reviewer` at the end.

## Decisions this plan makes (builder's call, approval of this plan approves them)

1. **The M5 record's open questions take its suggested answers:**
   - Body is drawn in the panel up to 1 MiB (the formatter's worker threshold), and an event inline up to 64 KiB. Above that, the panel shows a preview of the first 200 lines and an Open in Editor button; nothing opens automatically.
   - Headers is a panel tab with Open in Editor.
   - There is no "always show Body in an editor" setting.
   - Save Response covers searching every event of a stream (no Open Events in Editor snapshot).
   - Overflow documents stay readable by other extensions, as M2's are.
2. **The M2 documents become the overflow.**
   - `streamscope.showResponseBody` and `streamscope.showResponseHeaders` keep their ids and are retitled "Open Response Body in Editor" and "Open Response Headers in Editor".
   - Single events open as `/<n>/<label>/event-<index>.json` in the same `ResponseFileSystem`.
   - A send no longer opens the Body document by itself.
3. **What a run keeps in memory.**
   - The body is buffered (up to `maxBodyBytes`, 256 MiB, as in M2) only while the format is undecided or is `json`, `text` or `raw`. When the session decides `ndjson` or `sse`, the buffer is dropped and buffering stops.
   - Raw keeps the newest 2,097,152 characters of decoded text (`RawTail`), and Save Response writes the whole stream from the spill file.
4. **Backpressure.** `ResponseSink.onData` may return a promise. The transport then pauses its source (the decoder, or the socket when there is none) until the promise settles. Only the spill file uses this, as `CLAUDE.md` allows.
5. **Spill files** live in `<globalStorageUri>/spill`. `streamscope.stream.maxSpillSize` and `maxTotalSpillSize` apply when the extension activates, and their descriptions say a reload applies a change. Each run creates its spill file before it sends, and a run that never gets headers deletes it.
6. **Settings contributed now**, because they now do something:
   - `streamscope.stream.maxEventSize` (`"16MiB"`) and `streamscope.stream.memoryEvents` (10,000);
   - `streamscope.stream.maxSpillSize` (`"512MiB"`) and `streamscope.stream.maxTotalSpillSize` (`"2GiB"`);
   - `streamscope.stream.typeFields` (`["type", "event", "object"]`);
   - `streamscope.view.default` (`"events"`, one of `events`, `reply`, `raw`).

   Sizes are strings matching `^\d+(KiB|MiB|GiB)$`. `stream.idleTimeout` waits for the timeout work in M10, because nothing would use it yet.

7. **The remembered view** is the last tab the user picked on a streaming response, kept in `globalState` under `streamscope.view.last`, and starts at `streamscope.view.default`. A non-streaming response opens on Body. A response whose format is decided only after the panel opens (NDJSON labelled `application/json`) switches from Body to the remembered view when the session decides `ndjson` or `sse`, unless the user picked a tab first.
8. **Captured values and Checks.**
   - The captured-values strip is not drawn until M7 gives it values.
   - Checks shows "No checks for this request." until M9.
   - The click-to-capture entry point waits for M8.
9. **History.**
   - `RunHistory` keeps the newest 50 runs of the session.
   - Evicting a run releases its spill file and in-memory events.
   - A run not shown in an open panel drops its in-memory events (`EventStore.release()`) and is read back from the spill file.
   - Show History reopens a run in a read-only panel titled with the run's label and time.
10. **Accessibility from the palette.** `streamscope.showResponseView` switches the active response's tab (argument, or a quick pick), and `streamscope.showResponse` reveals the panel of the request under the cursor. Every panel action is also a command.
11. **Hooks for the tests and the benchmark.**
    - In `Test` mode only, `streamscope.test.responseState` returns the panel state that integration tests check.
    - In development and test mode with `STREAMSCOPE_BENCHMARK=1`, the panel registers the two benchmark commands from `src/benchmark/contract.ts`.
    - `StreamBenchmarkResult` gains `longestTaskMs` and `tasksOverBudget`, which measure Streamscope's own synchronous work per update and per message. That is what the section 3 rule is about, and it separates Streamscope's pauses from the host's.
12. **The VoiceOver check is a manual step for the user.** The plan provides the checklist, and keyboard-only use and the three themes are checked by the executor through walkthrough screenshots.

## Review Focus

1. **A stream that runs for hours.**
   - The panel's DOM, the extension's queues, the raw tail and the history stay bounded.
   - Nothing per event grows with the stream.
   - Task 3 pins the raw tail, Task 4 the history, and Task 5 the message caps. Task 12's 30-minute run at 1,000 events/s measures it.
2. **The panel closed, hidden or reloaded mid-stream.**
   - The run keeps going.
   - Revealing the panel again, from the CodeLens or Show Response, shows every event so far.
   - A reloaded page gets the full state.

   Task 7 pins this with "reopening a closed panel mid-stream shows the events received so far".

3. **Re-sending while the previous stream is still running** (FR-S1).
   - The earlier run stops, the panel resets to the new run, and the old run stays in history with its events.
   - The new run's updates never mix with the old run's.

   Task 7 pins this with "re-sending a running stream resets the panel to the new run".

4. **Hostile or broken content in the list.**
   - Control and bidirectional override characters in labels and previews are removed.
   - Invalid UTF-8, malformed and oversize events show as marked rows.
   - Nothing from the response is ever parsed as HTML.

   Task 5 pins this with "removes control and bidi characters from labels and previews", and Task 6 with the `textContent`-only rule.

5. **A connection that fails mid-stream** (section 16).
   - The status shows the failure and its cause.
   - Every event received so far stays visible and can be saved.

   Task 7 pins this with "a stream that breaks mid-way keeps its events and shows the failure".

---

### Task 1: Stream and view settings

**Files:**

- Create: `src/runs/size.ts`, `test/unit/runs/size.test.ts`
- Modify: `package.json` (settings), `src/vscode/requests/settings.ts`, `test/unit/manifest.test.ts`

**Interfaces:**

- Produces:
  - `parseSize(text: string): number | undefined`, accepting `^\d+(KiB|MiB|GiB)$` and returning bytes;
  - `readStreamSettings(uri: vscode.Uri): { ok: true; limits: StreamLimits } | { ok: false; message: string }`, which merges `maxEventSize`, `memoryEvents` and `typeFields` into `defaultStreamLimits`;
  - `readSpillLimits(): { ok: true; limits: SpillLimits } | { ok: false; message: string }`;
  - `readDefaultView(): 'events' | 'reply' | 'raw'`.
- An invalid value gives the message `streamscope.stream.<name> must be a size such as 512KiB, 16MiB or 2GiB, not "<value>".`

- [ ] **Step 1: Write the failing tests**
  - `parseSize`: `'16MiB'` → 16,777,216; `'512KiB'` → 524,288; `'2GiB'` → 2,147,483,648; `'16 MiB'`, `'16mb'`, `'-1MiB'` and `''` → `undefined`.
  - `manifest.test.ts` adds a test "contributes stream and view settings with their defaults". It checks the six settings, their defaults from decision 6, `pattern` on the size settings, `minimum: 100` on `memoryEvents`, and `enum` on `view.default`.
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/runs/size.test.ts test/unit/manifest.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement `parseSize`, the three readers and the settings**
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Contribute the stream and view settings`

### Task 2: Transport backpressure

**Files:**

- Modify: `src/transport/model.ts`, `src/transport/node-transport.ts`
- Test: `test/unit/transport/exchange.test.ts`

**Interfaces:**

- Produces: `ResponseSink.onData(chunk: Uint8Array): Promise<void> | undefined`.
  - When it returns a promise, no further `onData` call happens until the promise settles.
  - The transport pauses the decoder's output when there is a decoder, and the socket otherwise. Cancellation while paused still settles as `cancelled`.

- [ ] **Step 1: Write the failing tests**
  - "pauses reading while the sink waits":
    - a local server sends 256 KiB in 16 KiB writes;
    - the sink returns a pending promise from its first call and records each call;
    - after 200 ms there is exactly 1 call;
    - after the promise resolves, every byte arrives and the outcome is `completed`.
  - "pauses a compressed response while the sink waits": the same with `Content-Encoding: gzip`.
  - "cancels a response while the sink waits": aborting while paused gives `cancelled` within 1 s, and the server sees the socket closed.
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/transport/exchange.test.ts`
  Expected: the pause tests FAIL, because calls keep coming.

- [ ] **Step 3: Implement the pause and resume in `deliver`, and update every existing sink** (the soak benchmark, tests): return `undefined`.
- [ ] **Step 4: Run the transport tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Let the response sink pause the transport`

### Task 3: Runs that stream

**Files:**

- Create: `src/runs/raw-tail.ts`, `test/unit/runs/raw-tail.test.ts`
- Modify:
  - `src/runs/run.ts`, `src/runs/registry.ts`;
  - `src/response/labels.ts` (`describeOutcome`);
  - `src/vscode/requests/register.ts` (open the `SpillArea` at activation, pass limits);
  - `src/extension.ts`.
- Test: `test/unit/runs/run.test.ts`, `test/unit/response/labels.test.ts`

**Interfaces:**

- Consumes: Task 1's readers; Task 2's sink contract; M4's `StreamSession`, `SpillArea` and `StreamDirective`.
- Produces:
  - `RawTail`:

    ```ts
    export class RawTail {
      constructor(maxChars: number);
      push(chunk: Uint8Array): void;
      end(): void;
      get text(): string;
      get generation(): number;
      get trimmed(): boolean;
    }
    ```

    When the text passes `maxChars`, it keeps the newest half, starting at a line start, and `generation` increases.

  - `RunInput` gains `spill: SpillArea` and `limits: StreamLimits`. The directive comes from the request's last `# @stream`.
  - `RunSnapshot` gains `stream: StreamSession | undefined`, `raw: RawTail` and `bodyKept: boolean`. `body` stays the buffered body for non-event formats, and is empty for streams.
  - `RunHandle` gains `onUpdate(listener: () => void): () => void`, fired on every session batch and every status change, and `release(): Promise<void>`, which disposes the session and deletes the spill file.
  - `describeOutcome`:
    - while running, `Running · 34 events · 2.1 s`;
    - for a completed stream, `200 OK · 120 events · 4.3 s`;
    - for a completed non-stream, as today.
  - The `SpillArea` opens at activation in `<globalStorageUri>/spill` with `readSpillLimits()` and is disposed on deactivate.

- [ ] **Step 1: Write the failing tests**
  - `raw-tail.test.ts`:
    - "keeps text below the limit whole";
    - "keeps the newest half from a line start once over the limit and counts generations" (limit 64: pushing 100 characters over 10 lines leaves at most 64 characters, starting after a `\n`, with `generation` 1);
    - "decodes a character split across chunks";
    - "never holds more than twice the limit" (1,000 random pushes; `text.length <= 2 × limit` after every push).
  - `run.test.ts`, using `startStreamServer`:
    - "feeds a stream session while receiving": `onUpdate` fires before the run completes; `snapshot().stream.store.count` grows; after completion it is `floor(rate × seconds) + 2`.
    - "keeps no body for an NDJSON stream labelled application/json": the `type=application/json` query of the stream server; `bodyKept` is `false` and `body.length` is `0`, while `stream.format.format` is `ndjson`.
    - "keeps the body of a JSON response": a 10 KiB JSON body; `bodyKept` is `true` and the body is byte-identical.
    - "keeps the events received before Stop": cancel after `count >= 5`; the status is `cancelled` and `count` is unchanged after 200 ms.
    - "deletes the spill file of a run that never got headers": a refused connection; the spill directory has no files afterwards.
    - "pauses the transport while the spill file is behind": a fake `SpillArea` whose file returns `false` from `append` and drains after 100 ms; `onData` returned a promise, and every event still arrives.
  - `labels.test.ts`: the two new outcome texts.
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/runs test/unit/response/labels.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  - The run creates the spill file before `transport.send`.
  - At `onHead` it builds the session with the response `Content-Type`, the directive and the limits, and fires `onUpdate` on each `onUpdate` of the session.
  - `onData`:
    - pushes into `RawTail`;
    - buffers the body per decision 3;
    - calls `session.write`; when that returns `false`, it returns a promise that resolves on `session.onDrain`.
  - At the end: `session.end()` when completed, `session.stop()` otherwise, then the spill file finishes.
  - Stop goes through the existing `cancel()`. The session is never stopped from inside a parser callback.
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS. M2's run, presenter and integration tests still pass, because nothing in the view has changed yet.

- [ ] **Step 5: Commit** `Stream responses through a session while they arrive`

### Task 4: Run history and releasing memory

**Files:**

- Create: `src/runs/history.ts`, `test/unit/runs/history.test.ts`
- Modify: `src/events/store.ts` (`release()`), `src/runs/run.ts` (`RunHandle.compact()`)
- Test: `test/unit/events/store.test.ts`

**Interfaces:**

- Produces:
  - `EventStore.release(): void`: empties the in-memory ring and its byte count; `inMemory` returns `undefined`; `read` falls back to the spill file; `count` and `summary` are unchanged.
  - `RunHandle.compact(): void`: calls `release()` on the run's store.
  - `RunHistory`:

    ```ts
    export class RunHistory {
      constructor(limit: number);
      add(run: RunHandle): void;
      list(): readonly RunHandle[];
      find(id: number): RunHandle | undefined;
      dispose(): Promise<void>;
    }
    ```

    `list` returns the newest first. The extension uses a limit of 50. Adding the 51st run calls `release()` on the oldest.

- [ ] **Step 1: Write the failing tests**
  - `store.test.ts` "releases in-memory events but keeps the index": after `release()`, `inMemory(1)` is `undefined`, `read(1)` returns the event from the spill file, and `count` is unchanged.
  - `history.test.ts`:
    - "keeps the newest runs, newest first";
    - "releases the oldest run when the limit is passed" (limit 2 with three fake handles; the first one's `release` was called once);
    - "never holds more than its limit" (100 adds, limit 50; `list().length` is 50).
  - `run.test.ts` "a compacted run reads its events from the spill file".
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/runs test/unit/events/store.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement** `release`, `compact` and `RunHistory`.
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Keep the last 50 runs and release memory that no view needs`

### Task 5: Panel protocol, rows and page HTML

**Files:**

- Create: `src/response/panel-protocol.ts`, `src/response/panel-rows.ts`, `src/response/panel-html.ts`
- Test: `test/unit/response/panel-protocol.test.ts`, `test/unit/response/panel-rows.test.ts`, `test/unit/response/panel-html.test.ts`

**Interfaces:**

- Produces, in `panel-protocol.ts` (pure, no Node or `vscode` imports, so the page can import it):

  ```ts
  export type PanelView = 'events' | 'reply' | 'raw' | 'headers' | 'body' | 'checks';
  export const panelViews: readonly PanelView[];
  export const panelLimits = {
    rowsPerMessage: 500,
    messageBytes: 1_048_576,
    inlineEventBytes: 65_536,
    inlineBodyBytes: 1_048_576,
    previewLines: 200,
    rawTailChars: 2_097_152,
    windowRows: 400,
  } as const;
  export type PanelEventKind = 'json' | 'text' | 'malformed' | 'oversize' | 'comment';
  export type PanelRunState =
    'sending' | 'receiving' | 'completed' | 'failed' | 'cancelled' | 'blocked';
  export interface PanelRow {
    index: number;
    time: string;
    label: string;
    preview: string;
    kind: PanelEventKind;
  }
  export interface PanelStatus {
    state: PanelRunState;
    text: string;
    running: boolean;
    events: number;
    warnings: number;
    format: string | undefined;
  }
  export interface TextDelta {
    reset: boolean;
    text: string;
  }
  export type PanelBody =
    | { kind: 'none' }
    | { kind: 'stream' }
    | { kind: 'text'; language: string; text: string }
    | { kind: 'preview'; language: string; text: string; totalBytes: number };
  export type ToPanel =
    | {
        type: 'reset';
        run: number;
        view: PanelView;
        readOnly: boolean;
        status: PanelStatus;
        headers: string;
        body: PanelBody;
      }
    | {
        type: 'update';
        run: number;
        status: PanelStatus;
        count: number;
        rows: PanelRow[];
        reply: TextDelta | undefined;
        raw: TextDelta | undefined;
        body: PanelBody | undefined;
        headers: string | undefined;
      }
    | { type: 'rows'; run: number; rows: PanelRow[] }
    | { type: 'detail'; run: number; index: number; text: string; truncated: boolean }
    | { type: 'select'; view: PanelView }
    | { type: 'expand'; index: number };
  export type FromPanel =
    | { type: 'ready' }
    | { type: 'window'; run: number; start: number; end: number; following: boolean }
    | { type: 'rendered'; run: number; newest: number }
    | { type: 'detail'; run: number; index: number }
    | { type: 'stop' }
    | { type: 'tab'; view: PanelView }
    | { type: 'open'; run: number; target: 'body' | 'headers' }
    | { type: 'openEvent'; run: number; index: number };
  export function parsePanelMessage(value: unknown, eventCount: number): FromPanel | undefined;
  ```

  The module defines its own unions, so the page's type check needs nothing from Node-side modules; a unit test checks that `PanelEventKind` and `PanelRunState` list the same values as `EventKind` and `RunStatus`. `parsePanelMessage` accepts only these shapes. Indexes must be whole numbers from 1 to `eventCount`, `start <= end`, and `end - start < panelLimits.windowRows`. It rejects any other key, value or type.

- In `panel-rows.ts`:
  - `displayText(text: string, maxLength: number): string` removes C0 and C1 controls except tab, U+2028/U+2029, and the bidirectional controls U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069, then cuts to `maxLength` without splitting a surrogate pair.
  - `panelRow(store: EventStore, index: number, event: StreamEvent | undefined): PanelRow` builds a row with a 200-character preview.
  - `capRows(rows: readonly PanelRow[], maxBytes: number): PanelRow[]` keeps the newest rows that fit.
  - `capText(text: string, maxBytes: number): { text: string; cut: boolean }`.
- In `panel-html.ts`: `panelHtml(options: { cspSource: string; scriptUri: string; nonce: string; title: string }): string`, with the CSP from the Global Constraints, one nonce'd `<style>` and one nonce'd `<script src>`. The title is escaped.

- [ ] **Step 1: Write the failing tests**
  - `parsePanelMessage`:
    - accepts each `FromPanel` shape;
    - rejects `{ type: 'detail', run: 1, index: 0 }`, `index: 11` with `eventCount` 10, `index: 1.5`, `{ type: 'open', target: '../x' }`, `{ type: 'tab', view: 'html' }`, a window of 401 rows, extra keys, `null`, strings and arrays.
  - `displayText`: "removes control and bidi characters from labels and previews" (`'A‮evil\u0000\u001b[31m'` → `'Aevil[31m'`); it cuts `'😀'.repeat(60)` to 100 without a lone surrogate.
  - `capRows` keeps the newest rows under the byte cap; `capText` cuts on a character boundary and sets `cut`.
  - `panelHtml`:
    - the CSP meta equals the Global Constraints policy with the given nonce and `cspSource`;
    - every `<script>` and `<style>` carries the nonce;
    - there is no `on…=` attribute;
    - a title `</title><script>` comes out escaped.
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/response`
  Expected: FAIL.

- [ ] **Step 3: Implement the three modules.**
- [ ] **Step 4: Run the tests and the gate**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 5: Commit** `Add the response panel's protocol, rows and page shell`

### Task 6: The response page

**Files:**

- Create:
  - `src/webview/main.ts` (wiring the page together);
  - `src/webview/list-window.ts`, `src/webview/raw-colour.ts` (pure, tested);
  - `src/webview/tsconfig.json` (lib `es2023` plus `dom`, types none).
- Modify:
  - `tsconfig.json`: exclude `src/webview`;
  - `esbuild.mjs`: a second, browser IIFE build to `dist/response-view.js`;
  - `package.json`: `files` adds `dist/response-view.js`, and `typecheck` adds the webview tsconfig;
  - `test/unit/manifest.test.ts`: the shipped-files list.
- Test: `test/unit/webview/list-window.test.ts`, `test/unit/webview/raw-colour.test.ts`

**Interfaces:**

- Consumes: Task 5's protocol and limits.
- Produces:
  - `listWindow(input: { scrollTop: number; clientHeight: number; count: number; rowHeight: number; expanded: { index: number; height: number } | undefined; maxScrollPixels: number }): { first: number; last: number; spacerHeight: number; top(index: number): number }`. Above `maxScrollPixels` (8,000,000), scroll positions scale so the newest row is reachable, as the M5 prototype did.
  - `rawTokens(line: string): { kind: 'key' | 'string' | 'number' | 'literal' | 'field' | 'comment' | 'plain'; text: string }[]`. It colours JSON tokens, and SSE field names (`data`, `event`, `id`, `retry`) and comment lines.
- The page:
  - posts `ready` on load, `rendered` in the frame after each paint, and `window` only when the window or the following state changes;
  - builds every node with `textContent` and colours only from `--vscode-*` variables;
  - gives the list `role="listbox"` (Up, Down, Home, End, Enter, Escape) and the tab strip `role="tablist"` with arrow keys;
  - shows the status line with a `role="status"` announcement throttled to once every 2 s;
  - has buttons for Stop, Save, Open in Editor and Open Event in Editor;
  - keeps only `{ view, scroll }` in `setState`.

- [ ] **Step 1: Write the failing tests**
  - `listWindow`:
    - "shows the rows under the viewport";
    - "keeps the newest row reachable past eight million pixels" (count 1,000,000, row height 22; at the bottom scroll position `last` is 1,000,000);
    - "shifts rows after an expanded event by its height".
  - `rawTokens`:
    - `'{"type":"RUN_STARTED","n":1,"ok":true}'` gives key, string, number and literal tokens whose text joins back to the line;
    - `'data: {"a":1}'` starts with a `field` token;
    - `': keep-alive'` is one `comment` token.
- [ ] **Step 2: Run them to see them fail**

  Run: `npx vitest run test/unit/webview`
  Expected: FAIL.

- [ ] **Step 3: Implement the two pure modules, then `main.ts`** after the mockup and the M5 webview prototype (`git show 379b0d6:spike/webview/main.ts`). Do not reuse the prototype's message handling, per the decision record.
- [ ] **Step 4: Build and run the gate**

  Run: `npm run build && npm run check && npm run package:list`
  Expected: PASS, and the VSIX lists `dist/response-view.js`.

- [ ] **Step 5: Commit** `Add the response page`

### Task 7: The response panel in VS Code

**Files:**

- Create:
  - `src/vscode/response/panels.ts`;
  - `test/integration/response-panel.test.ts`.
- Modify:
  - `src/vscode/response/presenter.ts`: overflow documents only, plus event documents;
  - `src/vscode/requests/register.ts`: open the panel at headers; the new commands; Show Response; the test hook;
  - `package.json`: the commands and menus below, and the retitled commands;
  - `test/unit/manifest.test.ts`;
  - `test/integration/send.test.ts`, `test/integration/large-body.test.ts`: the M2 tests, retargeted at the panel and Open in Editor.

**Interfaces:**

- Consumes: Tasks 3 to 6.
- Produces:

  ```ts
  export interface ResponseState {
    key: string;
    run: number;
    view: PanelView;
    status: RunStatus;
    events: number;
    rendered: number;
    format: string | undefined;
    body: PanelBody['kind'];
    visible: boolean;
    readOnly: boolean;
  }
  export class ResponsePanels implements vscode.Disposable {
    show(
      run: RunHandle,
      documentUri: vscode.Uri,
      options: { reveal: boolean; readOnly: boolean },
    ): void;
    reveal(key: string): boolean;
    selectView(key: string, view: PanelView): void;
    state(key: string): ResponseState | undefined;
    active(): string | undefined;
    dispose(): void;
  }
  ```

- **One panel per request key** (FR-V8).
  - `show` creates the panel in `ViewColumn.Beside` with `preserveFocus`, or resets an existing one to the new run.
  - It uses the webview options and HTML from the Global Constraints and Task 5, with `retainContextWhenHidden: false`.
  - The run is subscribed with `onUpdate`. Each update posts at most one `update`:
    - the newest rows while following, or the requested window;
    - Reply and Raw deltas only while that tab is visible;
    - Body once it is formatted (off thread, as M2);
    - masked Headers.
  - Messages are checked with `parsePanelMessage`, and anything that fails is dropped.
  - `ready` gets a full `reset` (a reloaded page).
  - `tab` saves the remembered view (decision 7).
  - `stop` cancels the run.
  - `open` and `openEvent` call the presenter.
  - Closing the panel never stops the run. When a run is no longer shown, `compact()` is called on it.
- **Commands** (all with the category `Streamscope`):
  - `streamscope.showResponse` "Show Response";
  - `streamscope.showResponseView` "Switch Response View…";
  - the retitled `streamscope.showResponseBody` "Open Response Body in Editor" and `streamscope.showResponseHeaders` "Open Response Headers in Editor".
  - An editor title action **Show Response** appears on `streamscope-response` documents.
  - Editor title actions **Stop**, **Save Response** and **Open Response Body in Editor** appear when `activeWebviewPanelId == 'streamscope.response'`.
- In `Test` mode only, `streamscope.test.responseState(key?: string)` returns `ResponseState`.

- [ ] **Step 1: Write the failing integration tests** in `response-panel.test.ts`, using `startStreamServer` and a `.http` document in a temporary folder:
  - "opens the panel when the headers arrive, before the stream ends": `state.status` is `receiving` while `rendered >= 10`.
  - "streams NDJSON labelled application/json live": the `type=application/json` stream; `format` starts with `NDJSON (detected`, and `view` is `events` while still `receiving`.
  - "switching views mid-stream keeps everything": switch to `reply`, `raw`, `headers`, `body`, then back to `events` while streaming; at the end `events` and `rendered` equal the expected count.
  - "Stop ends the run with partial data visible": `streamscope.stopRequest`; the status is `cancelled`, `events` is greater than 0 and stays unchanged, and `rendered` equals `events`.
  - "re-sending a running stream resets the panel to the new run": `run` changes, the old run is `cancelled` in the registry, and `rendered` restarts below the old count.
  - "reopening a closed panel mid-stream shows the events received so far": close the panel tab, then `streamscope.showResponse`; `rendered` catches up to `events`.
  - "a stream that breaks mid-way keeps its events and shows the failure": the raw server's premature close; the status is `failed` and `events` is greater than 0.
  - "a large body shows a preview and opens in the editor": a 2 MiB JSON body; `state.body` is `preview`, and `streamscope.showResponseBody` opens the `.json` document with the full pretty text.
  - Retarget the M2 tests. Body content is checked through `streamscope.showResponseBody`, and the 50 MB test measures the send (panel) and then Open in Editor against VS Code's own open. The assertions on content, masking, redirects, saving, CA and the formatting race stay the same.
- [ ] **Step 2: Run them to see them fail**

  Run: `npm run test:integration -- --label stable`
  Expected: the new tests FAIL, because there is no panel.

- [ ] **Step 3: Implement `ResponsePanels`, the presenter changes, the commands, menus and the test hook.**
- [ ] **Step 4: Run the integration tests on both VS Code versions, and the gate**

  Run: `npm run check && npm run test:integration`
  Expected: PASS on 1.101.0 and stable.

- [ ] **Step 5: Run `vscode-api-verifier`** on `src/vscode/response/` and the manifest, and fix its findings.
- [ ] **Step 6: Commit** `Show every response in a live panel with editor documents as overflow`

### Task 8: Saving streams

**Files:**

- Modify: `src/events/spill.ts` (`copyTo`), `src/vscode/requests/register.ts` (`saveResponse`), `src/response/labels.ts` (`saveExtension`)
- Test: `test/unit/events/spill.test.ts`, `test/unit/response/labels.test.ts`, `test/integration/response-panel.test.ts`

**Interfaces:**

- Produces:
  - `SpillFile.copyTo(file: string): Promise<'complete' | 'capped' | 'unavailable'>`. It copies the saved bytes with streams in 1 MiB reads, never holding more than that in memory. It returns `capped` when the cap cut the file and `unavailable` when the file was evicted or removed.
  - `saveExtension(contentType, format?: StreamFormat)` gives `.ndjson` or `.sse` for those formats.
  - Save Response on a stream writes the spill file to the chosen file. A capped copy shows the warning `Saved the first <size> of the stream; the rest was not kept (streamscope.stream.maxSpillSize).` Destinations that are not `file:` get the error `Save the stream to a local folder.`

- [ ] **Step 1: Write the failing tests**
  - `spill.test.ts`: "copies a finished spill file in bounded reads" (a 5 MiB file; byte-identical copy); "reports a capped copy"; "reports an evicted file as unavailable".
  - `labels.test.ts`: the `.ndjson` and `.sse` extensions.
  - Integration: "saves a stream as .ndjson with every event"; the saved file has `expected count` lines, each valid JSON.
- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the gate and the integration tests**

  Run: `npm run check && npm run test:integration -- --label stable`
  Expected: PASS.

- [ ] **Step 5: Commit** `Save streams as .ndjson or .sse from the spill file`

### Task 9: Live state in the CodeLens and the status bar

**Files:**

- Create: `src/vscode/requests/status-bar.ts`
- Modify: `src/vscode/requests/code-lens.ts`, `src/vscode/requests/register.ts`, `package.json` (no new command)
- Test: `test/integration/send.test.ts`, `test/integration/response-panel.test.ts`

**Interfaces:**

- **CodeLens** above a running request: `Stop` and `Running · 34 events · 2.1 s`. After the run: `Send Request` and the outcome, which reveals the panel (section 13). The 1 s refresh of M2 stays, and the lenses also refresh on run status changes.
- **`RunStatusBar`:**
  - shown only while runs are active;
  - with one run, the text is `$(debug-stop) <label> · 34 events` and clicking it stops the run;
  - with several, the text is `$(debug-stop) <n> running` and clicking it opens a quick pick of running requests to stop;
  - the tooltip and texts are masked.

- [ ] **Step 1: Write the failing tests**
  - "shows Stop and the live event count in the CodeLens while streaming";
  - "the outcome lens reveals the response panel";
  - "shows the running request in the status bar and stops it from there". The `streamscope.test.responseState` hook adds a `statusBar: string | undefined` field for this.
- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the gate and the integration tests**

  Run: `npm run check && npm run test:integration -- --label stable`
  Expected: PASS.

- [ ] **Step 5: Commit** `Show live run state in the CodeLens and the status bar`

### Task 10: Show History

**Files:**

- Modify: `src/vscode/requests/register.ts`, `src/vscode/response/panels.ts`, `package.json` (the command `streamscope.showHistory` "Show History")
- Test: `test/integration/response-panel.test.ts`, `test/unit/manifest.test.ts`

**Interfaces:**

- Every started run is added to the `RunHistory(50)` of Task 4.
- **The quick pick:**
  - newest first;
  - each item has the label and the masked title, `status · events · duration`, and the time of day;
  - picking an item shows that run in a read-only panel: no Stop, title `<label> · <hh:mm:ss>`.
- **When a run has left history:** its panel says "This run is no longer in history." and Open in Editor is disabled.

- [ ] **Step 1: Write the failing tests**
  - "lists the runs of the session, newest first": `streamscope.showHistory` accepts an optional run id for tests and returns the list.
  - "reopens an earlier run read-only with its events" (the hook reports `readOnly` and `events`).
- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the gate and the integration tests**

  Run: `npm run check && npm run test:integration -- --label stable`
  Expected: PASS.

- [ ] **Step 5: Commit** `Add Show History for the last 50 runs`

### Task 11: The benchmark surface and theme walkthroughs

**Files:**

- Modify:
  - `src/benchmark/contract.ts` (`longestTaskMs`, `tasksOverBudget`);
  - `src/vscode/response/panels.ts`, `src/vscode/requests/register.ts` (the benchmark commands);
  - `test/benchmark/view/runner.ts`, `test/benchmark/main.ts` (`--theme`);
  - `test/benchmark/view/results.ts`.
- Test: `test/unit/benchmark/contract.test.ts`, `test/unit/benchmark/launch.test.ts`, `test/unit/benchmark/results.test.ts`

**Interfaces:**

- **The benchmark commands.** In development and test mode with `STREAMSCOPE_BENCHMARK=1`, the extension registers `streamscope.benchmark.stream` and `streamscope.benchmark.walkthrough`.
  - Both refuse URLs other than `http://127.0.0.1:<port>/…` with an error.
  - They send a `GET` through the real registry and panel, built from the parsed text `GET <url>` in an untitled `.http` document.
  - Latency comes from the panel's `rendered` messages, as in M5.
  - A `TaskTimer` measures each panel update and each message handled, and reports the longest and the count over 50 ms.
- **`--theme <name>`** writes `workbench.colorTheme` into the throwaway profile. Accepted: `"Default Dark Modern"`, `"Default Light Modern"`, `"Default High Contrast"`, `"Default High Contrast Light"`.

- [ ] **Step 1: Write the failing tests**
  - `contract.test.ts` checks the new result fields.
  - `launch.test.ts` "writes the requested theme into the profile settings", for a pure `profileSettings(theme?: string)` helper.
  - `results.test.ts` keeps all of M5's checks.
- [ ] **Step 2: Run them to see them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the gate and smoke-test the benchmark**

  Run: `npm run check && npm run bench -- view --surface m6 --minutes 0.5`
  Expected:
  - no `error`;
  - 15,002 events, all visible and timed;
  - `longestTaskMs` reported.

- [ ] **Step 5: Commit** `Measure the response panel with the view benchmark`

### Task 12: Measurements, manual passes and documentation

**Files:**

- Modify:
  - `docs/benchmarks.md` (an M6 section);
  - `CLAUDE.md`: a layout row for `src/webview/`, and the `src/response/` and `src/vscode/` rows;
  - `docs/design.md`: only where the built behaviour differs (none expected);
  - `docs/decisions/response-surface/` (new screenshots, at most 6).

- [ ] **Step 1: The 30-minute runs, one at a time in the background**
  - `npm run bench -- view --surface m6 --rate 500 --size 1024 --minutes 30`, for the latency and responsiveness budgets;
  - `npm run bench -- view --surface m6 --rate 1000 --size 1024 --minutes 30`, for the memory budget as section 3 defines it.

  Expected: no `error`; p95 under 100 ms; `tasksOverBudget` 0; heap plus index under 150 MB.

  If a budget fails, find the cause with a `node --cpu-prof` profile of the extension host (`--inspect-extensions`), fix it with a test, and rerun. Record extension host pauses that are not Streamscope's (`tasksOverBudget` 0 while the driver sees pauses) as VS Code's.

- [ ] **Step 2: Theme and keyboard walkthroughs**
  - Run `npm run bench -- view --walkthrough --surface m6 --theme "<theme>"` for each of the four themes.
  - Check every screenshot for readable text and visible focus, and commit at most 6 at 1280 px under 250 KB.
  - Also go through the page by keyboard only: tab strip, list, detail, Stop, Open in Editor.
- [ ] **Step 3: Write the VoiceOver checklist for the user** in the PR description:
  - the panel is announced;
  - the tabs read as tabs;
  - the list reads as a list and announces the selected event;
  - the status line announces state changes no more than every 2 s;
  - Open in Editor gives the screen-reader-friendly document.
- [ ] **Step 4: Record the runs** in `docs/benchmarks.md`, in the M5 table's shape, and update `CLAUDE.md`. Then run the gate.

  Run: `npm run check && npm run test:integration && npm run test:restricted && npm run verify:vsix`
  Expected: all PASS, and the VSIX stays under 400 KB.

- [ ] **Step 5: Commit** `Record the M6 measurements`

### After the tasks

- **Final review:** a fresh whole-branch review on the most capable model, plus:
  - `extension-security-reviewer`: the panel, message validation, masking, spill copies and the test and benchmark hooks;
  - `vscode-api-verifier`: everything that imports `vscode`, and the manifest.
- **Then:** one fix pass, and the push and pull request on the user's go-ahead. The PR description states the time and space cost of each hot-path change.
