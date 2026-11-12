# M4 Streaming Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bytes in, correct events out, at speed and with bounded memory. M4 delivers the streaming engine, which is not yet visible in the UI.

**Architecture:**

- `src/streaming` (stream framing and parsing):
  - a byte-level line framer;
  - per-line UTF-8 decoding;
  - NDJSON and SSE interpreters;
  - a format detector that can upgrade single JSON to NDJSON;
  - a `StreamParser` that wires them together and reports formats, events, text and warnings to a sink.
- `src/events` (event processing):
  - the event model and labels;
  - reply adapters;
  - the spill area and files;
  - the event store (an in-memory ring buffer plus a compact index of every event);
  - the update batcher;
  - a `StreamSession` that M5 will feed with the transport's decompressed chunks.
- Neither folder imports `vscode`. Nothing is wired into the extension yet.
- A synthetic stream server and a benchmark harness under `test/` measure throughput, memory and lag.

**Tech Stack:** TypeScript 6.0.3, `node:fs`, `TextDecoder`, `JSON.parse` source-text access, Vitest 5, esbuild (benchmark bundle). One new dev dependency, already approved in the roadmap: `eventsource-parser@4.1.3`, the SSE reference used in tests only.

**Spec:** `docs/design.md` sections 3 (memory, latency and reliability budgets), 7 (streaming pipeline), 8 (NDJSON and SSE parsing), 9 (event processing), 17 (performance) and 18 (byte-boundary testing); `docs/roadmap.md` M4.

## Global Constraints

- **Layers.** `src/streaming` and `src/events` import only Node built-ins and each other: no `vscode`, no `src/vscode`, no `src/response`. `src/streaming` may import `src/events/model.ts` and `src/events/label.ts`.
- **No new runtime dependency.** `eventsource-parser` is a dev dependency, imported only under `test/`. `.npmrc`'s `min-release-age=7` allows 4.1.3, released 2026-10-25.
- **Limits** (`src/streaming/limits.ts`):

  | Export                                | Value                         | Future setting                         |
  | ------------------------------------- | ----------------------------- | -------------------------------------- |
  | `defaultStreamLimits.maxEventSize`    | 16,777,216 bytes (16 MiB)     | `streamscope.stream.maxEventSize`      |
  | `defaultStreamLimits.memoryEvents`    | 10,000                        | `streamscope.stream.memoryEvents`      |
  | `defaultStreamLimits.memoryBytes`     | 16,777,216 bytes              |                                        |
  | `defaultStreamLimits.typeFields`      | `['type', 'event', 'object']` | `streamscope.stream.typeFields`        |
  | `defaultStreamLimits.batchIntervalMs` | 50                            |                                        |
  | `sniffBytes`                          | 65,536                        |                                        |
  | `previewBytes`                        | 1,024                         |                                        |
  | `maxLabelLength`                      | 100                           |                                        |
  | `maxLabels`                           | 4,096                         |                                        |
  | `maxReplyLength`                      | 1,048,576 characters          |                                        |
  | `defaultSpillLimits.maxFileSize`      | 536,870,912 bytes (512 MiB)   | `streamscope.stream.maxSpillSize`      |
  | `defaultSpillLimits.maxTotalSize`     | 2,147,483,648 bytes (2 GiB)   | `streamscope.stream.maxTotalSpillSize` |
  | `defaultSpillLimits.writeBufferBytes` | 4,194,304 bytes (4 MiB)       |                                        |

  The settings are contributed in M6, when they first do something. M4 takes these values as defaults.

- **Event model** (design section 9) is the contract for M5 to M9. Its shape is fixed in Task 2.
- **Never trust `Content-Type` alone and never add headers.** M4 reads only the response's `Content-Type` and the `# @stream` argument (`sse`, `ndjson`, `json`, `text`, `raw`, `auto`, as validated in `src/http-file/directives.ts`).
- **Resources.** Everything that holds a timer, file handle or stream releases it on every exit path: end, stop and dispose. After `stop()`, nothing is emitted.
- **Byte-boundary rule.** Each fixture must give identical results when split at every byte boundary and one byte at a time. The splits must land inside multi-byte characters, CRLF pairs, a leading BOM and 16-digit numbers.
- **Process.**
  - No code comments, TDD for all code.
  - Work happens on branch `m4-streaming` from `origin/main`, one commit per task. Push and pull request only with the user's go-ahead.
  - The failing tests of Tasks 2 to 5 are written by dispatching the `stream-parser-test-author` agent with that task's test list. The implementer checks that they match the list before running them.
  - Synthetic data only: `thread-1`, `run-1`, `msg-1`, `chatcmpl-synthetic-1`, `synthetic-model`. No real API responses and nothing from the private reference file.

## Decisions this plan makes (builder's call, approval of this plan approves them)

1. **Lines are framed on bytes, then each complete line is decoded.** Design section 7 decodes first, then frames. Framing first gives exact byte offsets, which the event model needs for the spill file. CR and LF never occur inside a UTF-8 multi-byte sequence, so a character split across chunks is rebuilt as the line accumulates. Invalid bytes still become U+FFFD. Lines are decoded with `ignoreBOM: true`, so only the one leading BOM is removed. Bodies that are not parsed into events (text, single JSON, raw) go through one streaming `TextDecoder`, as the design says.
2. **Detection decides as soon as it can, and corrects itself.**
   - A first non-empty line that is a complete JSON object or array makes the body single JSON, provisionally.
   - The next non-empty line upgrades it to NDJSON, and the first line becomes event 1.
   - Only lines starting with `{` or `[` count as JSON when sniffing, so a `text/plain` body of `42` or `true` stays text.
   - A pretty-printed body (first line `{` or `[` alone) is never upgraded, and neither is a body whose first line is longer than 64 KiB: once that much is pending without a newline, the body is shown as it arrives instead of being held.
   - The reason stays `detected` across the upgrade, so splitting the input never changes the final decision.
3. **Whitespace-only NDJSON lines are ignored** like empty ones.
4. **SSE details:**
   - `sse.id` is the `id` field of that event's own block, as in `eventsource-parser`, not the inherited last event ID. Streamscope never reconnects, so it shows what the server sent with each event.
   - Comment lines become `comment` events, with one leading space removed.
   - `[DONE]` data gets marker `done`; `event: error` gets marker `error`.
   - An event with an oversize line, or with more than `maxEventSize` bytes of data, becomes one `oversize` event.
