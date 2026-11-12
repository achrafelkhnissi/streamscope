# Response surface

**Status:** Proposed (2026-11-12), awaiting the user's approval.

## Context

Design section 13 left one question open: whether the response view is built from native VS Code documents or a webview. Native came first, as agreed, and the M5 spike decides with data. The design states the rule:

> Native is chosen if it meets every section 3 budget and supports Events, Reply, Raw, Headers, Body, Checks, Stop and click-to-capture without awkward workarounds. Otherwise the webview is used.

The budgets in section 3:

| Budget         | Requirement                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Latency        | An event is visible at most 100 ms (p95) after its last byte arrives, at 500 events/s of 1 KiB events             |
| Responsiveness | No synchronous task blocks the extension host for more than 50 ms; typing stays smooth through a 30-minute stream |
| Memory         | Extension heap under 150 MB regardless of stream length                                                           |

## What was built

Two throwaway prototypes, both fed by the M2 transport and the M4 `StreamSession` from the synthetic AG-UI NDJSON server. They lived in a development-only extension under `spike/`. Commit `379b0d6` still contains them, and Task 9 of the M5 plan deleted them.

- **Native**, in two variants:
  - `native-fs` serves each view as a read-only file from a `FileSystemProvider`, as M2's response documents are. VS Code re-reads the file after every change.
  - `native-content` serves each view from a `TextDocumentContentProvider`. VS Code diffs each new version in its editor worker.

  Both variants have the same features. Each view (Events, Reply, Raw, Headers, Body, Checks) is its own document, switched with editor title buttons. Events is one line per event, coloured by a small grammar, capped at the newest 5,000 to 6,000 lines with paging to older events. Event detail opens in a peek. Status, Stop and captured values show as CodeLenses and in a status bar item.

- **Webview:**
  - One panel per response, laid out after the approved mockup: a status pill, counts, a Stop button, a tab strip, a captured-values strip, and a virtualized event list that follows the tail and expands one event inline.
  - It applies the section 13 safeguards: a nonce-only CSP, `localResourceRoots` limited to the bundle, content inserted with `textContent` only, deltas only for visible rows, and VS Code theme variables.

The measurements come from the view benchmark kept in `test/benchmark/view/`: `npm run bench -- view`, described in [benchmarks.md](../benchmarks.md).

## Measurements

Thirty minutes at 500 events/s of 1 KiB, on an Apple M3 Pro with VS Code 1.146.0 (stable; the 1.101.0 minimum was not measured). All the numbers are in [benchmarks.md](../benchmarks.md).

| Budget                             | `native-fs`                                         | `webview`                                   |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Every event becomes visible        | 900,002 of 900,002                                  | 900,002 of 900,002 (after a fix, see below) |
| Latency p95 under 100 ms           | **Fails:** p95 393 ms, p99 921 ms, max 5.9 s        | **Passes:** p95 54 ms, p99 59 ms, max 1.2 s |
| No extension host pause over 50 ms | **Fails:** 87 pauses, the longest 670 ms            | **Fails:** 14 pauses, the longest 257 ms    |
| Typing stays smooth                | **Fails:** p95 136 ms, worst 5.5 s                  | p95 1 ms, worst 465 ms                      |
| Extension heap under 150 MB        | **Most likely fails:** up to 289 MB, an upper bound | **Passes:** up to 87 MB                     |
| Renderer                           | 140% CPU on average, 3.14 GB                        | 22% CPU on average, 600 MB                  |

Native got worse as the run went on: in the 5-minute screening its p95 was 70 ms, after 30 minutes it was 393 ms. The webview stayed flat: p95 54 ms in both.

The first 30-minute webview run failed. Its list stopped scrolling at event 762,641. At 22 px per row, that matches Chromium's limit on layout height (2²⁴ px). Scaling scroll positions past 8 million pixels fixed it, and the rerun is the one in the table.

The pause counts cover the whole extension host, not only the response view. The driver records every gap over 50 ms in the host's event loop, but not what caused it.

Screening runs, 5 minutes each at 500 events/s of 1 KiB:

| Surface          | Result                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-fs`      | Every event visible; latency p95 70 ms, max 2,073 ms; 5 extension host long tasks, the longest 408 ms; renderer CPU 94% mean                                               |
| `native-content` | The window's renderer ran out of memory about 3 minutes in and crashed (V8 OOM, renderer at 2.35 GB and 210% CPU)                                                          |
| `webview`        | Every event visible; latency p95 54 ms, p99 59 ms, max 1,063 ms (most likely the first events, waiting for the page to load); 1 long task of 105 ms; renderer CPU 34% mean |

The most likely reason `native-content` crashed: when a content provider's document changes, VS Code computes minimal edits in its editor worker. In VS Code 1.101 that worker gives up above 100,000 characters and replaces the whole document. The Events window passes that size at about 1,000 lines, so every update would become a full replacement.

How to read the numbers:

- **Native latency is a lower bound.** Native counts an event as visible when the document change reaches the extension host, before the editor paints it. The webview counts it when the page acknowledges the frame that painted it, one message later.
- **Typing is the extension host round trip** of an edit, not the renderer's input-to-paint time.
- **Heap figures are upper bounds.** They are sampled without forcing garbage collection. Electron reports array buffers as 0 in the extension host, so resident size is the figure that includes the event index.

## Walkthrough

Both surfaces streamed 20 events/s, and each step was captured automatically. Screenshots are in [response-surface/](response-surface/).

| Item                        | Native                                                                                                                                                                                                                           | Webview                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Events, live                | One coloured line per event ([native-events-live](response-surface/native-events-live.jpeg)). Editors do not follow appended text, so it needed a reveal after every update, and the first open landed scrolled to the far right | Virtualized list that follows the tail ([webview-events-live](response-surface/webview-events-live.jpeg))                                |
| Switching views mid-stream  | Title bar icons for Events, Reply, Raw and Headers. Body and Checks are only in the `…` menu. A switch closes one tab and opens another, so each view loses its scroll position. No data is lost                                 | Tab strip with all six views; nothing is lost                                                                                            |
| Reply                       | Markdown document, updated live                                                                                                                                                                                                  | Appended text, sent only while visible                                                                                                   |
| Raw colouring               | Built-in `jsonl` colouring, free                                                                                                                                                                                                 | Hand-written tokenizer; keeps the newest 2,000 lines                                                                                     |
| Headers                     | `.http` document, coloured by the Streamscope grammar                                                                                                                                                                            | Status line and table                                                                                                                    |
| Body, Checks                | Plain documents behind the overflow menu                                                                                                                                                                                         | Tabs                                                                                                                                     |
| Event detail                | Peek with the pretty JSON, opened with Enter, Cmd+click on the event number, or the context menu ([native-detail](response-surface/native-detail.jpeg)). Folding, find and copy work                                             | Inline expansion under the row, as in the mockup ([webview-detail](response-surface/webview-detail.jpeg))                                |
| Stop                        | Title bar button, CodeLens and status bar                                                                                                                                                                                        | Button in the status line                                                                                                                |
| Live status                 | CodeLens on the first line, which scrolls away while following the tail, so it needed a status bar item. That item's text is cut off at ordinary widths                                                                          | Status line, always visible                                                                                                              |
| Captured values             | Same as live status: a CodeLens plus the status bar; no strip                                                                                                                                                                    | Strip of chips, always visible ([webview-stopped](response-surface/webview-stopped.jpeg))                                                |
| Click-to-capture entry      | The quick-fix lightbulb does not render in an unfocused window, so a visible entry needed a CodeLens above every property ([native-capture-entry](response-surface/native-capture-entry.jpeg))                                   | Button in the expanded event ([webview-capture-entry](response-surface/webview-capture-entry.jpeg))                                      |
| Event numbers               | `#000123` was drawn as a colour swatch by VS Code's colour decorators, so it became `[000123]`                                                                                                                                   | No issue                                                                                                                                 |
| Find and copy               | Free across the whole window                                                                                                                                                                                                     | Only rendered rows exist in the page: no find across the list, no multi-row copy yet                                                     |
| Keyboard and screen readers | Free, including Accessible View                                                                                                                                                                                                  | Hand-built: arrows, Home, End and Enter in the list, arrows between tabs, ARIA roles. Not yet checked with VoiceOver; no Accessible View |
| Theming                     | Free                                                                                                                                                                                                                             | Theme variables; looked right in the default dark theme                                                                                  |

