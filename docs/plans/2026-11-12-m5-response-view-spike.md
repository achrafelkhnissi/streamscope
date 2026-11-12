# M5 Response View Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** choose the response surface with data, not guesses. M5 builds two throwaway prototypes, measures both in a real VS Code against the section 3 budgets, walks both through the approved mockup, and writes a decision record for the user to approve. The prototypes are then deleted; the benchmark tooling stays for M6.

**Architecture:**

- **Kept, pure:** `src/benchmark/`:
  - a latency histogram;
  - the command and environment contract between the view benchmark and any response surface (the prototypes now, the M6 view later).
- **Kept, test tooling:** `test/benchmark/view/`:
  - a runner that starts VS Code with a driver, serves the synthetic stream, samples the process tree with `ps` and takes screenshots through the DevTools protocol;
  - a driver that runs inside the extension host and measures long tasks, CPU, memory and typing responsiveness while the surface streams.
- **Thrown away:** `spike/`, a separate development-only extension loaded next to Streamscope:
  - a native prototype in two variants: a `FileSystemProvider`, as M2 uses, and a `TextDocumentContentProvider`;
  - a hardened webview prototype.

  Both prototypes run the M2 transport and the M4 `StreamSession` themselves. They do not touch `startRun`, the run registry or the M2 presenter, and the shipped extension does not change.

**Tech Stack:** TypeScript 6.0.3, VS Code API 1.101, `node:http`, `node:child_process` (`ps`), Node's global `WebSocket` (DevTools protocol), `@vscode/test-electron` (already a dev dependency), esbuild, Vitest 5. No new dependency.

**Spec:** `docs/design.md` sections 3 (budgets), 13 (response visualization and the decision rule), 17 (performance) and 18 (testing); `docs/roadmap.md` M5; the approved mockup `docs/mockups/response-view.html`.

## Global Constraints

- **Budgets** (design section 3, verbatim):
  - Latency: "An event is visible at most 100 ms (p95) after its last byte arrives, at sustained 500 events/s of 1 KiB events".
  - Responsiveness: "No synchronous task of the extension blocks the extension host for more than 50 ms; typing in the editor stays smooth during a 30-minute stream".
  - Memory: "Extension heap stays under 150 MB regardless of stream length; older events live on disk".
- **The spike run** (design section 13): "stream a synthetic 30-minute AG-UI run at 500 events/s, then measures event latency (p95), extension host long tasks, renderer CPU and memory, and checks the experience against the mockup".
- **Decision rule** (design section 13, verbatim): "Native is chosen if it meets every section 3 budget and supports Events, Reply, Raw, Headers, Body, Checks, Stop and click-to-capture without awkward workarounds. Otherwise the webview is used".
- **Webview safeguards** (design section 13), applied to the webview prototype too, so that their cost is measured:
  - CSP `default-src 'none'`, scripts and styles only from the extension with nonces, `localResourceRoots` limited to the extension.
  - Response content inserted with `textContent` only.
  - Messages batched and capped; the webview never holds more than the visible window plus a margin.
  - VS Code theme variables only; keyboard navigation and ARIA roles for the event list.
- **Native cap** (design section 17): "the live Events document is capped (for example the newest 5,000 lines) with older events reachable by paging".
- **Raw colouring** (design section 13): built-in `jsonl` for NDJSON; a small grammar for SSE. The prototypes stream NDJSON only, so SSE colouring is noted, not built.
- **Layers.**
  - `src/benchmark/` imports only `src/events/model.ts` types.
  - Only `src/vscode/` and `src/extension.ts` import `vscode` in `src/`; nothing in `src/` changes otherwise.
  - `spike/` and `test/benchmark/view/driver.ts` are development code and may import `vscode` and `src/`.
- **Transport:** `node:http` only, no `fetch`, including for the driver's and the prototypes' calls to the runner's control server.
- **Process:**
  - No code comments. Synthetic data only (`thread-1`, `run-1`, `msg-1`).
  - Work on branch `m5-response-view-spike` from `origin/main`, one commit per task. Push and pull request only with the user's go-ahead.

## Decisions this plan makes (builder's call, approval of this plan approves them)

1. **TDD covers the kept code only.** The prototypes are throwaway: they are checked by the type checker, lint, `vscode-api-verifier`, the walkthrough and the benchmark, then deleted in Task 9, and git history keeps them. Kept code (`src/benchmark/`, `test/benchmark/view/`) is written test first.
2. **The prototypes live in a separate development extension, `spike/`.**
   - The runner loads it with a second `--extensionDevelopmentPath`.
   - The shipped manifest, `src/extension.ts` and `test/unit/manifest.test.ts` stay untouched.
   - `spike/` is never packaged: the VSIX ships only `files`.
3. **Two native variants, screened first.** `native-fs` (a `FileSystemProvider` that VS Code re-reads on every change) and `native-content` (a `TextDocumentContentProvider` whose changes VS Code diffs in its editor worker) both get a 5-minute screening run. The variant with the lower p95 latency goes on to the 30-minute run; within 10 ms of each other, the one with fewer long tasks wins.
4. **Native Events document policy.**
   - Updates are append-only.
   - When the document passes 6,000 event lines it is trimmed to the newest 5,000, so it has one full rewrite every 1,000 events instead of one per batch.
   - A first line points to Show Older Events, which pages 1,000 events at a time from the spill file.