5. **Large integers.** An integer outside the safe range becomes a `bigint` holding its exact digits. Only lines containing a run of 16 or more digits take the reviver path, so ordinary lines keep plain `JSON.parse` speed. M6 prints bigints with `JSON.rawJSON`.
6. **Retention:**
   - Every event keeps a compact index entry in typed-array blocks of 65,536 entries: time, offset, length, line, kind and label id, 27 bytes per event. That is about 49 MB for the 1.8 million events of the 30-minute benchmark. Spilling the index itself to disk is left for M11 if longer streams need it; design section 9 is updated to say so.
   - The ring buffer keeps at most the newest 10,000 events and 16 MiB of their raw bytes, and always keeps the newest event.
   - Labels are interned in a table of at most 4,096 labels of at most 100 characters. Once it is full, new labels are read back from the spill file on demand.
7. **Spill files:**
   - Each extension host process uses its own directory, `<root>/<pid>`. On opening, the spill area removes sibling directories whose process has exited, and empties its own.
   - Directories are created with mode `0o700` and files with `0o600`.
   - When a chunk would take a file over 512 MiB, that file stops growing and is marked `capped`.
   - When it would take the area over 2 GiB, the oldest other files are evicted first.
   - A file whose deletion fails is removed at the next start.
8. **Reply text** stops growing at 1,048,576 characters and is marked `truncated`.
9. **Backpressure** is signalled but not yet applied. `StreamSession.write` returns `false` when the spill file's buffer passes 4 MiB, and `onDrain` fires when it empties. Pausing the socket needs a transport change, which belongs to M5/M6, where the session meets the transport.
10. **The batcher is a leading-edge throttle.** An update after 50 ms or more of quiet goes out at once; later ones go at most every 50 ms; end, error and stop go at once.

## Review Focus

- **A chunk boundary changing the result:** CR at the end of one chunk and LF at the start of the next, a split multi-byte character, a split BOM, a split 20-digit number.
  - Task 5: byte-boundary suite over every fixture.
- **NDJSON labelled `application/json` whose first event arrives alone, followed by a pause.** It must upgrade to NDJSON, with the first line as event 1, not lost and not duplicated.
  - Task 5: tests `upgrades single JSON to NDJSON when a second line arrives later` and `keeps a lone JSON line as single JSON at end`.
- **A server that never sends a newline**, whether a 30 MB single-line JSON body or a misbehaving stream. Memory must stay bounded while sniffing and framing, and text mode must keep a long line whole.
  - Task 2: test `skips an oversize line and resynchronises at the next terminator`.
  - Task 5: test `streams a 20 MiB single-line JSON body as text without truncating it`.
- **A long stream outgrowing memory:** ring bytes, label table, reply text and spill caps. Reading an event whose raw bytes were capped or evicted must return `undefined`, not throw.
  - Tasks 6, 7 and 8: tests.
  - Task 10: the soak benchmark.
- **Leaked resources or late output:**
  - a batcher timer firing after end, stop or dispose;
  - a spill handle left open;
  - one window's start-up cleanup deleting another live window's spill files;
  - events emitted after `stop()`.
  - Tasks 5, 7 and 9: tests.

---

### Task 1: Reference parser, byte-boundary splitter and synthetic fixtures

**Files:**

- Modify: `package.json`, `package-lock.json` (dev dependency `eventsource-parser` `4.1.3`)
- Create: `test/support/chunks.ts`, `test/support/stream-fixtures.ts`
- Test: `test/unit/support.test.ts`

**Interfaces:**

- Produces:

```ts
export function everySplit(bytes: Uint8Array): Generator<Uint8Array[]>;
export function randomSplits(bytes: Uint8Array, seed: number, count: number): Uint8Array[][];
export interface StreamFixture {
  name: string;
  format: 'sse' | 'ndjson';
  contentType: string;
  bytes: Uint8Array;
}
export const streamFixtures: readonly StreamFixture[];
```

- `everySplit` yields the whole input, then every two-piece split at boundaries `1` to `length - 1`, then one-byte chunks.
- `randomSplits` uses a seeded PRNG (mulberry32), so failures reproduce.
- Fixtures, all synthetic:
  - `ag-ui.ndjson`, LF line endings:
    1. `RUN_STARTED` with `threadId` `thread-1` and `runId` `run-1`;
    2. `TEXT_MESSAGE_START` with `messageId` `msg-1`;
    3. four `TEXT_MESSAGE_CONTENT` events with deltas `Héllo`, `, wörld`, ` 🚀` and `✓`;
    4. `TEXT_MESSAGE_END`;
    5. `RUN_FINISHED`.
  - `ag-ui.sse`: the same events as `data:` blocks, with CRLF line endings.
  - `openai-chat.sse`:
    - three `chat.completion.chunk` events with id `chatcmpl-synthetic-1`, whose `choices[0].delta.content` values are `Hi`, ` there` and `null`, the last with `finish_reason` `stop`;
    - then `data: [DONE]`.
  - `openai-responses.sse`: `event:` and `data:` pairs for `response.created`, three `response.output_text.delta` events (`Syn`, `the`, `tic`) and `response.completed`.
  - `anthropic.sse`:
    1. `message_start`;
    2. `content_block_start`;
    3. `ping`;
    4. three `content_block_delta` events with `text_delta` values `Syn`, `the` and `tic`;
    5. `content_block_stop`;
    6. `message_delta`;
    7. `message_stop`.
  - `ollama.ndjson`: three `/api/chat`-shaped lines with `model` `synthetic-model` and `message.content` values `Syn`, `the` and `tic`, then a final line with `"done":true`.
  - `edge-cases.sse`, mixing LF, CR and CRLF line endings:
    - a leading BOM;
    - `: keep-alive`;
    - a three-line `data` event;
    - `data:no-space`;
    - `id: a\0b` with a NUL;
    - `retry: 10a`, then `retry: 3000`;
    - `event: error` with JSON data;
    - a bare `data` line;
    - a block with only `id: 7`;
    - a multi-byte data value;
    - a final `data: partial` with no blank line after it.
  - `edge-cases.ndjson`, with CRLF line endings, in this order:
    1. `{"type":"first"}`;
    2. an empty line;
    3. a line of two spaces;
    4. the malformed line `{"type":"broken",`;
    5. `{"type":"big","id":12345678901234567890}`;
    6. the array line `[1,2,3]`;
    7. `{"type":"last"}`, with no line ending.
  - `invalid-utf8.ndjson`: bytes `{"type":"bad","text":"` `0xC3 0x28` `"}` `\n`.

