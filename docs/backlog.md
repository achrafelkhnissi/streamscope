# Streamscope backlog

Work that is not part of a milestone in [roadmap.md](roadmap.md) yet. An item gets a task plan and a place in the roadmap only after the user approves it.

## Performance regression testing in CI

- **Objective:** CI compares hot-path performance with a baseline and fails on regressions, instead of relying on manual runs recorded in [benchmarks.md](benchmarks.md).
- **Measures:**
  1. Streaming throughput and per-event cost (`npm run bench -- throughput`, NDJSON and SSE).
  2. Peak heap plus array buffers, and heap growth after warm-up, in a soak run (`npm run bench -- soak`).
  3. Normal response parsing and formatting, including bodies above the 1 MiB worker threshold (new benchmark).
  4. Memory with several streaming runs at once (new benchmark; needs a budget in [design](design.md) section 3).
- **Conditions:** pinned Node version and runner image; fixed event sizes, rates and durations; forced garbage collection before memory samples; one discarded warm-up run. Base and head run in the same job, so runner speed cancels out.
- **Statistics:** at least five runs per measure, compared by median, as the 50 MB integration test does with seven.
- **Thresholds:** set from the run-to-run spread of unchanged code measured on CI runners, not guessed. A median that regresses past its threshold fails the job, and so does any section 3 budget exceeded. Every number goes in the job summary.
- **Open points:** triggers (pull requests touching `src/transport`, `src/streaming`, `src/events` or `src/response`, and a scheduled run on `main`), cost of the macOS and Windows runners, and adding the response view benchmark from M5 once M6 registers its commands.

## Profile the response view at 1,000 events/s

- **Objective:** find the cause of the one 56.5 ms Streamscope task and the two extension host pauses (the longest 111 ms) in the 30-minute view run at 1,000 events/s ([benchmarks.md](benchmarks.md), M6). No budget failed, but neither was attributed.
- **Measures:**
  1. A 1,000 events/s view run with a CPU profile of the extension host, taken through VS Code's `--inspect-extensions` port, long enough to catch the task again.
  2. Extend `TaskTimer` to the panel flushes it misses: the feed's `setBody` when a run ends (`ended`), `select` and `expand`. Record when each task over 50 ms ran and which kind it was, so a long task can be matched to the profile.
- **Open points:** whether the pauses are garbage collection or VS Code's own work, which the profile should show; how long the run must be to reproduce a task seen once in 30 minutes.