5. **"Visible" means:**
   - Native: `onDidChangeTextDocument` reports the Events document containing the event's line. VS Code paints it on the next frame.
   - Webview: the webview acknowledges, in the `requestAnimationFrame` after the DOM update, the newest index it painted.

   Latency runs from the synthetic server's `sentAt` stamp (`performance.timeOrigin + performance.now()` in the runner process), so it includes the network, parsing and the 50 ms batching. Events that never become visible are counted, never dropped from the sample.

6. **What is measured, and where:**
   - **Extension host, from the driver:**
     - long tasks, as the gaps between 10 ms interval ticks that exceed 50 ms;
     - CPU, with `process.cpuUsage()`;
     - heap and array buffers, from `process.memoryUsage()` every second without forced garbage collection, so the figures are an upper bound, with a baseline taken before the stream.
   - **Typing:** a probe inserts a character into an untitled editor in column 1 every 100 ms with `TextEditor.edit`, and records the round trip.
   - **Renderer, GPU and main process:** `ps -A -o pid=,ppid=,rss=,time=,command=` every 5 s over the VS Code process tree, re-read each time so the webview's process counts from its first appearance.
   - **Platforms:** the view benchmark supports macOS, where it is measured, and Linux, where `ps` reports CPU time in whole seconds.
7. **VS Code setup for the runs:**
   - VS Code stable from `@vscode/test-electron`, in a fresh profile.
   - Chromium background throttling off: `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling`.
   - Settings: `workbench.startupEditor: none`, `workbench.tips.enabled: false`, `telemetry.telemetryLevel: off`, `update.mode: none`, `extensions.autoCheckUpdates: false`, `chat.disableAIFeatures: true`, `workbench.secondarySideBar.defaultVisibility: hidden`.
   - The runs open a VS Code window on the user's desktop. It must stay visible; the laptop must be plugged in.
8. **Screenshots through the DevTools protocol.**
   - The runner starts VS Code with `--remote-debugging-port=<free port>` on 127.0.0.1 and captures the workbench page as JPEG at quality 80. That gives only the VS Code window, never the rest of the desktop.
   - The port is open only while the throwaway profile runs and serves synthetic data; `docs/benchmarks.md` says so.
   - At most 8 screenshots are committed, each under 250 KB, after checking that they show nothing but synthetic data.
9. **A contract kept for M6.**
   - The commands `streamscope.benchmark.stream` and `streamscope.benchmark.walkthrough` and the `STREAMSCOPE_BENCH_*` variables live in `src/benchmark/contract.ts`.
   - The spike registers both commands now. M6's view will register them when `STREAMSCOPE_BENCHMARK=1`.
   - After Task 9, `npm run bench -- view` reports that no surface registered the command, until M6.
10. **Time box.** Each prototype gets about half a day. A feature that does not fit becomes a finding in the decision record, which is itself data for the decision rule.
11. **The decision record starts as "Proposed".** When the user approves the choice at pull request review, it becomes "Accepted", and design section 13 and the open questions table get the decision, in the same pull request.

## Review Focus

1. **Missing events.** An event that never becomes visible must make the run fail loudly, never quietly shrink the latency sample. Causes include a throttled window, a hidden webview, or a native trim that overtakes the document. Task 3 pins it: `checkSurfaceResult` errors when `visible < events`.
2. **Processes that start mid-run.** The webview's renderer appears after the first `ps` sample and must count from its first appearance. Task 2 pins it with a process that appears in the second sample.
3. **Clock skew between the server and the extension host.** It must clamp to 0 ms instead of producing negative buckets. Task 1 pins it.
4. **`ps` output with spaces and both time formats.**
   - macOS executables such as `Code Helper (Renderer)` contain spaces.
   - macOS shows minutes past 59, Linux shows `DD-HH:MM:SS`.

   Task 2 pins both.

5. **A driver that hangs, crashes or writes nothing.**
   - The runner must kill the whole VS Code process group at the timeout and report what happened.
   - It must not leave Electron running or a JSON parse error in place of a reason.

   Task 3 pins the result handling with `readDriverResult` tests. Its smoke step checks that no process is orphaned.

---

### Task 1: Latency histogram and benchmark contract

**Files:**

- Create: `src/benchmark/latency.ts`, `src/benchmark/contract.ts`, `test/unit/benchmark/latency.test.ts`, `test/unit/benchmark/contract.test.ts`
- Modify: `test/benchmark/soak.ts`: replace its local `percentile`, histogram array and `sentAtOf` with the new module. `SoakResult` keeps its fields: `lagP95Ms` is `percentile(0.95)` and `lagMaxMs` is `maxMs`.

**Interfaces:**