- [ ] **Step 1: Failing tests** in `support.test.ts`:
  - `splits at every boundary and reassembles the input`: for a 5-byte input, `everySplit` yields 1 + 4 + 1 = 6 chunkings. Each concatenates back to the input, and the two-piece splits cut at 1, 2, 3 and 4.
  - `random splits are reproducible and complete`: the same seed gives the same chunk sizes; every chunking reassembles the input; no chunk is empty.
  - `loads every stream fixture`: the 9 fixture names above. `ag-ui.sse` contains `\r\n`. `edge-cases.sse` starts with bytes `EF BB BF`.
  - `eventsource-parser parses the SSE fixtures`: feeding `openai-chat.sse` to `createParser` dispatches 4 events, the last with data `[DONE]`.
- [ ] **Step 2: Run** `npx vitest run test/unit/support.test.ts` — Expected: FAIL, modules missing.
- [ ] **Step 3: Install** with `npm install --save-dev eventsource-parser@4.1.3`. **Implement** `chunks.ts` and `stream-fixtures.ts`. Build fixture bytes with `TextEncoder`, except the invalid-UTF-8 bytes.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add the SSE reference parser, byte-boundary splitter and synthetic stream fixtures"`.

### Task 2: Event model, JSON parsing and the line framer

**Files:**

- Create: `src/events/model.ts`, `src/streaming/limits.ts`, `src/streaming/json.ts`, `src/streaming/framer.ts`
- Test: `test/unit/streaming/json.test.ts`, `test/unit/streaming/framer.test.ts`

**Interfaces:**

- Produces:

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type EventKind = 'json' | 'text' | 'malformed' | 'oversize' | 'comment';
export interface SseFields {
  event: string | undefined;
  id: string | undefined;
  retry: number | undefined;
}
export interface StreamEvent {
  index: number;
  time: number;
  offset: number;
  length: number;
  line: number;
  kind: EventKind;
  value: JsonValue;
  label: string | undefined;
  sse: SseFields | undefined;
  marker: 'done' | 'error' | undefined;
  error: string | undefined;
  unterminated: boolean;
}
export type ParsedEvent = Omit<StreamEvent, 'index' | 'time' | 'label'>;

export interface StreamLimits {
  maxEventSize: number;
  memoryEvents: number;
  memoryBytes: number;
  typeFields: readonly string[];
  batchIntervalMs: number;
}
export const defaultStreamLimits: StreamLimits;
export const sniffBytes: number;
export const previewBytes: number;
export const maxLabelLength: number;
export const maxLabels: number;
export const maxReplyLength: number;
export interface SpillLimits {
  maxFileSize: number;
  maxTotalSize: number;
  writeBufferBytes: number;
}
export const defaultSpillLimits: SpillLimits;

export function parseJson(
  text: string,
): { ok: true; value: JsonValue } | { ok: false; message: string };

export type FramedLine =
  | {
      kind: 'line';
      text: string;
      terminator: '' | '\n' | '\r' | '\r\n';
      offset: number;
      length: number;
      number: number;
      invalidUtf8: boolean;
    }
  | {
      kind: 'oversize';
      preview: string;
      terminator: '' | '\n' | '\r' | '\r\n';
      offset: number;
      length: number;
      number: number;
    };
export class LineFramer {
  constructor(maxLineBytes: number);
  push(chunk: Uint8Array): void;
  next(): FramedLine | undefined;
  end(): FramedLine | undefined;
  takeRemaining(): Uint8Array;
  get pendingBytes(): number;
}
```

- Value meanings:
  - `value` is the parsed JSON for `json` events.
  - For `text` and `comment` events it is the text.
  - For `malformed` events it is the line text, and `error` holds the parser's message.
  - For `oversize` events it is the preview.
- Framer semantics (pull model):
  - `push` stores a chunk; `next()` returns the next complete line, or `undefined` when it needs more bytes.
  - `end()` is called after `next()` returns `undefined`. It returns the final line: either one ended by a CR that was pending, or an unterminated one (terminator `''`).
  - `takeRemaining()` returns every unconsumed byte (the partial line plus the rest of the chunks) and stops framing.
  - `length` counts the line's bytes plus its terminator.
  - `number` is 1-based and counts every line.
  - A UTF-8 BOM at stream offset 0 belongs to no line, so the first line starts at offset 3.
  - When a line grows past `maxLineBytes`, the framer keeps only its first `previewBytes` bytes and discards the rest until the next terminator, then returns one `oversize` record. A multi-byte character cut by the preview limit is dropped, not replaced.
  - `invalidUtf8` is true only when the line's bytes are not valid UTF-8: the decoded text contains U+FFFD and a fatal decoder rejects the bytes.
- `parseJson`:
  - uses plain `JSON.parse` unless the text contains `/\d{16}/`;
  - otherwise uses a reviver that turns a number whose source text matches `/^-?\d+$/` and is not a safe integer into `BigInt(source)`;
  - types the reviver's third parameter locally as `{ source?: string }`, because `lib: es2023` lacks it.

- [ ] **Step 1: Failing tests** (via `stream-parser-test-author`):
  - **`json.test.ts`:**
    - `keeps the exact digits of integers beyond the safe range`: `{"id":12345678901234567890}` gives `id === 12345678901234567890n`.
    - `keeps safe integers and decimals as numbers`: `{"a":9007199254740991,"b":1.5,"c":1e21}` gives numbers.
    - `reports the parser message for invalid JSON`: `ok: false`, with a non-empty message.
    - `parses top-level strings, numbers, arrays and null`.
  - **`framer.test.ts`:**
    - `splits on LF, CRLF and lone CR with byte offsets and lengths`: `a\nbb\r\nc\rd` gives lines `a`, `bb`, `c` and `d`, at offsets 0, 2, 6 and 8, with lengths 2, 4, 2 and 1. `d` is returned by `end()` with terminator `''`.
    - `joins a CR at the end of one chunk with an LF at the start of the next`: chunks `a\r` and `\nb` give `a` with terminator `\r\n` and length 3. `end()` then gives `b`.
    - `treats a trailing CR as a terminator at end`: `a\r` alone gives `a` from `end()`, with terminator `\r`.
    - `rebuilds a multi-byte character split across chunks`: `é` (`C3 A9`) split between the two bytes gives `é`.
    - `skips a leading BOM even when it is split`: chunks `EF`, `BB BF 61 0A` give line `a` at offset 3.
    - `keeps a BOM that is not at the start of the stream`: `a\n` followed by BOM `b\n` gives a second line `﻿b`.
    - `skips an oversize line and resynchronises at the next terminator`: with `maxLineBytes` 8, input `0123456789ABCDEF\nok\n` fed in 3-byte chunks gives an `oversize` record with offset 0 and length 17, then line `ok` at offset 17. Bytes held never exceed `maxLineBytes` + 3.
    - `previews at most previewBytes and drops a cut multi-byte character`.
    - `flags invalid UTF-8 but not a literal U+FFFD`: bytes `C3 28 0A` set `invalidUtf8`; `EF BF BD 0A` does not.
    - `numbers every line including empty ones`.
    - `returns the unconsumed bytes and stops framing`: after `push('a\nbc')`, `next()` gives `a` and `takeRemaining()` gives `bc`.
- [ ] **Step 2: Run** `npx vitest run test/unit/streaming` — Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** the four files.
  - `LineFramer` finds terminators with `indexOf(0x0a)` and `indexOf(0x0d)` on the current chunk.
  - A line inside one chunk is decoded from a `subarray`, without copying. A line spanning chunks is joined once, when it completes.
  - One shared `TextDecoder('utf-8', { ignoreBOM: true })`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Frame stream bytes into lines with offsets, size limits and exact large integers"`.

