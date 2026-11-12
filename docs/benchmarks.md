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
npm run bench -- view --surface <name> --rate 500 --size 1024 --minutes 30 --extension <path>
npm run bench -- view --walkthrough --surface <name> --extension <path>
npm run bench -- serve
```

- **`view`** starts VS Code stable from `@vscode/test-electron` in a throwaway profile, with Streamscope and every `--extension` folder loaded as development extensions. The driver (`test/benchmark/view/driver.ts`) runs in the extension host. It runs the command `streamscope.benchmark.stream` with the synthetic stream's URL and the surface name. The command opens that response surface beside an editor and resolves when every event is visible. Meanwhile the driver measures:
  - **Latency:** the time from the server stamping an event to the surface showing it. A document surface counts an event when the document change reaches the extension host. A webview counts it when the page acknowledges the frame that painted it. A run fails if any event never becomes visible.
  - **Long tasks:** stretches of over 50 ms in which a 10 ms timer in the extension host could not run, that is, gaps of over 60 ms between its ticks.
  - **Typing:** the round trip of inserting a character into an editor every 100 ms. A tick that comes while an edit is still outstanding is skipped, so a long stall counts as one sample.
  - **Extension host:** CPU time, and heap and resident size sampled every second without forced garbage collection, so they are upper bounds. Electron reports array buffers as 0 there, so the resident size is the figure that includes the event index.
  - **Other processes:** CPU and resident size of the renderer, GPU and main processes, read with `ps` every 5 s over the VS Code process tree. "Renderer" is the sum of every renderer process: the workbench window plus any webview frames.
- **`--walkthrough`** streams 20 events/s for 2 minutes and runs `streamscope.benchmark.walkthrough`. The surface takes the screenshots listed in `src/benchmark/contract.ts` through the runner's control server, which saves them under `out/benchmark/screenshots/`.
- **`serve`** prints the URL of the synthetic stream server and keeps it running, for trying a surface by hand.

Things to know:

- The view benchmark runs on macOS and Linux. On Linux, `ps` reports CPU time in whole seconds.
- It opens a VS Code window that must stay visible while it runs. Chromium's background throttling is turned off, but a minimised window still distorts the numbers.
- A stream run fails when the surface returns nothing, the stream does not complete, the event count differs from what the server sends, any event never becomes visible, or a visible event has no latency. The synthetic server stamps every event, including `RUN_STARTED` and `RUN_FINISHED`, with `sentAt`. A surface must record a latency for every visible event, reading `sentAt` when the event arrives.
- VS Code gets only a short list of environment variables (`PATH`, `HOME`, locale, temporary folders and display), not the whole shell environment. It keeps the Chromium sandbox on macOS.
- For a walkthrough only, VS Code is started with `--remote-debugging-port=0` so the runner can take screenshots. The runner reads the port VS Code reports and talks only to the workbench on 127.0.0.1 at that port. While a walkthrough runs, any local process can connect to that port and drive the window, so don't run walkthroughs on a shared machine or in CI. The runner's control server takes requests only with a random per-run token.
- Ctrl+C stops VS Code and removes the throwaway profile.
- Results and the VS Code log go to `out/benchmark/view-<surface>-<time>.json` and `.log`.
- A surface must register the two `streamscope.benchmark.*` commands. The M5 prototypes did, from a development-only extension that has since been deleted. M6's response view will register them only in development and test mode and when `STREAMSCOPE_BENCHMARK=1`. Until then, `view` reports that no surface registered the command.

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