- Produces (`src/benchmark/latency.ts`):

  ```ts
  export interface LatencySummary {
    count: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  }
  export class LatencyHistogram {
    constructor(limitMs?: number);
    record(ms: number): void;
    get count(): number;
    get maxMs(): number;
    percentile(fraction: number): number;
    summary(): LatencySummary;
  }
  export function sentAtOf(value: JsonValue | undefined): number | undefined;
  ```

  - `limitMs` defaults to 10,000. A value is clamped to at least 0 and floored to a whole-millisecond bucket. Values above the limit go into the last bucket.
  - `maxMs` keeps the exact largest value, clamped at 0.
  - `percentile` uses the nearest rank: the smallest bucket whose cumulative count reaches `ceil(count × fraction)`, and 0 when empty.

- Produces (`src/benchmark/contract.ts`):

  ```ts
  export const benchmarkCommands = {
    stream: 'streamscope.benchmark.stream',
    walkthrough: 'streamscope.benchmark.walkthrough',
  } as const;
  export const benchmarkEnvironment = {
    enabled: 'STREAMSCOPE_BENCHMARK',
    mode: 'STREAMSCOPE_BENCH_MODE',
    url: 'STREAMSCOPE_BENCH_URL',
    surface: 'STREAMSCOPE_BENCH_SURFACE',
    control: 'STREAMSCOPE_BENCH_CONTROL',
    out: 'STREAMSCOPE_BENCH_OUT',
  } as const;
  export interface StreamBenchmarkRequest {
    url: string;
    surface: string;
  }
  export interface StreamBenchmarkResult {
    surface: string;
    events: number;
    visible: number;
    latency: LatencySummary;
    endedBy: 'completed' | 'failed' | 'cancelled';
  }
  export interface WalkthroughRequest {
    url: string;
    surface: string;
    controlUrl: string;
  }
  export const walkthroughSteps = [
    'events-live',
    'reply-live',
    'raw-live',
    'headers',
    'detail',
    'capture-entry',
    'stopped',
    'checks',
  ] as const;
  export function screenshotUrl(controlUrl: string, name: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('LatencyHistogram', () => {
  it('reports zeros when nothing was recorded', () => {
    expect(new LatencyHistogram().summary()).toEqual({
      count: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
  });
  it('uses nearest-rank percentiles over whole milliseconds', () => {
    const histogram = new LatencyHistogram();
    for (let ms = 1; ms <= 100; ms += 1) histogram.record(ms);
    expect(histogram.summary()).toEqual({
      count: 100,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
      maxMs: 100,
    });
  });
  it('floors fractions and clamps negative latencies to zero', () => {
    const histogram = new LatencyHistogram();
    histogram.record(-3);
    histogram.record(2.9);
    expect(histogram.percentile(0.5)).toBe(0);
    expect(histogram.percentile(1)).toBe(2);
    expect(histogram.maxMs).toBe(2.9);
  });
  it('keeps the exact maximum beyond the histogram limit', () => {
    const histogram = new LatencyHistogram(100);
    histogram.record(250);
    expect(histogram.percentile(1)).toBe(100);
    expect(histogram.maxMs).toBe(250);
  });
});
describe('sentAtOf', () => {
  it.each([
    [{ sentAt: 1700000000000.5 }, 1700000000000.5],
    [{ sentAt: '1' }, undefined],
    [[1], undefined],
    [null, undefined],
    [undefined, undefined],
  ])('reads the server stamp of %j', (value, expected) => {
    expect(sentAtOf(value)).toBe(expected);
  });
});
```