### Task 3: NDJSON interpreter and event labels

**Files:**

- Create: `src/streaming/ndjson.ts`, `src/events/label.ts`
- Test: `test/unit/streaming/ndjson.test.ts`, `test/unit/events/label.test.ts`

**Interfaces:**

- Consumes: `FramedLine`, `ParsedEvent`, `parseJson`, `JsonValue`, `SseFields`, `maxLabelLength` (Task 2).
- Produces:

```ts
export function ndjsonEvent(line: FramedLine): ParsedEvent | undefined;
export function eventLabel(
  value: JsonValue,
  sse: SseFields | undefined,
  typeFields: readonly string[],
): string | undefined;
```

- `ndjsonEvent` returns `undefined` for empty and whitespace-only lines. `sse` and `marker` are `undefined`. `unterminated` is `line.terminator === ''`.
- `eventLabel` returns the first type field present on an object value whose value is a non-empty string, a number or a bigint, else `sse.event`. The result is cut to `maxLabelLength` characters.
- Test helper (in the test file): `frameAll(bytes, maxLineBytes)` runs a `LineFramer` over the bytes and returns every line, including the one from `end()`.

- [ ] **Step 1: Failing tests** (via `stream-parser-test-author`):
  - **`label.test.ts`:**
    - `uses the first configured type field`.
    - `falls back to the SSE event name`.
    - `ignores empty strings, objects and missing fields`.
    - `cuts long labels to 100 characters`.
  - **`ndjson.test.ts`:**
    - `parses each AG-UI line into a json event`: `ag-ui.ndjson` gives 8 events with `kind: 'json'`, lines 1 to 8, and `value.threadId === 'thread-1'` on the first.
    - `ignores empty and whitespace-only lines`.
    - `reports a malformed line with its line number, offset and message and continues`: in `edge-cases.ndjson`, the malformed event has `line: 4`, the right offset, its text as `value` and a non-empty `error`. The next line still parses.
    - `keeps the digits of a big integer`: the `big` event's `id` is `12345678901234567890n`.
    - `flags an unterminated final line`: `{"type":"last"}` has `unterminated: true`, and every other event has `false`.
    - `turns an oversize line into an oversize event with a preview`: with `maxLineBytes` 32, a 100-byte line gives `kind: 'oversize'`, `value` equal to the first bytes, and the next line parses.
- [ ] **Step 2: Run** `npx vitest run test/unit/streaming/ndjson.test.ts test/unit/events/label.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `ndjsonEvent` and `eventLabel`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Interpret NDJSON lines as events and label events by their type fields"`.

### Task 4: SSE interpreter

**Files:**

- Create: `src/streaming/sse.ts`
- Test: `test/unit/streaming/sse.test.ts`

**Interfaces:**

- Consumes: `FramedLine`, `ParsedEvent`, `parseJson`, `previewBytes` (Task 2).
- Produces:

```ts
export class SseInterpreter {
  constructor(maxEventBytes: number);
  line(line: FramedLine): ParsedEvent | undefined;
  end(): { offset: number; length: number } | undefined;
}
```

- Behaviour:
  - `line` returns a `comment` event for a `:` line, and the dispatched event at a blank line.
  - A block runs from the first line after the previous blank line to the end of the next blank line, including terminators. Its offset, length and first line number become the event's.
  - Field parsing follows WHATWG: the field name is everything before the first `:`, and one leading U+0020 is removed from the value. A line without `:` is a field with an empty value. Unknown fields are ignored.
  - `data` appends the value and `\n`. `event` sets the type. `id` is ignored if the value contains U+0000. `retry` must be ASCII digits only.
  - A block without data dispatches nothing, unless it is oversize.
  - Dispatch removes the final `\n` from the data. JSON data gives a `json` event; other data gives a `text` event.
  - `sse` is `{ event, id, retry }` from this block only.
  - Data `[DONE]` gets marker `done`. Event type `error` gets marker `error`.
  - `end()` returns the range of an undispatched block that has data, or `undefined`.

- [ ] **Step 1: Failing tests** (via `stream-parser-test-author`):
  - `dispatches events at blank lines with WHATWG field rules`, using `edge-cases.sse`:
    - the three data lines join with `\n`;
    - `data:no-space` keeps `no-space`;
    - the NUL id is ignored;
    - `retry: 10a` is ignored and `retry: 3000` gives `3000`;
    - the bare `data` line gives data `''`;
    - the id-only block dispatches nothing.
  - `reports comments as comment events`: `: keep-alive` gives `kind: 'comment'` and `value: 'keep-alive'`.
  - `marks [DONE] and error events`, using `openai-chat.sse` and `edge-cases.sse`.
  - `records each block's own id and event type`: an event after the `id: 7` block has `sse.id` `undefined`.
  - `reports an incomplete final event as discarded`: `end()` gives the offset and length of `data: partial`.
  - `turns an event over the size limit into one oversize event`: with `maxEventBytes` 32, ten `data:` lines of 10 bytes in one block give a single `oversize` event covering the block, and the next block parses.
  - `matches eventsource-parser on every SSE fixture`:
    - For each SSE fixture, our `json` and `text` events, as `{ event, id, value }`, equal `eventsource-parser`'s messages fed the decoded text, with each message's data passed through `parseJson`.
- [ ] **Step 2: Run** `npx vitest run test/unit/streaming/sse.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `SseInterpreter`. Data size counts the framed lines' `length`. Once a block is oversize, its data is dropped, and the preview is the first `previewBytes` of the block's first data value.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Interpret server-sent events following the WHATWG rules"`.

### Task 5: Format detection and the stream parser