## Costs

**Native** needed these workarounds to reach the mockup's behaviour:

- following the tail by revealing the last line after every update;
- a status bar item, because the status and captured-values CodeLenses scroll away;
- a CodeLens per property, because the capture lightbulb does not show in an unfocused window;
- closing and reopening tabs to switch views, with Body and Checks hidden in the overflow menu;
- a different event number format, to avoid colour swatches;
- resending the whole text of the open view on every batch, which VS Code then re-reads and re-diffs.

**The webview** costs code that VS Code would otherwise give for free:

- keyboard navigation, ARIA roles and screen reader support, with no Accessible View;
- find and copy across the list;
- a CSP and XSS surface to keep closed;
- a page load before the first event paints;
- rebuilding its state each time the panel is shown again, since it does not keep its context while hidden.

## Recommendation

**Use the webview.**

Applying the rule literally, native does not qualify:

- **It fails two budgets in the 30-minute run, and most likely a third:**
  - latency, with p95 393 ms against 100 ms;
  - responsiveness, with 87 extension host pauses up to 670 ms and typing that stalled for up to 5.5 s;
  - most likely heap, at up to 289 MB against 150 MB. That is an upper bound, sampled without forced garbage collection.

  Its renderer used 140% CPU and 3.14 GB. The content-provider variant crashed the window within 3 minutes.

- **It needed workarounds** for following the tail, for live status and captured values, for click-to-capture and for switching views (see Costs).

The webview meets the latency and memory budgets with room to spare and stays flat over 30 minutes. It does not yet meet the pause budget: 14 extension host pauses over 50 ms, the longest 257 ms. Their cause is unknown, so M6 has to find it and meet the budget.

What the webview gives up is mostly what VS Code provides free to documents: keyboard and screen reader support, Accessible View, find and copy. M6 has to build those, and the M11 accessibility pass has to check them.

## Consequences for M6

- **Surface:** one webview panel per response, laid out after the mockup, with the section 13 safeguards the prototype used:
  - a nonce-only CSP;
  - `localResourceRoots` limited to the bundle;
  - response content only through `textContent`;
  - VS Code theme variables.
- **Updates:**
  - at most one message per update batch (50 ms);
  - only the newest rows while following the tail, at most 500 per message;
  - Reply and Raw as deltas, sent only while their tab is visible;
  - older rows read from the spill file when the user scrolls back.
- **The event list:**
  - virtualized, with fixed-height rows;
  - scroll positions scaled once the list would pass a few million pixels, because Chromium stops laying out at 2²⁴ px (the prototype failed at 762,641 rows);
  - one event expanded inline at a time.
- **Built by hand, and checked in M6 and M11:**
  - keyboard navigation in the list and the tabs, with ARIA roles, checked with VoiceOver;
  - find across all events, done on the extension side because only visible rows exist in the page;
  - copying an event or several;
  - light, dark and high-contrast themes;
  - restoring the selected tab and scroll position when a hidden panel is shown again.
- **Raw colouring** needs its own tokenizer in the webview, since the built-in `jsonl` grammar only colours documents. The design's "Raw uses VS Code's built-in `jsonl` colouring" therefore changes with this decision.
- **Benchmark and budgets:**
  - When `STREAMSCOPE_BENCHMARK=1`, the response view registers `streamscope.benchmark.stream` and `streamscope.benchmark.walkthrough` from `src/benchmark/contract.ts`, so `npm run bench -- view` measures it.
  - M6 meets the section 3 budgets in that benchmark, which includes finding the cause of the extension host pauses over 50 ms.
- **Not decided here:**
  - whether non-streaming responses keep M2's Body and Headers documents or move into the panel;
  - whether event detail can also open as a document, to get folding and find in large events.

  The M6 plan proposes both.