`contract.test.ts`: `screenshotUrl('http://127.0.0.1:5000', 'webview-events live')` is `'http://127.0.0.1:5000/screenshot?name=webview-events%20live'`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/benchmark`
Expected: FAIL, because the modules do not exist yet.

- [ ] **Step 3: Implement both modules and switch `soak.ts` to the histogram**

- [ ] **Step 4: Run the tests and the soak test**

Run: `npx vitest run test/unit/benchmark test/unit/benchmark.test.ts`
Expected: PASS, and the soak test is unchanged.

- [ ] **Step 5: Commit** `Add the latency histogram and the view benchmark contract`

### Task 2: Long-task recorder and process sampling

**Files:**

- Create: `test/benchmark/view/long-tasks.ts`, `test/benchmark/view/processes.ts`, `test/unit/benchmark/long-tasks.test.ts`, `test/unit/benchmark/processes.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface LongTaskSummary {
    count: number;
    maxMs: number;
    totalMs: number;
  }
  export class LongTaskRecorder {
    constructor(options: { thresholdMs: number; intervalMs: number });
    tick(now: number): void;
    summary(): LongTaskSummary;
  }

  export type ProcessRole = 'main' | 'renderer' | 'gpu' | 'utility' | 'other';
  export interface ProcessRow {
    pid: number;
    ppid: number;
    rssBytes: number;
    cpuSeconds: number;
    command: string;
  }
  export interface ProcessSample {
    at: number;
    rows: readonly ProcessRow[];
  }
  export interface RoleSummary {
    meanCpuPercent: number;
    maxCpuPercent: number;
    maxRssBytes: number;
  }
  export type ProcessSummary = Record<ProcessRole, RoleSummary>;
  export function parseCpuTime(text: string): number;
  export function parseProcessTable(text: string): ProcessRow[];
  export function processRole(row: ProcessRow, rootPid: number): ProcessRole;
  export function descendantsOf(rows: readonly ProcessRow[], rootPid: number): ProcessRow[];
  export function summariseProcessSamples(
    samples: readonly ProcessSample[],
    rootPid: number,
  ): ProcessSummary;
  export function sampleProcesses(rootPid: number, now: () => number): Promise<ProcessSample>;
  ```

- **`LongTaskRecorder`:**
  - The first tick sets the baseline.
  - Each later tick counts `now − previous − intervalMs` as blocked time.
  - Blocked time strictly greater than `thresholdMs` is a long task.
- **CPU per role:**
  - For each pid present in two consecutive samples, the CPU time delta is divided by the wall time between them.
  - `maxCpuPercent` is the largest per-interval sum.
  - `meanCpuPercent` is the total delta over the first-to-last wall time.
  - A pid's first sample is only its baseline.
- **`maxRssBytes`** is the largest per-sample sum of resident memory for the role.
- **`sampleProcesses`** runs `ps -A -o pid=,ppid=,rss=,time=,command=` with `execFile` and keeps `descendantsOf(rootPid)`. `ps` reports RSS in KiB.

- [ ] **Step 1: Write the failing tests**

```ts
describe('LongTaskRecorder', () => {
  const recorder = () => new LongTaskRecorder({ thresholdMs: 50, intervalMs: 10 });
  const run = (ticks: number[]) => {
    const r = recorder();
    for (const tick of ticks) r.tick(tick);
    return r.summary();
  };
  it('uses the first tick as the baseline', () =>
    expect(run([500])).toEqual({ count: 0, maxMs: 0, totalMs: 0 }));
  it('ignores ticks that arrive on time', () =>
    expect(run([0, 10, 20, 31])).toEqual({ count: 0, maxMs: 0, totalMs: 0 }));
  it('records the blocked time of a late tick', () =>
    expect(run([0, 10, 80])).toEqual({ count: 1, maxMs: 60, totalMs: 60 }));
  it('does not count a block of exactly the threshold', () =>
    expect(run([0, 10, 70]).count).toBe(0));
  it('sums several long tasks', () =>
    expect(run([0, 100, 110, 300])).toEqual({ count: 2, maxMs: 180, totalMs: 270 }));
});
```

`processes.test.ts`:

- `parseCpuTime`:
  - `'0:01.23'` → 1.23, `'12:34.56'` → 754.56, `'125:00.00'` → 7500 (macOS);
  - `'01:02:03'` → 3723, `'2-01:02:03'` → 176523 (Linux);
  - `'1:02:03.50'` → 3723.5.

  Use `toBeCloseTo`.

- `parseProcessTable`:
  - The input holds a root line, a renderer line whose executable is `/Apps/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer) --type=renderer`, a blank line and a garbage line.
  - It gives 2 rows. The renderer has `rssBytes` 51200 × 1024 and `cpuSeconds` 3, and its `command` keeps the spaces.
- `processRole`: the root pid → `main`; `--type=renderer` → `renderer`; `--type=gpu-process` → `gpu`; `--type=utility` → `utility`; anything else → `other`.
- `descendantsOf`: rows 1←0, 101←1, 102←101, 103←102, 200←1 with root 101 → pids `[101, 102, 103]`.
- `summariseProcessSamples`, over samples at 0, 2,000 and 4,000 ms:
  - renderer 102 has CPU 1.0, 2.0 and 4.0 s and RSS 100, 100 and 120 MB;
  - renderer 104 appears only in the second sample, with CPU 5 s and RSS 50 MB;
  - main 101 has CPU 10, 10.5 and 11 s.

  Expected: renderer `{ meanCpuPercent: 75, maxCpuPercent: 100, maxRssBytes: 150 MB }`, main `{ meanCpuPercent: 25, maxCpuPercent: 25 }`, and `gpu` all zeros.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/benchmark`
Expected: FAIL, because the modules do not exist yet.

- [ ] **Step 3: Implement both modules**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/benchmark`
Expected: PASS.

- [ ] **Step 5: Commit** `Add long-task and process sampling for the view benchmark`

### Task 3: VS Code runner, driver and screenshots

**Files:**

- Create:
  - `test/benchmark/view/devtools.ts`, `test/benchmark/view/results.ts`, `test/benchmark/view/driver.ts`, `test/benchmark/view/runner.ts`;
  - `test/unit/benchmark/devtools.test.ts`, `test/unit/benchmark/results.test.ts`.
- Modify:
  - `test/benchmark/main.ts`: add the `view` and `serve` commands, and replace the shared `rate` default with per-command defaults (soak 1,000, view 500).
  - `scripts/benchmark.mjs`: also bundle `test/benchmark/view/driver.ts` to `out/benchmark/view-driver.js` with `vscode` external, and mark `@vscode/test-electron` external in the main bundle.

**Interfaces:**

- Consumes: Task 1's contract and histogram; Task 2's recorder and sampler; `startStreamServer` and `startHttpServer` from `test/support`.
- Produces:

  ```ts
  export interface DevToolsTarget {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }
  export function workbenchTarget(targets: readonly DevToolsTarget[]): DevToolsTarget | undefined;
  export function freePort(): Promise<number>;
  export function captureScreenshot(port: number, file: string): Promise<void>;

  export interface ExtensionHostResult {
    longTasks: LongTaskSummary;
    cpuPercent: number;
    baselineHeapBytes: number;
    maxHeapBytes: number;
    maxArrayBuffersBytes: number;
  }
  export interface DriverResult {
    mode: 'stream' | 'walkthrough';
    vscodeVersion: string;
    surface: StreamBenchmarkResult | undefined;
    extensionHost: ExtensionHostResult | undefined;
    typing: LatencySummary | undefined;
    error: string | undefined;
  }
  export interface ViewBenchmarkResult extends DriverResult {
    surfaceName: string;
    rate: number;
    seconds: number;
    eventBytes: number;
    processes: ProcessSummary;
    screenshots: string[];
  }
  export function readDriverResult(
    text: string | undefined,
    mode: DriverResult['mode'],
  ): DriverResult;
  export function checkSurfaceResult(result: StreamBenchmarkResult): string | undefined;
  export function runViewBenchmark(options: {
    surface: string;
    rate: number;
    seconds: number;
    eventBytes: number;
    walkthrough: boolean;
    extensions: readonly string[];
  }): Promise<ViewBenchmarkResult>;
  ```

- **`workbenchTarget`** picks the first target with `type === 'page'` whose `url` ends with `workbench.html`.
- **`captureScreenshot`:**
  - reads `http://127.0.0.1:<port>/json/list` with `node:http`;
  - sends `Page.captureScreenshot` `{ format: 'jpeg', quality: 80 }` over the target's WebSocket;
  - writes the decoded data.