**Files:**

- Create: `src/streaming/detect.ts`, `src/streaming/parser.ts`
- Test: `test/unit/streaming/detect.test.ts`, `test/unit/streaming/parser.test.ts`, `test/unit/streaming/byte-boundaries.test.ts`

**Interfaces:**

- Consumes:
  - `LineFramer`, `parseJson` and the limits (Task 2);
  - `ndjsonEvent` and `eventLabel` (Task 3);
  - `SseInterpreter` (Task 4).
- Produces:

```ts
export type StreamFormat = 'sse' | 'ndjson' | 'json' | 'text' | 'raw';
export type StreamDirective = StreamFormat | 'auto';
export interface FormatDecision {
  format: StreamFormat;
  reason: 'directive' | 'content-type' | 'detected';
  contentType: string | undefined;
}
export function mediaType(contentType: string | undefined): string | undefined;
export function classifyContentType(
  contentType: string | undefined,
): 'sse' | 'ndjson' | 'text' | 'sniff';
export function formatLabel(decision: FormatDecision): string;

export type StreamWarning =
  | { kind: 'invalid-utf8'; offset: number }
  | { kind: 'discarded-event'; offset: number; length: number };
export interface StreamSink {
  format(decision: FormatDecision): void;
  event(event: StreamEvent): void;
  text(text: string): void;
  warning(warning: StreamWarning): void;
}
export interface StreamParserOptions {
  contentType: string | undefined;
  directive: StreamDirective | undefined;
  maxEventSize: number;
  typeFields: readonly string[];
  now: () => number;
}
export class StreamParser {
  constructor(options: StreamParserOptions, sink: StreamSink);
  push(chunk: Uint8Array): void;
  end(): void;
  stop(): void;
}
export function parseEventBytes(
  bytes: Uint8Array,
  format: 'sse' | 'ndjson',
  options: { maxEventSize: number; typeFields: readonly string[] },
): Omit<StreamEvent, 'index' | 'time'> | undefined;
```

- **Content types:**
  - `mediaType` lowercases the value and drops parameters.
  - `text/event-stream` → `sse`.
  - `application/x-ndjson`, `application/jsonl`, `application/json-lines`, `application/stream+json` → `ndjson`.
  - `application/json`, `text/plain`, `application/octet-stream` or no value → `sniff`.
  - Anything else → `text`.
- **Labels** (`formatLabel`), with names `SSE`, `NDJSON`, `JSON`, `Text`, `Raw`:
  - directive: `SSE (# @stream sse)`;
  - content type: `SSE (server said text/event-stream)`;
  - detected: `NDJSON (detected; server said application/json)` or `Text (detected; no Content-Type)`.
- **Decision order:**
  1. A directive other than `auto` wins.
  2. Then the content-type class.
  3. Then sniffing. While sniffing, framed lines are kept so they can be replayed.
- **Sniffing** looks at the first line that is not empty or whitespace-only:
  - It starts with `data:`, `event:`, `id:`, `retry:` or `:`, with no trimming → `sse`. Every kept line, blank ones included, is replayed to the SSE interpreter.
  - Its trimmed start is `{` or `[` → `json`.
    - If the line is a complete JSON object or array, the body can be upgraded: the line is held.
    - Otherwise the parser switches to text mode.
  - Anything else → `text`.
  - If `sniffBytes` are pending before that line completes, the parser decides from the partial line's prefix: an SSE prefix gives `sse`; a trimmed `{` or `[` gives `json` in text mode, which is never upgraded; anything else gives `text`. The framer never holds more than `sniffBytes` plus one chunk of an undecided body.
  - An empty body decides `text` at `end()`.
- **Upgrade.** In upgradeable `json`, the next non-empty line emits `format({ format: 'ndjson', reason: 'detected', … })`, then the held line as event 1, then that line as NDJSON. `json` from a directive never upgrades.
- **Text mode** is used for `text`, `raw` and non-upgradeable `json`:
  - The kept lines are emitted as `text` (text plus terminator), then `takeRemaining()` and every later chunk go through one streaming `TextDecoder('utf-8', { ignoreBOM: true })`.
  - When the decision comes before any byte, the decoder uses `ignoreBOM: false`.
  - The decoder is flushed at `end()`.
  - In text mode, `invalid-utf8` is reported the first time a decoded piece contains U+FFFD.
- **Events** get `index` (1-based, in emission order), `time = now()` and `label` from `eventLabel`.
- **Warnings:**
  - `invalid-utf8` is reported once per stream, at the first offending line or chunk.
  - `discarded-event` comes from `SseInterpreter.end()`.
- **Stop.** After `stop()`, `push` and `end` do nothing.
- **`parseEventBytes`** frames and interprets one event's raw bytes in a fresh framer and interpreter, and returns the last event produced, with its label.

- [ ] **Step 1: Failing tests** (via `stream-parser-test-author`):
  - **`detect.test.ts`:**
    - `classifies content types`, covering every listed type, `Application/JSON; charset=utf-8` → `sniff`, and `text/html` → `text`.
    - `labels decisions`, with the four label strings above.
  - **`parser.test.ts`:**
    - `follows the directive over the content type`: `# @stream ndjson` with `text/event-stream`.
    - `sniffs SSE after leading blank lines and comments`.
    - `upgrades single JSON to NDJSON when a second line arrives later`:
      1. `push('{"type":"A"}\n')` emits `format(json)` and `text('{"type":"A"}\n')`.
      2. `push('{"type":"B"}\n')` emits `format(ndjson)`, then events 1 (`A`) and 2 (`B`).
    - `keeps a lone JSON line as single JSON at end`.
    - `never upgrades pretty-printed JSON`: `{\n  "a": 1\n}\n{"b":2}\n` stays `json`, and its text output is the whole input.
    - `treats text/plain digits as text`.
    - `streams a 20 MiB single-line JSON body as text without truncating it`: content type `application/json`, 64 KiB chunks, `maxEventSize` default. The concatenated text equals the input, and the bytes held by the framer never exceed `sniffBytes` plus one chunk.
    - `decides on the prefix after sniffBytes without a newline`: an SSE prefix gives `sse`, `{"a":` gives `json` whose text output is the whole input, and `abc…` gives `text`.
    - `reports invalid UTF-8 once`: `invalid-utf8.ndjson` twice in a row gives one warning, at offset 0.
    - `emits nothing after stop`.
    - `reports a discarded final SSE event`.
    - `re-parses one event from its raw bytes`: `parseEventBytes` on the bytes of the third `ag-ui.ndjson` line gives the same `value` and `label`.
  - **`byte-boundaries.test.ts`:**
    - `gives identical results for every split of every fixture`.
      - For each fixture, with its declared content type and also with `application/json` (NDJSON fixtures) or no content type (SSE fixtures), every chunking from `everySplit` plus 200 `randomSplits` (seed 1) is compared with the whole-input run.
      - Compared: the final format, every event without `time`, the warnings, and the text emitted after the last `format` call.
      - `now` returns 0.
