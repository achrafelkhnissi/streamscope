# Benchmarks

Benchmark runs for the streaming pipeline, kept so later changes can be compared against them. Design section 3 sets the budgets, and section 17 describes the harness.

## How to run

```bash
npm run bench -- throughput --format ndjson
npm run bench -- throughput --format sse
npm run bench -- soak --format ndjson --rate 1000 --minutes 30
npm run bench -- soak --format sse --rate 5000 --minutes 1
```

`npm run bench` bundles `test/benchmark/main.ts` with esbuild and runs it with `node --expose-gc`.

- **`throughput`** parses events of `--size` bytes (default 1,024) from memory through a `StreamSession` without a spill file. It reports events per second.
- **`soak`** sends a real request through `NodeTransport` to the synthetic stream server (`test/support/stream-server.ts`) and feeds a `StreamSession` with a spill file. It reports:
  - **Memory:** sampled every 5 s after a forced garbage collection. "Heap plus array buffers" counts the JavaScript heap and the typed-array event index, which is what the 150 MB budget covers.
  - **Lag:** the time from the server stamping an event to the batched update that delivers it. It includes up to 50 ms of batching.

These runs measure the pipeline in plain Node. The response view is measured in VS Code:

```bash
npm run build
caffeinate -d -i npm run bench -- view --surface m6 --rate 500 --size 1024 --minutes 30
npm run bench -- view --walkthrough --surface m6-dark --theme "Default Dark Modern"
npm run bench -- view --surface <name> --extension <path>
npm run bench -- serve
```

Run `npm run build` first. `npm run bench` bundles the benchmark and its driver, but Streamscope itself is loaded from `dist/`, and nothing in the benchmark builds it.

- **`view`** starts VS Code stable from `@vscode/test-electron` in a throwaway profile. It copies Streamscope's manifest and the files the manifest's `files` lists into that profile and loads the copy, together with every `--extension` folder, as development extensions. Loading the repository folder itself would make VS Code treat its own built-in themes, which install under `.vscode-test`, as themes of the extension under development, and `--theme` would not apply. The driver (`test/benchmark/view/driver.ts`) runs in the extension host. It runs the command `streamscope.benchmark.stream` with the synthetic stream's URL and the surface name. The command opens that response surface beside an editor and resolves when every event is visible. Meanwhile the driver measures:
  - **Latency:** the time from the server stamping an event to the surface showing it. A document surface counts an event when the document change reaches the extension host. A webview counts it when the page acknowledges the frame that painted it. A run fails if any event never becomes visible.
  - **Long tasks:** stretches of over 50 ms in which a 10 ms timer in the extension host could not run, that is, gaps of over 60 ms between its ticks.
  - **Streamscope tasks:** the time Streamscope spends handling a message from the response panel or refreshing the panel's feed, timed inside the extension. A task over 50 ms counts in `tasksOverBudget`, and `longestTaskMs` is the longest one. Transport, parsing and event storage are not timed. The long tasks above count every pause in the extension host, whatever caused it. This figure counts only the panel's own work.
  - **Typing:** the round trip of inserting a character into an editor every 100 ms. A tick that comes while an edit is still outstanding is skipped, so a long stall counts as one sample.
  - **Extension host:** CPU time, and heap and resident size sampled every second without forced garbage collection, so they are upper bounds. Electron reports array buffers as 0 there, so the resident size is the figure that includes the event index.
  - **Other processes:** CPU and resident size of the renderer, GPU and main processes, read with `ps` every 5 s over the VS Code process tree. "Renderer" is the sum of every renderer process: the workbench window plus any webview frames.
- **`--walkthrough`** streams 20 events/s for 2 minutes and runs `streamscope.benchmark.walkthrough`. The surface takes the screenshots listed in `src/benchmark/contract.ts` through the runner's control server, which saves them under `out/benchmark/screenshots/<surface>-<step>.jpeg`. Because the surface name is in the file name, give each theme its own surface name, such as `m6-dark`, `m6-light`, `m6-hc` and `m6-hclight`. A second run with the same name overwrites the first run's screenshots.
- **`--surface`** names the run. Results, logs and screenshots are named by it. Use `m6` for Streamscope's response view.
- **`--theme`** writes `workbench.colorTheme` into the throwaway profile. It accepts `Default Dark Modern`, `Default Light Modern`, `Default High Contrast` and `Default High Contrast Light`. Without it, VS Code's default theme applies.
- **`serve`** prints the URL of the synthetic stream server and keeps it running, for trying a surface by hand.