- **`readDriverResult`:**
  - `undefined` gives an error result `The benchmark driver wrote no result.`
  - Unparsable text gives `The benchmark driver wrote an unreadable result.`
- **`checkSurfaceResult`** returns `<n> events never became visible.` when `visible < events`, and `undefined` otherwise.
- **The driver** (`export async function run(): Promise<void>`):
  1. Activates every extension whose id starts with `achrafelkhnissi.`.
  2. Waits up to 15 s for the mode's contract command to appear in `vscode.commands.getCommands(true)`. If it never appears, it writes the error `No response surface registered <command>. Pass --extension <path> to load one.`
  3. **Stream mode:**
     - opens an untitled editor in column 1;
     - starts the long-task recorder (ticking every 10 ms), the typing probe (every 100 ms, with a newline after 80 characters) and memory sampling (every second, with the baseline taken before the command);
     - runs `benchmarkCommands.stream` with `{ url, surface }`;
     - stops all probes.
  4. **Walkthrough mode:** requests the screenshot `<surface>-startup` first, then runs `benchmarkCommands.walkthrough` with `{ url, surface, controlUrl }`.
  5. Always writes a `DriverResult` to `STREAMSCOPE_BENCH_OUT` and resolves.
- **The runner:**
  1. Makes a sandbox in `os.tmpdir()` named `streamscope-view-*`, with a user data directory, an extensions directory, a workspace folder and the decision-7 settings.
  2. Starts the stream server and a control server. `GET /screenshot?name=` captures to `out/benchmark/screenshots/<name>.jpeg` and answers 200 with the path, or 500 with the message.
  3. The stream URL is `/stream?format=ndjson&rate=<rate>&seconds=<seconds>&size=<eventBytes>`. A walkthrough uses rate 20 for 120 s with 256-byte events.
  4. Downloads VS Code stable and spawns it with `detached: true` and these arguments:
     - the restricted runner's flags plus `--disable-workspace-trust`, `--remote-debugging-port=<freePort()>` and the decision-7 flags;
     - `--extensionDevelopmentPath` for the repository and for each `--extension` path;
     - `--extensionTestsPath=out/benchmark/view-driver.js`.

     The environment carries the contract variables with `STREAMSCOPE_BENCHMARK=1`, and drops `ELECTRON_RUN_AS_NODE`.

  5. Samples processes every 5 s.
  6. Kills the process group with `SIGKILL` after `seconds + 180` s (300 s for a walkthrough), with the error `VS Code did not finish within <n> s.`
  7. Reads the driver result with `readDriverResult`, applies `checkSurfaceResult` in stream mode, removes the sandbox, and writes the combined result to `out/benchmark/view-<surface>-<ISO time>.json`.
- **`npm run bench -- view`** options: `--surface` (default `webview`), `--rate` (500), `--minutes` (1), `--size` (1,024), `--walkthrough`, `--extension` (repeatable). It prints the JSON and sets exit code 1 when `error` is set.
- **`npm run bench -- serve`** prints the stream URL and serves until Ctrl+C.

- [ ] **Step 1: Write the failing tests**

- `workbenchTarget`:
  - picks `{ type: 'page', url: 'vscode-file://vscode-app/x/workbench/workbench.html' }` over an `iframe` target, a `service_worker` target and a `page` at another URL;
  - returns `undefined` for `[]`.