- [ ] **Step 2: Run** `npx vitest run test/unit/streaming` — Expected: FAIL.
- [ ] **Step 3: Implement** `detect.ts` and `parser.ts`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Detect stream formats and parse streams into events"`.

### Task 6: Reply adapters

**Files:**

- Create: `src/events/reply.ts`
- Test: `test/unit/events/reply.test.ts`

**Interfaces:**

- Consumes: `StreamEvent`, `maxReplyLength` (Task 2), `StreamParser`, `StreamFormat` (Task 5).
- Produces:

```ts
export type ReplyAdapterName =
  'ag-ui' | 'openai-chat' | 'openai-responses' | 'anthropic' | 'ollama';
export interface ReplyAdapter {
  name: ReplyAdapterName;
  recognises(event: StreamEvent, format: StreamFormat): boolean;
  text(event: StreamEvent): string | undefined;
}
export const replyAdapters: readonly ReplyAdapter[];
export class ReplyAssembler {
  constructor(maxLength?: number);
  push(event: StreamEvent, format: StreamFormat): void;
  get adapter(): ReplyAdapterName | undefined;
  get truncated(): boolean;
  text(): string;
}
```

- **Adapters**, in this order (design section 9):

  | Adapter            | Recognised by                                                    | Text comes from                                                       |
  | ------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
  | `ag-ui`            | `type` `RUN_STARTED` or starting with `TEXT_MESSAGE_`            | `delta` when `type` is `TEXT_MESSAGE_CONTENT` or `TEXT_MESSAGE_CHUNK` |
  | `openai-chat`      | `object === 'chat.completion.chunk'`                             | `choices[0].delta.content` when it is a string                        |
  | `openai-responses` | `type === 'response.output_text.delta'`                          | `delta`                                                               |
  | `anthropic`        | `sse.event === 'content_block_delta'`                            | `delta.text`                                                          |
  | `ollama`           | format `ndjson`, and `message.content` or `response` is a string | that field                                                            |

- **Assembler:**
  - Until an adapter is chosen, each `json` event is offered to the adapters in order. The first that recognises it is kept, and that event's text counts.
  - Text beyond `maxLength` (default `maxReplyLength`) is dropped, and `truncated` becomes true.

- [ ] **Step 1: Failing tests** in `reply.test.ts`:
  - `assembles the reply of every vendor fixture`: run the fixtures through `StreamParser` and push each event.

    | Fixture                | Adapter            | Reply              |
    | ---------------------- | ------------------ | ------------------ |
    | `ag-ui.ndjson`         | `ag-ui`            | `Héllo, wörld 🚀✓` |
    | `ag-ui.sse`            | `ag-ui`            | `Héllo, wörld 🚀✓` |
    | `openai-chat.sse`      | `openai-chat`      | `Hi there`         |
    | `openai-responses.sse` | `openai-responses` | `Synthetic`        |
    | `anthropic.sse`        | `anthropic`        | `Synthetic`        |
    | `ollama.ndjson`        | `ollama`           | `Synthetic`        |

  - `chooses no adapter for unknown events`.
  - `does not treat an OpenAI Responses object field named response as Ollama`.
  - `stops at the length limit and marks the reply truncated`: with `maxLength` 4, the reply is `Héll`.
- [ ] **Step 2: Run** `npx vitest run test/unit/events/reply.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `reply.ts`.
- [ ] **Step 4: Run** `npx vitest run test/unit/events test/unit/streaming` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Assemble replies from AG-UI, OpenAI, Anthropic and Ollama streams"`.

### Task 7: Spill area and spill files

**Files:**

- Create: `src/events/spill.ts`
- Test: `test/unit/events/spill.test.ts`

**Interfaces:**

- Consumes: `SpillLimits`, `defaultSpillLimits` (Task 2).
- Produces:

```ts
export class SpillArea {
  static open(root: string, limits?: SpillLimits, pid?: number): Promise<SpillArea>;
  readonly directory: string;
  get totalSize(): number;
  create(): Promise<SpillFile>;
  dispose(): Promise<void>;
}
export class SpillFile {
  readonly path: string;
  append(chunk: Uint8Array): boolean;
  onDrain(listener: () => void): () => void;
  read(offset: number, length: number): Promise<Uint8Array | undefined>;
  get savedBytes(): number;
  get capped(): boolean;
  get evicted(): boolean;
  finish(): Promise<void>;
  delete(): Promise<void>;
}
```

- **`open`:**
  - creates `<root>/<pid>` (default `process.pid`) with mode `0o700`;
  - empties that directory;
  - removes every sibling directory whose name is a pid that `process.kill(pid, 0)` reports as gone (`ESRCH`), and leaves other names alone.
- **`create`** opens `<directory>/<random hex>.spill` with flags `wx` and mode `0o600`, through `fs.createWriteStream` with `highWaterMark` `writeBufferBytes`.
- **`append`:**
  - returns the stream's `write` result;
  - when the chunk would pass `maxFileSize`, writes nothing more and sets `capped`;
  - when it would pass the area's `maxTotalSize`, first evicts other files, oldest first: it closes their streams, deletes the file, and marks them `evicted`.
- **`read`:**
  - waits for pending writes that cover the range;
  - returns `undefined` when the range goes past `savedBytes` or the file was evicted or deleted;
  - reads through its own lazily opened read handle.
- **`finish`** ends the write stream. **`delete`** closes both handles and unlinks the file. **`dispose`** deletes the area's files and directory.

- [ ] **Step 1: Failing tests:**
  - `writes chunks and reads any range back`.
  - `reads a range that is still being written`: append, then `read` immediately gives the bytes.
  - `stops saving at the per-file cap and reports it`: with `maxFileSize` 10, chunks of 4 bytes give `savedBytes` 8 and `capped` true. Reading 8–12 gives `undefined`.
  - `evicts the oldest other file when the total cap is reached`: two files with `maxTotalSize` 16; the first's `evicted` becomes true, its file is gone, and its `read` gives `undefined`.
  - `signals backpressure and drain`: `writeBufferBytes` 4 and an 8-byte chunk give `false`, then `onDrain` fires.
  - `creates owner-only files and directories`: modes `0o600` and `0o700`, skipped on Windows.
  - `removes spill directories of exited processes only`, using a dead pid from a finished child process, `process.pid` of a live sibling and a non-numeric name.
  - `deletes files on delete and everything on dispose`, with no open handles left (`process.getActiveResourcesInfo()` shows no extra `FileHandle`).