Things to know:

- The view benchmark runs on macOS and Linux. On Linux, `ps` reports CPU time in whole seconds.
- It opens a VS Code window that must stay visible while it runs. Chromium's background throttling is turned off, but a minimised or occluded window still distorts the numbers. Keep the display awake and unlocked for the whole run. On macOS, start long runs under `caffeinate -d -i`. A 30-minute run that was left alone failed, probably because the screen locked (see the M6 section).
- A stream run fails when the surface returns nothing, the stream does not complete, the event count differs from what the server sends, any event never becomes visible, or a visible event has no latency. The synthetic server stamps every event, including `RUN_STARTED` and `RUN_FINISHED`, with `sentAt`. A surface must record a latency for every visible event, reading `sentAt` when the event arrives.
- VS Code gets only a short list of environment variables (`PATH`, `HOME`, locale, temporary folders and display), not the whole shell environment. It keeps the Chromium sandbox on macOS.
- For a walkthrough only, VS Code is started with `--remote-debugging-port=0` so the runner can take screenshots. The runner reads the port VS Code reports and talks only to the workbench on 127.0.0.1 at that port. While a walkthrough runs, any local process can connect to that port and drive the window, so don't run walkthroughs on a shared machine or in CI. The runner's control server takes requests only with a random per-run token.
- Ctrl+C stops VS Code and removes the throwaway profile.
- Results and the VS Code log go to `out/benchmark/view-<surface>-<time>.json` and `.log`.
- A surface must register the two `streamscope.benchmark.*` commands. The M5 prototypes did, from a development-only extension that has since been deleted. Streamscope's response view registers them only in development and test mode and when `STREAMSCOPE_BENCHMARK=1`, which the runner sets. If no surface registered the command, `view` reports that.

## 2026-11-12: M4 streaming core

Commit `78e1426` on branch `m4-streaming`. Apple M3 Pro, 18 GB, macOS 27.2.1, Node 24.18.0. Events are AG-UI `TEXT_MESSAGE_CONTENT` of 1,024 bytes each.

| Run                                              | Result                       | Budget                  |
| ------------------------------------------------ | ---------------------------- | ----------------------- |
| Throughput, NDJSON, 100,000 events               | 439,699 events/s             | at least 5,000 events/s |
| Throughput, SSE, 100,000 events                  | 389,047 events/s             | at least 5,000 events/s |
| Soak, SSE, 5,000 events/s, 1 minute: events      | 300,002 of 300,002 (all)     | within 2%               |
| Same run: heap plus array buffers                | 34.8 MB at peak              | under 150 MB            |
| Same run: lag                                    | p95 49 ms, max 52 ms         | p95 under 100 ms        |
| Soak, NDJSON, 1,000 events/s, 30 minutes: events | 1,800,002 of 1,800,002 (all) | —                       |
| Same run: heap plus array buffers                | 77.4 MB at peak              | under 150 MB            |
| Same run: lag                                    | p95 49 ms, max 152 ms        | p95 under 100 ms        |

Notes:

- **What the 77.4 MB is made of.** The 30-minute run's heap stayed at 18.7 MB. Its array buffers reached 58.7 MB: about 49 MB for the index of 1.8 million events, plus the spill file's write buffers. The process's resident size peaked at 173 MB.
- **The spill cap was reached.** The run saved 536,861,696 bytes, the 512 MiB per-response cap, after about 9 minutes. From then on the stream continued without raw data, as designed (`capped`).
- **The p95 lag is mostly batching.** It is the 50 ms batch interval: events wait for the next update, and the first update of a chunk goes out in a microtask.

Raw results:

```json
[
  {
    "format": "ndjson",
    "events": 100000,
    "eventBytes": 1024,
    "seconds": 0.22742854199999998,
    "eventsPerSecond": 439698.54935797816
  },
  {
    "format": "sse",
    "events": 100000,
    "eventBytes": 1024,
    "seconds": 0.25703816700000004,
    "eventsPerSecond": 389047.2810600147
  },
  {
    "format": "sse",
    "rate": 5000,
    "seconds": 60,
    "events": 300002,
    "maxHeapBytes": 19001600,
    "maxExternalBytes": 20983894,
    "maxRssBytes": 278511616,
    "maxArrayBuffersBytes": 15771527,
    "maxMemoryBytes": 34756791,
    "lagP95Ms": 49,
    "lagMaxMs": 52.39697265625,
    "spillBytes": 307202048
  },
  {
    "format": "ndjson",
    "rate": 1000,
    "seconds": 1800,
    "events": 1800002,
    "maxHeapBytes": 18689176,
    "maxExternalBytes": 62538990,
    "maxRssBytes": 173178880,
    "maxArrayBuffersBytes": 58744519,
    "maxMemoryBytes": 77419087,
    "lagP95Ms": 49,
    "lagMaxMs": 151.674560546875,
    "spillBytes": 536861696
  }
]
```

## 2026-11-12: M5 response view spike

Prototypes on branch `m5-response-view-spike`, measured with `npm run bench -- view … --extension spike`: the 5-minute screening on commit `3d88351`, and the 30-minute runs on `fd2f887` (native) and `379b0d6` (webview). Between `3d88351` and `fd2f887`, native's document links became cheaper. These runs came before the runner checked event counts and latencies. They have the expected event count and every event visible. The 30-minute runs have 900,000 latencies for 900,002 visible events, because `RUN_STARTED` and `RUN_FINISHED` did not carry `sentAt` yet. Apple M3 Pro, 18 GB, macOS 27.2.1, Node 24.18.0, VS Code 1.146.0. Events are AG-UI NDJSON `TEXT_MESSAGE_CONTENT` of 1,024 bytes at 500 events/s. [decisions/response-surface.md](decisions/response-surface.md) describes the prototypes and what the numbers mean for the choice.

### 30 minutes

| Measure                                 | `native-fs`                      | `webview`                        | Budget           |
| --------------------------------------- | -------------------------------- | -------------------------------- | ---------------- |
| Prototype commit                        | `fd2f887`                        | `379b0d6`                        |                  |
| Events visible                          | 900,002 of 900,002               | 900,002 of 900,002               | all              |
| Latency p50 / p95 / p99 / max           | 119 / 393 / 921 / 5,949 ms       | 32 / 54 / 59 / 1,169 ms          | p95 under 100 ms |
| Extension host blocked over 50 ms       | 87, longest 670 ms, 8.3 s in all | 14, longest 257 ms, 1.6 s in all | none             |
| Typing round trip p50 / p95 / p99 / max | 20 / 136 / 257 / 5,501 ms        | 0 / 1 / 2 / 465 ms               | smooth           |
| Extension host CPU                      | 18.3%                            | 5.4%                             |                  |
| Extension host heap, start → max        | 46 → 289 MB                      | 46 → 87 MB                       | under 150 MB     |
| Extension host resident, start → max    | 182 → 263 MB                     | 183 → 236 MB                     |                  |
| Renderer CPU mean / max                 | 140% / 242%                      | 22% / 36%                        |                  |
| Renderer resident max                   | 3.14 GB                          | 600 MB                           |                  |
| GPU CPU mean                            | 13.4%                            | 11.0%                            |                  |

The first 30-minute webview run, on `fd2f887`, failed: 137,361 events never became visible. The page acknowledged events up to 762,641 and then stopped. At 22 px per row that is 16.78 million pixels. That matches Chromium's 2²⁴ px limit on layout height, so the list could no longer scroll to the newest rows. Commit `379b0d6` scales scroll positions once the list passes 8 million pixels. With it, a one-minute check at 20,000 events/s showed all 1,200,002 events, and the run above passed.

The pause count covers the whole extension host, not only Streamscope: the driver measures every gap in the host's event loop and does not record what caused it.

### 5-minute screening