- `readDriverResult(undefined, 'stream').error` is `'The benchmark driver wrote no result.'`, and `readDriverResult('{', 'walkthrough').error` is `'The benchmark driver wrote an unreadable result.'`. A valid JSON `DriverResult` round-trips unchanged.
- `checkSurfaceResult`:
  - `{ events: 10, visible: 7, … }` gives `'3 events never became visible.'`;
  - `{ events: 10, visible: 10, … }` gives `undefined`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/benchmark`
Expected: FAIL, because the modules do not exist yet.

- [ ] **Step 3: Implement `devtools.ts`, `results.ts`, `driver.ts`, `runner.ts`, the `main.ts` commands and the bundling**

- [ ] **Step 4: Run the unit tests and the gate**

Run: `npx vitest run test/unit/benchmark && npm run check`
Expected: PASS.

- [ ] **Step 5: Smoke-test the stream mode with no surface**

Run: `npm run bench -- view --surface none --minutes 0.25; echo "exit $?"; ps -A -o command= | grep -c '[s]treamscope-view-'`
Expected:

- exit 1;
- the JSON's `error` is `No response surface registered streamscope.benchmark.stream. Pass --extension <path> to load one.`;
- `processes.main.maxRssBytes` and `processes.renderer.maxRssBytes` are above 0;
- the final count is 0, and no `streamscope-view-*` folder is left in the temporary directory.

- [ ] **Step 6: Smoke-test the walkthrough screenshots**

Run: `npm run bench -- view --walkthrough --surface none`
Expected:

- `screenshots` lists `out/benchmark/screenshots/none-startup.jpeg`, which starts with bytes `FF D8`.
- Opening it shows the VS Code window. If the DevTools port is refused, record a ruling and fall back to asking the user for screenshots in Task 6.

- [ ] **Step 7: Commit** `Add the VS Code view benchmark runner and driver`

### Task 4: Spike extension and the native prototype (throwaway)

**Files:**

- Create:
  - `spike/package.json` (name `streamscope-spike`, publisher `achrafelkhnissi`, `private`, engines `^1.101.0`, `main` `./dist/extension.js`, `activationEvents` `["onStartupFinished"]`);
  - `spike/tsconfig.json` (extends the root config, includes `src`);
  - `spike/build.mjs` (esbuild: `spike/src/extension.ts` to `spike/dist/extension.js`, CommonJS, Node, `vscode` external);
  - `spike/src/extension.ts`, `spike/src/stream.ts`, `spike/src/captured.ts`, `spike/src/native.ts`;
  - `spike/syntaxes/events.tmLanguage.json`.
- Modify:
  - `package.json`: add the script `spike:build`, and add `tsc --noEmit --project spike/tsconfig.json` to `typecheck`;
  - `eslint.config.mjs`: ignore `spike/dist/`.

**Interfaces:**

- Consumes: `NodeTransport`, `StreamSession`, `SpillArea`, `ResponseFileSystem` (reused under the scheme `streamscope-spike`), and Task 1's `benchmarkCommands`, `LatencyHistogram`, `sentAtOf` and `screenshotUrl`.
- Produces, for Task 5: `openSpikeStream({ url, spillRoot, onUpdate }): SpikeStream`.
  - `SpikeStream` holds `session`, `head`, `raw` (a decoded tail of at most 2 MiB), `status` (`'connecting' | 'streaming' | 'completed' | 'failed' | 'cancelled'`), `startedAt`, `stop()`, `done: Promise<status>` and `dispose(): Promise<void>`.
  - It also exports `capturedValues(store, count)`, which gives `threadId` and `runId` from the first `RUN_STARTED`, each `waiting` until then.
- Spill root: `<globalStorageUri>/spill`.

**What the native prototype must do** (contributed commands use the category `Streamscope Spike`):

- [ ] **Step 1: Build the stream pipeline and the native surface**

- **Backings:** `native-fs` writes through `ResponseFileSystem`. `native-content` uses a `TextDocumentContentProvider` on `streamscope-spike-content` with an `onDidChange` emitter.
- **Views:** one URI per view, `/<n>/events.streamscope-events`, `reply.md`, `raw.jsonl`, `headers.http`, `body.txt` and `checks.txt`. The Body view says that streams are shown in Raw; the Checks view says there are no checks yet.
- **Events lines:** `#000123  +00:12.345  TEXT_MESSAGE_CONTENT  {compact JSON, at most 200 characters}`. They are coloured by the spike grammar, and the trimming follows decision 4.
- **Updating:** on each `onUpdate`, only the open view is rebuilt.
- **Live status, Stop and captured values:**
  - CodeLenses on line 0 of each view: the status (state, event count, elapsed time, format and its reason), Stop, and `Captured: threadId = … · runId = …`. They refresh at most once a second.
  - A Stop button in the editor title while the stream runs, using the context key `streamscope.spikeRunning`.
- **Switching views:**
  - Editor title buttons for Events, Reply, Raw and Headers; Body and Checks go in the title's `…` menu.
  - A switch closes the current view's tab and opens the new one at the same place.
- **Event detail:**
  - Enter on an Events line (when `resourceExtname == .streamscope-events`) or a document link on `#index` opens `event-<index>.json` with pretty JSON.
  - It is shown in a peek through `editor.action.peekLocations`.
- **Capture entry point:** a code action `Capture This Value…` on detail documents. It shows `Prototype: would capture <path>` and writes nothing.
- **Show Older Events:** opens `older-<from>.streamscope-events` with 1,000 events read through `store.read`.
- **Benchmark command:**
  1. Opens Events in column 2 with `preserveFocus`.
  2. On each `onDidChangeTextDocument` of the Events document, reads the index on its last event line and records `now − sentAtOf(store.inMemory(i)?.value)` for every newly visible index.
  3. Resolves once the stream is done and the last index is visible, or 10 s after the stream ends.
  4. Closes its tabs and disposes everything.