- [ ] **Step 2: Run** `npx vitest run test/unit/events/spill.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `spill.ts`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Spill raw stream bytes to owner-only files with per-response and total caps"`.

### Task 8: Event store

**Files:**

- Create: `src/events/store.ts`
- Test: `test/unit/events/store.test.ts`

**Interfaces:**

- Consumes: `StreamEvent`, `EventKind` and the limits (Task 2); `SpillFile` (Task 7).
- Produces:

```ts
export interface EventSummary {
  index: number;
  time: number;
  offset: number;
  length: number;
  line: number;
  kind: EventKind;
  label: string | undefined;
}
export interface EventStoreOptions {
  memoryEvents: number;
  memoryBytes: number;
  spill: SpillFile | undefined;
  reparse: (bytes: Uint8Array) => Omit<StreamEvent, 'index' | 'time'> | undefined;
}
export class EventStore {
  constructor(options: EventStoreOptions);
  append(event: StreamEvent): void;
  get count(): number;
  summary(index: number): EventSummary | undefined;
  inMemory(index: number): StreamEvent | undefined;
  read(index: number): Promise<StreamEvent | undefined>;
}
```

- **The index:**
  - typed-array blocks of 65,536 entries: `Float64Array` time and offset, `Uint32Array` length and line, `Uint8Array` kind, `Uint16Array` label id;
  - a new block is allocated when the previous one fills, and blocks are never copied;
  - label id 0 means "no label or the table was full".
- **The ring** keeps the newest events within `memoryEvents` and `memoryBytes` (the sum of `length`), and always the newest.
- **`read`:**
  - returns the in-memory event when there is one;
  - otherwise reads the bytes from the spill file and returns `reparse(bytes)`, with `index`, `time`, `offset`, `length` and `line` taken from the index;
  - returns `undefined` when the bytes are not saved.
- **`append`** throws if `event.index !== count + 1`. That is a programming error.

- [ ] **Step 1: Failing tests:**
  - `summarises every event and keeps only the newest in memory`: `memoryEvents` 3 and 5 appends; summaries 1–5 exist, and `inMemory(2)` is `undefined` while `inMemory(3)` is defined.
  - `evicts by raw bytes as well as by count`: `memoryBytes` 10 and events of length 6 keep only the newest. An event of length 20 is still kept.
  - `re-reads an evicted event from the spill file`, using a real `SpillFile`, NDJSON bytes and a `reparse` built from `parseEventBytes`.
  - `returns undefined for an evicted event whose bytes were not saved`.
  - `stops interning labels after 4,096 distinct ones`: the 4,097th summary has label `undefined`, and `read` recovers it.
  - `crosses index blocks`: 70,000 appends give correct summaries at 65,536 and 65,537.
  - `rejects an out-of-order index`.
- [ ] **Step 2: Run** `npx vitest run test/unit/events/store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `store.ts`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Keep recent events in memory and a compact index of every event"`.

### Task 9: Update batcher and stream session

**Files:**

- Create: `src/events/batcher.ts`, `src/events/session.ts`
- Test: `test/unit/events/batcher.test.ts`, `test/unit/events/session.test.ts`

**Interfaces:**

- Consumes:
  - `StreamParser`, `parseEventBytes`, `FormatDecision`, `StreamWarning`, `StreamDirective` (Task 5);
  - `ReplyAssembler` (Task 6);
  - `SpillFile` (Task 7);
  - `EventStore` (Task 8).
- Produces:

```ts
export class UpdateBatcher {
  constructor(flush: () => void, options: { intervalMs: number; now: () => number });
  schedule(): void;
  flushNow(): void;
  dispose(): void;
}

export interface StreamSessionOptions {
  contentType: string | undefined;
  directive: StreamDirective | undefined;
  spill: SpillFile | undefined;
  now: () => number;
  onUpdate: () => void;
  onText: (text: string) => void;
  limits?: Partial<StreamLimits>;
}
export class StreamSession {
  constructor(options: StreamSessionOptions);
  readonly store: EventStore;
  readonly reply: ReplyAssembler;
  get format(): FormatDecision | undefined;
  get warnings(): readonly StreamWarning[];
  write(chunk: Uint8Array): boolean;
  onDrain(listener: () => void): () => void;
  end(): void;
  stop(): void;
  dispose(): void;
}
```

- **Batcher:**
  - `schedule` flushes at once if at least `intervalMs` has passed since the last flush and no timer is pending. Otherwise it makes sure one timer runs at `lastFlush + intervalMs`.
  - `flushNow` cancels the timer and flushes.
  - After `dispose`, nothing flushes.
- **Session:**
  - `write` appends to the spill file first, then pushes to the parser. It returns the spill file's result, or `true` without one.
  - Events go to the store and the reply assembler; text goes to `onText`; format and warnings are recorded. Each of these calls `schedule()`.
  - When the format changes from `json` to `ndjson`, `format` reflects it.
  - `end()` ends the parser, finishes the spill file and calls `flushNow()`. `stop()` stops the parser, finishes the spill file and calls `flushNow()`.
  - Only the first of `end` and `stop` has any effect, and later `write` calls are ignored.
  - `dispose` disposes the batcher.
  - The store's `reparse` uses `parseEventBytes` with the current format.

- [ ] **Step 1: Failing tests** (`vi.useFakeTimers()`, `now: () => Date.now()`):
  - **`batcher.test.ts`:**
    - `flushes the first update immediately`.
    - `coalesces updates within 50 ms into one`: 10 calls in 20 ms give one more flush at 50 ms.
    - `flushes immediately again after a quiet period`.
    - `flushNow flushes and cancels the timer`.
    - `never flushes after dispose`: `vi.getTimerCount()` is 0.
  - **`session.test.ts`:**
    - `streams AG-UI NDJSON into the store and the reply`: `ag-ui.ndjson` with `application/json` in 7-byte chunks gives format `ndjson`, count 8 and reply `Héllo, wörld 🚀✓`.
    - `sends text bodies to onText`.
    - `updates once at end even inside the interval`.
    - `ignores writes and emits nothing after stop`.
    - `passes spill backpressure through write and onDrain`.
    - `reads an evicted event back through the spill file`: with `memoryEvents` 2.
    - `leaves no timers or open handles after end and dispose`.