| Measure                              | `native-fs`              | `native-content`              | `webview`               |
| ------------------------------------ | ------------------------ | ----------------------------- | ----------------------- |
| Events visible                       | 150,002 of 150,002       | crashed after about 3 minutes | 150,002 of 150,002      |
| Latency p50 / p95 / p99 / max        | 43 / 70 / 138 / 2,073 ms | —                             | 31 / 54 / 59 / 1,063 ms |
| Extension host long tasks over 50 ms | 5, longest 408 ms        | —                             | 1, 105 ms               |
| Typing round trip p95 / max          | 16 / 1,480 ms            | —                             | 1 / 32 ms               |
| Extension host CPU                   | 17.5%                    | —                             | 6.4%                    |
| Extension host heap, start → max     | 46 → 260 MB              | —                             | 46 → 95 MB              |
| Extension host resident, start → max | 182 → 375 MB             | —                             | 185 → 232 MB            |
| Renderer CPU mean / max              | 94% / 113%               | 210% / 245%                   | 34% / 46%               |
| Renderer resident max                | 1.57 GB                  | 2.35 GB, then out of memory   | 631 MB                  |
| GPU CPU mean                         | 17.6%                    | 10.3%                         | 25.2%                   |

The webview's p99 is 59 ms, so its 1,063 ms maximum is a small group of events. Most likely they are the first events, which wait for the page to load. The driver does not record when its long tasks happen.

## 2026-11-13: M6 response view

Branch `m6-response-view`. The stream runs and the first walkthroughs ran on commit `8dc6b8b`. The high-contrast walkthroughs were rerun on `2ba89c8`. Apple M3 Pro, 18 GB, macOS 27.2.1, Node 24.18.0, VS Code 1.146.0. Events are AG-UI NDJSON `TEXT_MESSAGE_CONTENT` of 1,024 bytes, surface name `m6`. MB means 10⁶ bytes, as in the earlier sections. Unlike M5, every event carries `sentAt`, so every visible event has a latency.

Design section 3 sets the load for each budget: latency and responsiveness at 500 events/s, memory at 1,000 events/s. Both loads ran for 30 minutes.

Both 30-minute runs ran on `8dc6b8b`, before `2ba89c8`, so the runner loaded the repository folder as the extension under development and VS Code rendered in Abyss, not its default theme (see Walkthroughs). The effect of that on these numbers was not measured.

### 30 minutes

| Measure                                 | 500 events/s            | 1,000 events/s                   | Budget                      |
| --------------------------------------- | ----------------------- | -------------------------------- | --------------------------- |
| Events visible                          | 900,002 of 900,002      | 1,800,002 of 1,800,002           | all                         |
| Latency p50 / p95 / p99 / max           | 31 / 55 / 58 / 1,060 ms | 32 / 55 / 59 / 1,020 ms          | p95 under 100 ms (at 500/s) |
| Streamscope tasks over 50 ms            | 0, longest 10.1 ms      | 1, longest 56.5 ms               | none (at 500/s)             |
| Extension host blocked over 50 ms       | 0                       | 2, longest 111 ms, 178 ms in all | none                        |
| Typing round trip p50 / p95 / p99 / max | 1 / 2 / 2 / 22 ms       | 1 / 1 / 2 / 83 ms                | smooth                      |
| Extension host CPU                      | 6.9%                    | 7.5%                             |                             |
| Extension host heap, start → max        | 46.0 → 86.2 MB          | 46.1 → 88.3 MB                   | under 150 MB (at 1,000/s)   |
| Extension host resident, start → max    | 183.0 → 252.8 MB        | 180.6 → 219.0 MB                 |                             |
| Renderer CPU mean / max                 | 25.3% / 44.1%           | 25.7% / 43.6%                    |                             |
| Renderer resident max                   | 731 MB                  | 660 MB                           |                             |
| GPU CPU mean                            | 11.9%                   | 12.5%                            |                             |

At 500 events/s every budget is met: all events were visible, p95 was 55 ms, no Streamscope task passed 50 ms and the extension host was never blocked. At 1,000 events/s the latency stayed the same and the heap peaked at 88.3 MB.