- **Walkthrough command:**
  - streams the walkthrough URL and requests one screenshot per `walkthroughSteps` entry, using `node:http` to call `screenshotUrl(controlUrl, '<surface>-<step>')`;
  - waits 5 s before `events-live` and 2 s after each action;
  - puts the cursor on `"threadId"` in the detail document and runs `editor.action.quickFix` for `capture-entry`;
  - stops before `stopped`.

- [ ] **Step 2: Build and run the gate**

Run: `npm run spike:build && npm run check`
Expected: PASS.

- [ ] **Step 3: Smoke-test both native variants**

Run: `npm run bench -- view --surface native-fs --minutes 0.5 --extension spike`, then the same with `--surface native-content`.
Expected: no `error`; `surface.events` is 15,002 within 2%, `surface.visible` equals `surface.events`, and `latency.p95Ms` is a number.

- [ ] **Step 4: Commit** `Add the spike extension with the native response prototype`

### Task 5: Webview prototype (throwaway)

**Files:**

- Create: `spike/src/webview.ts`; `spike/webview/main.ts` and `spike/webview/tsconfig.json` (lib `es2023` plus `dom`).
- Modify:
  - `spike/build.mjs`: a second esbuild build for `spike/webview/main.ts` to `spike/dist/webview.js`, as a browser IIFE;
  - `spike/src/extension.ts`;
  - `package.json`: `typecheck` adds `spike/webview/tsconfig.json`.

**Interfaces:**

- Consumes: Task 4's `openSpikeStream` and `capturedValues`, and Task 1's contract and histogram.

- [ ] **Step 1: Build the webview surface**

- **Panel:**
  - opens in column 2 with `preserveFocus`, `enableScripts: true`, `localResourceRoots: [spike/dist]` and `retainContextWhenHidden: false`;
  - CSP: `default-src 'none'; script-src 'nonce-<n>'; style-src 'nonce-<n>'; img-src ${cspSource}; font-src ${cspSource}`, with a nonce of 32 bytes from `crypto.randomBytes`;
  - the styles go in one nonce'd `<style>`.
- **Layout** after the mockup:
  - a status pill with counts, elapsed time and format;
  - a Stop button;
  - a tab strip (`role="tablist"`, arrow keys) with Events, Reply, Raw, Headers, Body and Checks;
  - a captured-values strip.
- **Events list:**
  - `role="listbox"`, virtualized with fixed 22 px rows;
  - Up, Down, Home, End and Enter;
  - it follows the tail while scrolled to the bottom.
- **Event detail:** one event at a time, expanded inline under its row, with a `Capture This Value…` button that shows the same prototype message. The rows after it shift by the measured height of the detail.
- **Other tabs:** Reply and Raw are appended `<pre>` blocks, with a Raw tail of at most 2 MiB coloured with token spans. Headers is a table.
- **Content and styling:** all response content goes in through `textContent`; colours come only from `--vscode-*` variables.
- **Messages:**
  - Extension to webview:
    - `update`: count, status, elapsed time, format, captured values, at most 500 rows, appended reply text and appended raw text;
    - `detail`: index and pretty JSON;
    - `select`: a view;
    - `expand`: an index.

    At most one `update` goes out per session update.

  - Webview to extension: `window` (start and end), `rendered` (the newest index painted), `detail`, `stop`, `tab`, `capture`.
  - Rows are `{ index, time, label, preview }`. The extension sends only rows in the requested window, plus the newest rows while following the tail. Rows that are no longer in memory are read with `store.read`.
- **Benchmark and walkthrough commands:** the same flows as Task 4. Visibility is the `rendered` acknowledgement. The walkthrough drives tabs, detail and capture with `select` and `expand`.

- [ ] **Step 2: Build and run the gate**

Run: `npm run spike:build && npm run check`
Expected: PASS.

- [ ] **Step 3: Smoke-test the webview**

Run: `npm run bench -- view --surface webview --minutes 0.5 --extension spike`
Expected: no `error`, and `surface.visible` equals `surface.events`.

- [ ] **Step 4: Commit** `Add the webview response prototype`

### Task 6: API check and mockup walkthrough

**Files:**

- Create: `docs/decisions/response-surface/` with at most 8 JPEGs.
- Modify: `spike/**`, only for verifier findings.

- [ ] **Step 1: Run `vscode-api-verifier`** over `spike/` and `test/benchmark/view/driver.ts`. Fix every finding that would skew the comparison. An API that 1.101 lacks becomes a cost for that surface in the decision record, not a silent workaround.

- [ ] **Step 2: Run the walkthroughs**

Run: `npm run bench -- view --walkthrough --surface native-fs --extension spike`, then the same with `--surface webview`.
Expected: 9 screenshots per surface (startup plus the 8 steps) under `out/benchmark/screenshots/`.

- [ ] **Step 3: Review every screenshot**