- [ ] **Step 2: Run** `npx vitest run test/unit/events` — Expected: FAIL.
- [ ] **Step 3: Implement** `batcher.ts` and `session.ts`.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Batch stream updates and combine the pipeline into a stream session"`.

### Task 10: Synthetic stream server and benchmark harness

**Files:**

- Create:
  - `test/support/stream-server.ts`;
  - `test/benchmark/throughput.ts`, `test/benchmark/soak.ts`, `test/benchmark/main.ts`, `test/benchmark/tsconfig.json`;
  - `scripts/benchmark.mjs`;
  - `docs/benchmarks.md`.
- Modify: `package.json` (script `bench`; `typecheck` also checks `test/benchmark/tsconfig.json`)
- Test: `test/unit/support.test.ts`, `test/unit/benchmark.test.ts`

**Interfaces:**

- Consumes: `StreamSession` (Task 9), `SpillArea` (Task 7), `NodeTransport` (`src/transport/node-transport.ts`), `startHttpServer` and `LocalServer` (`test/support/servers.ts`).
- Produces:

```ts
export function startStreamServer(): Promise<LocalServer>;
export interface ThroughputResult {
  format: 'sse' | 'ndjson';
  events: number;
  eventBytes: number;
  seconds: number;
  eventsPerSecond: number;
}
export function measureThroughput(options: {
  format: 'sse' | 'ndjson';
  events: number;
  eventBytes: number;
  chunkBytes: number;
}): ThroughputResult;
export interface SoakResult {
  format: 'sse' | 'ndjson';
  rate: number;
  seconds: number;
  events: number;
  maxHeapBytes: number;
  maxExternalBytes: number;
  maxRssBytes: number;
  lagP95Ms: number;
  lagMaxMs: number;
  spillBytes: number;
}
export function runSoak(options: {
  format: 'sse' | 'ndjson';
  rate: number;
  seconds: number;
  eventBytes: number;
  sampleMs: number;
}): Promise<SoakResult>;
```

- **Stream server.** `GET /stream` takes query parameters `format` (`ndjson` or `sse`, default `ndjson`), `type` (Content-Type override), `rate` (events per second, default 100), `size` (bytes per event, default 1024) and `seconds` (default 10).
  - Every 10 ms it writes the events due, in AG-UI shape:
    1. `RUN_STARTED`;
    2. `TEXT_MESSAGE_CONTENT` events with `messageId` `msg-1`, `sequence`, `sentAt` (`performance.timeOrigin + performance.now()`), and a `delta` padded so each framed event is `size` bytes;
    3. `RUN_FINISHED`.
  - It stops when the time is up or the client disconnects.
- **Soak:**
  - sends a real request through `NodeTransport` into a `StreamSession` with a spill file in a temporary `SpillArea`;
  - on every `onUpdate`, records lag for the new events (now minus `sentAt`) in a 1 ms histogram up to 10 s;
  - every `sampleMs`, calls `global.gc` (the harness runs with `--expose-gc`) and records `process.memoryUsage()`;
  - disposes the area at the end.
- **Throughput** builds `events` events in memory, then times a `StreamSession` without a spill file, fed `chunkBytes` chunks.
- **`scripts/benchmark.mjs`** bundles `test/benchmark/main.ts` with esbuild (platform `node`, format `cjs`, target `node22`) to `out/benchmark/main.js`. It then runs `node --expose-gc out/benchmark/main.js` with the given arguments: `throughput [--format f] [--events n] [--size b]` or `soak [--format f] [--rate r] [--minutes m] [--size b]`. It prints the result as JSON.

- [ ] **Step 1: Failing tests:**
  - **`support.test.ts`:**
    - `serves a paced synthetic AG-UI stream`: `rate=200&seconds=1&size=256` gives between 150 and 260 NDJSON lines, each 256 bytes including the newline, with increasing `sequence` values, ending with `RUN_FINISHED`.
    - `serves the same stream as SSE`.
  - **`benchmark.test.ts`:**
    - `measures parser throughput`: 10,000 events of 1,024 bytes give `eventsPerSecond > 0` and `events === 10000`.
    - `runs a short soak and reports memory and lag`: rate 200, 1 second, size 256, sample 250 ms. It gives `events >= 150`, `maxHeapBytes > 0`, a finite `lagP95Ms` and `spillBytes > 0`, and leaves no spill directory behind.
- [ ] **Step 2: Run** `npx vitest run test/unit/support.test.ts test/unit/benchmark.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the server, the harness, the script and the npm script.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Run the benchmarks** and record them in `docs/benchmarks.md`, with the date, machine, OS and Node version, the commands, a table of results against the budgets, and the raw JSON:
  - `npm run bench -- throughput --format ndjson`
  - `npm run bench -- throughput --format sse`
  - `npm run bench -- soak --format ndjson --rate 1000 --minutes 30`, in the background
  - `npm run bench -- soak --format sse --rate 5000 --minutes 1`

  Expected:
  - throughput of at least 5,000 events/s for both formats;
  - the 30-minute soak's `maxHeapBytes` under 157,286,400 (150 MB);
  - the 5,000 events/s soak's `lagP95Ms` under 100 and its event count within 2% of 300,000.

  A miss is a finding: profile, fix it with a failing test where one applies, and record both numbers.

- [ ] **Step 6: Commit** — `git commit -m "Add a synthetic stream server and benchmarks for throughput, memory and lag"`.

### Task 11: Documentation

**Files:**

- Modify:
  - `CLAUDE.md`:
    - layout rows for `src/streaming/`, `src/events/` and `test/benchmark/`;
    - the `test/support/` row mentions the stream server and fixtures;
    - the `npm run bench` command.
  - `docs/design.md`:
    - section 7: decision 1 and the diagram order;
    - section 8: decisions 2 to 5;
    - section 9: decisions 6 to 8;
    - section 17: the benchmark command.
- Test: `npm run format:check`

- [ ] **Step 1: Update** the two files.
- [ ] **Step 2: Run** `npm run check` — Expected: PASS.
- [ ] **Step 3: Commit** — `git commit -m "Document the streaming core and its benchmarks"`.

### After the last task

1. Run a fresh whole-branch review on the most capable model, with this plan's Review Focus.
2. Run `extension-security-reviewer` alongside it, told to use Bash, not terminal tools. Its focus is spill file permissions, cleanup scope and resource limits. Skip `vscode-api-verifier`, because M4 changes no `vscode` code and no manifest contributions.
3. Make one fix pass covering both reviews.
4. Push `m4-streaming` and open the pull request, only with the user's go-ahead.