The memory budget was not shown to pass by measurement. The 88.3 MB heap leaves out the typed-array event index, because Electron reports array buffers as 0 in the extension host. Design section 9 estimates the index at about 27 bytes per event, about 49 MB for the 1.8 million events of this run, which would make about 137 MB together, under the 150 MB budget. That sum is an estimate; it was not measured. The resident size, 219.0 MB at most, includes the index but also everything else in the process, so it does not settle the question either.

The heap and resident figures are the highest of one sample per second, taken without forced garbage collection, so they are upper bounds.

### Open finding: one 56.5 ms task at 1,000 events/s

The 1,000 events/s run had one Streamscope task of 56.5 ms in 30 minutes. The responsiveness budget is judged at 500 events/s, where the longest task was 10.1 ms, so this does not fail a budget. It stays open. The cause was not measured. No CPU profile was taken, and the benchmark records neither when the task ran nor whether it was a message from the panel or a feed refresh, the two things it times.

The driver also saw two pauses of the extension host in that run, the longest 111 ms. The timers cover only the panel's message handling and feed refresh. The pauses may come from VS Code, from garbage collection or from Streamscope code that is not timed, so neither is attributed.

### The failed unattended run

The first 30-minute run at 500 events/s failed with the error `251299 events never became visible.` It ran unattended, without anything keeping the display awake.

| Measure                      | Result                                   |
| ---------------------------- | ---------------------------------------- |
| Events                       | 900,002, of which 648,703 became visible |
| Latencies recorded           | 262,131                                  |
| Latency p50 / p95 / max      | 32 / 55 / 2,647 ms                       |
| Streamscope tasks over 50 ms | 0, longest 34.7 ms                       |
| Extension host blocked       | 2 pauses, longest 83 ms                  |
| Extension host heap max      | 87.3 MB                                  |
| Typing round trip p95 / max  | 2 / 151 ms                               |

Diagnosis:

- **When it went wrong.** Latencies stopped at event 262,131, about 524 s into the stream. The benchmark reads an event's `sentAt` from the extension host's in-memory events, which hold the newest 10,000 (`memoryEvents`). An event has no latency when the page paints it after the host dropped it. So from that point the page painted events more than 10,000 behind, and it painted no event after 648,703.
- **Not the bytes and not the event count.** Two probes ran under the surface name `m6probe`. The first streamed 4,096-byte events at 500/s for 3 minutes: 90,002 events and 369 MB, more bytes than the failed run had sent when latencies stopped (about 268 MB). All events were visible and timed, p95 55 ms. The second streamed 1,024-byte events at 1,000/s for 6 minutes: 360,002 events, more than the 262,131 where the failed run broke. All were visible and timed, p95 55 ms.
- **Not time alone.** The rerun below streamed the same 30 minutes and passed.
- **Matches a probable screen lock.** The macOS power log shows login-window user activity at 23:32:04 UTC and an NFC daemon event at 23:31:49 UTC. The run started at 23:23:20 UTC, so 524 s into the stream is about 23:32:04. The display sleep timer was off.
- **Most likely cause.** The screen probably locked while the run was unattended, and the occluded VS Code window then produced animation frames far less often. The page acknowledges events when it paints them, so it slowed and fell more than 10,000 events behind. It did not stop: it still acknowledged events up to 648,703. The lock is inferred, not observed. I did not see it happen, and the evidence is the match in time and the passing rerun.

The rerun under `caffeinate -d -i` passed (first column of the table above). "How to run" now says to keep the display awake.

### Walkthroughs

Each walkthrough streams 20 events/s of 256 bytes for 2 minutes and takes 8 screenshots: startup, events-live, reply-live, raw-live, headers, detail, stopped and checks. All four ran without an error.

| Surface name | `--theme`                     | Notes                                                          |
| ------------ | ----------------------------- | -------------------------------------------------------------- |
| `m6-dark`    | `Default Dark Modern`         |                                                                |
| `m6-light`   | `Default Light Modern`        |                                                                |
| `m6-hc`      | `Default High Contrast`       | The first run rendered in the wrong theme. Rerun on `2ba89c8`. |
| `m6-hclight` | `Default High Contrast Light` | The first run rendered in the wrong theme. Rerun on `2ba89c8`. |