- Open each screenshot and note, for each mockup item, how each surface does it and any workaround it needed. The items are tabs, live switching, event detail, Stop, captured values and the click-to-capture entry point, plus Body and Checks.
- Copy `events-live`, `detail`, `capture-entry` and `stopped` for both surfaces into `docs/decisions/response-surface/` as `<surface>-<step>.jpeg`. Each must be under 250 KB and show only synthetic data.

- [ ] **Step 4: Commit** `Record the response view walkthrough screenshots`, with the screenshots and any verifier fixes.

### Task 7: Benchmark runs

**Files:**

- Modify: `docs/benchmarks.md`

- [ ] **Step 1: Screening runs**

Run, one at a time: `npm run bench -- view --surface <s> --rate 500 --size 1024 --minutes 5 --extension spike` for `native-fs`, `native-content` and `webview`.
Expected: each without `error` (so every event became visible). Investigate any `error` before going on.

- [ ] **Step 2: Choose the native variant** by decision 3, and record the choice and the numbers as a ruling.

- [ ] **Step 3: 30-minute runs**

Run, in the background and one at a time: `npm run bench -- view --surface <chosen native> --rate 500 --size 1024 --minutes 30 --extension spike`, then the same for `webview`.
Expected: each without `error`, about 900,002 events.

- [ ] **Step 4: Record the runs** in a section `## <date>: M5 response view spike`:

- the commit, machine, macOS, Node and VS Code versions;
- one table per surface with rows for:
  - latency p50, p95 and max against p95 under 100 ms;
  - extension-host long tasks (count and max) against none over 50 ms;
  - typing round trip p95 and max;
  - extension-host CPU;
  - extension-host heap baseline, maximum and growth against 150 MB;
  - renderer CPU (mean and max) and renderer RSS maximum;
  - GPU CPU;
- the three screening runs in a short table.

Extend "How to run" with `view`, `--walkthrough`, `--extension` and `serve`, and say four things there:

- the view benchmark runs on macOS and Linux;
- it opens a VS Code window that must stay visible;
- the DevTools port is local to the throwaway profile;
- after M5 it needs a surface that registers the contract commands.

- [ ] **Step 5: Commit** `Record the response view spike benchmarks`

### Task 8: Decision record

**Files:**

- Create: `docs/decisions/response-surface.md`

- [ ] **Step 1: Write the record** with these sections:

- **Status:** "Proposed (<date>), awaiting the user's approval".
- **Context:** design section 13, the decision rule quoted, and the M5 roadmap entry.
- **What was built:** the two prototypes and the native variants. Give the commit that still contains `spike/` (Task 7's head), so the prototypes can be checked out.
- **Measurements:** Task 7's 30-minute numbers against each budget, with pass or fail.
- **Walkthrough:** a table with one row per item and columns Native and Webview, linking the screenshots. The rows:
  - Events live; switching tabs mid-stream; Reply; Raw colouring; Headers; Body; Checks;
  - event detail; Stop; live status; captured values; click-to-capture entry;
  - find and copy; keyboard and screen readers; theming.
- **Costs:**
  - native: each workaround it needed;
  - webview: hand-built accessibility, CSP and XSS surface, and no Accessible View.
- **Recommendation:** apply the decision rule literally. Native is recommended only if every budget passes and no supported item needs an awkward workaround; name each failing budget or workaround.
- **Consequences for M6:** the surface, its update strategy, the safeguards it keeps, and which benchmark contract commands it registers.

- [ ] **Step 2: Run the gate**

Run: `npm run format:check`
Expected: PASS.

- [ ] **Step 3: Commit** `Propose the response surface decision`

### Task 9: Remove the prototypes

**Files:**

- Delete: `spike/`
- Modify:
  - `package.json`: drop `spike:build` and the two spike `typecheck` entries;
  - `eslint.config.mjs`: drop the `spike/dist/` ignore;
  - `CLAUDE.md`, rewriting rows within the table's existing column widths:
    - layout row `src/benchmark/`: the latency histogram and the command contract between the view benchmark and a response view;
    - layout row `test/benchmark/`: add the VS Code response view benchmark;
    - the Stream benchmarks command row: add `npm run bench -- view`.

- [ ] **Step 1: Delete and revert**, then check that nothing references the spike.

Run: `git grep -n -e spike -e streamscope-spike -- ':!docs'`
Expected: no output.

- [ ] **Step 2: Run the gate and check that packaging is unchanged**

Run: `npm run check && npm run package:list`
Expected: the gate passes, and the VSIX lists the same files as on `main`.

- [ ] **Step 3: Check that the kept runner reports the missing surface**

Run: `npm run bench -- view --minutes 0.1`
Expected: exit 1 with the `No response surface registered` error.

- [ ] **Step 4: Commit** `Remove the response view prototypes`

### After the tasks

- **Final review:** a fresh whole-branch review on the most capable model, plus:
  - `extension-security-reviewer` on the kept tooling: process spawning, the DevTools port, the control server, and the webview safeguards as the record describes them;
  - `vscode-api-verifier` on `test/benchmark/view/driver.ts`.
- **One fix pass**, then push and open the pull request on the user's go-ahead.
- **When the user approves the choice:** set the record to "Accepted" and update design section 13 (Decision rule outcome) and the open questions row, in the same pull request.
