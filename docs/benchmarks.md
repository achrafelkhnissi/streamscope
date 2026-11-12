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

These runs measure the pipeline in plain Node. The latency and long-task budgets for the response view are measured in VS Code in M5.

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