The two high-contrast themes did not apply in the first walkthroughs. Both rendered in VS Code's Abyss theme, which has a navy background: the editor pixel was rgb(3,11,24) and Abyss sets `#000c18`. The cause was the benchmark's setup, not Streamscope.

- **Cause.** The runner loaded the repository folder as the extension under development. VS Code installs under `.vscode-test` in that folder, so its built-in themes counted as themes of that extension. When exactly one extension is under development, VS Code's theme service activates the first theme of that extension whose type matches the current theme, and skips the setting. For a dark start that is Abyss.
- **Why dark and light looked right.** I read this in the shipped code and did not trace it at run time. VS Code rewrites the legacy ids `Default Dark Modern` and `Default Light Modern` in the settings to `Dark Modern` and `Light Modern`, and it restores the configured theme when that setting changes. The high-contrast ids have no rewrite.
- **Evidence.** A probe launched VS Code with each theme setting and each development folder, and read the theme class of the workbench:

  | Development folder    | `Default High Contrast` | `Default High Contrast Light` | `Default Dark Modern` | `Default Light Modern` |
  | --------------------- | ----------------------- | ----------------------------- | --------------------- | ---------------------- |
  | none                  | High Contrast           | High Contrast Light           | Dark Modern           | Light Modern           |
  | an empty extension    | High Contrast           | High Contrast Light           | Dark Modern           | Light Modern           |
  | the repository folder | Abyss                   | Abyss                         | Dark Modern           | Light Modern           |

  With the repository folder, the ids `Dark Modern` and `Light Modern`, and no theme setting at all, also gave Abyss.

- **Fix.** The runner now loads a copy of the extension's packaged files from the throwaway profile, and it refuses a development folder that contains the VS Code executable. The rerun rendered the editor and side bar as rgb(0,0,0) for `m6-hc` and rgb(255,255,255) for `m6-hclight`. Light Modern's side bar is rgb(248,248,248), so the second is not Light Modern. The dark and light walkthroughs were not rerun. Their backgrounds were already right: rgb(31,31,31) and rgb(255,255,255).

Every screenshot was checked for readable text and visible state: the status pill, the selected tab, the disabled Stop after a run ends and the expanded event. Focus does not show in them, so it is on the manual checklist. Six are committed under `decisions/response-surface/`, at 1,280 px:

| Theme                       | View                                   | File                                                                       |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| Default Dark Modern         | Events, receiving                      | [m6-dark-events-live](decisions/response-surface/m6-dark-events-live.jpeg) |
| Default Dark Modern         | Event detail, cancelled run            | [m6-dark-stopped](decisions/response-surface/m6-dark-stopped.jpeg)         |
| Default Light Modern        | Raw, coloured                          | [m6-light-raw-live](decisions/response-surface/m6-light-raw-live.jpeg)     |
| Default Light Modern        | Headers, with Open in Editor           | [m6-light-headers](decisions/response-surface/m6-light-headers.jpeg)       |
| Default High Contrast       | Events, receiving                      | [m6-hc-events-live](decisions/response-surface/m6-hc-events-live.jpeg)     |
| Default High Contrast Light | Event detail with Open Event in Editor | [m6-hclight-detail](decisions/response-surface/m6-hclight-detail.jpeg)     |

Two things seen in the screenshots were fixed after these runs, in `5b09974`. The walkthroughs were not rerun after the fix.

- **No selection marker in Default High Contrast.** In the `m6-hc-detail` and `m6-hc-stopped` screenshots, which were not kept, the selected row has no fill and no outline. The panel styled a selected row only with `list.activeSelectionBackground`, which Default High Contrast leaves unset, and set no `contrastActiveBorder`. The border of the open detail still marks the event. In Default High Contrast Light the row has a light fill.
- **Low contrast for event labels in the light themes.** The labels used `symbolIcon.classForeground`, which is `#D67E00` in both light themes. On white that is about 3.1 to 1 by calculation, below the 4.5 to 1 that WCAG asks of normal text. This is calculated from the colour value, not measured on screen.
