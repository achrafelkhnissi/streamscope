# M11 Hardening and Release Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a release candidate that strangers can install. Concretely:

- every design budget is measured and met;
- no High or Medium security finding is open;
- the response panel passes an accessibility and theme pass;
- the README, icon, changelog and Marketplace metadata are ready;
- a tag-triggered release workflow is tested up to its approval gate;
- `vsce package --pre-release` packages version `0.1.0`.

**Architecture:** little new product code.

- **Measurement:** an activation-time measurement and a VSIX size gate join the existing benchmarks.
- **Hardening:** the M10 review's deferred findings that a stranger would meet are fixed in the Testing view and file-run code.
- **Release:**
  - one workflow, `.github/workflows/release.yml`, follows `docs/publishing.md`;
  - the remaining work is documents and assets: README, `SECURITY.md`, `CHANGELOG.md`, the icon and recordings.

**Tech Stack:** TypeScript 6.0.3, VS Code API 1.101, esbuild, `@vscode/vsce`, GitHub Actions. Local authoring tools already installed: `ffmpeg`, ImageMagick (`magick`) and `actionlint`. Nothing is added to `package.json`.

**Spec:**

- **`docs/roadmap.md`:** M11.
- **`docs/design.md`:**
  - section 3 (the six budgets);
  - section 15 (security, Workspace Trust, privacy);
  - section 17 (performance and the benchmark harness);
  - section 18 (the Manual row: accessibility, themes);
  - section 19 (contributions and settings);
  - section 20 (packaging and publishing).
- **`docs/publishing.md`:** the whole file. It is the authority for the manifest, icon, README, versioning, changelog, packaging, release workflow and pre-publish checklist.
- **`CLAUDE.md`:** Performance, Security requirements, Verification.

## Global Constraints

- **Roadmap M11, verbatim:**
  - Includes: "benchmark run against every budget; security review with the `extension-security-reviewer` agent and optionally the `claude-security` scan; accessibility and theme pass; README with short screen recordings, settings reference and privacy statement; icon (PNG, at least 128×128, designed at 256×256); CHANGELOG; Marketplace listing metadata (categories, keywords); release workflow (design in [publishing.md](publishing.md)); a dry run with `vsce package --pre-release`."
  - Acceptance: "every budget met; no open high or medium security finding; README reviewed by the user; release workflow tested up to the approval gate."
- **Budgets (design section 3), verbatim:**
  - "An event is visible at most 100 ms (p95) after its last byte arrives, at sustained 500 events/s of 1 KiB events"
  - "No synchronous task of the extension blocks the extension host for more than 50 ms; typing in the editor stays smooth during a 30-minute stream"
  - "Extension heap stays under 150 MB regardless of stream length; older events live on disk"
  - "A 50 MB JSON body opens without freezing VS Code"
  - "Activation under 50 ms"
  - "Bundled extension under 400 KB"
- **Publishing (`docs/publishing.md`):**
  - **Icon:** "PNG, at least 128×128 px (designed at 256×256); SVG icons are not allowed", "Must read clearly on light and dark Marketplace themes", "No other product's marks".
  - **README:** "Images and recordings must use `https` URLs … Recordings live in the repository and are linked through `raw.githubusercontent.com`"; "`SECURITY.md` with a private reporting channel (GitHub security advisories)"; "All examples use synthetic APIs and data".
  - **Versions:** "Odd minor = pre-release, published with `--pre-release`"; "Plan: `0.1.x` pre-release for the team trial, `0.2.0` first public release".
  - **Packaging:**
    - "vsce's secret scan runs on every package; it must pass without allow flags";
    - "CI fails if the VSIX grows over 400 KB".
  - **Release workflow:**
    - "One workflow file, `.github/workflows/release.yml`, triggered by version tags";
    - "The same VSIX goes to both registries";
    - "The publish job has `id-token: write`, runs only in the `release` environment, and every action is pinned to a commit SHA";
    - "No long-lived publishing tokens are stored".
- **Security (`CLAUDE.md`):** run the `extension-security-reviewer` for changes touching credentials, environments, logging, rendering, file access or TLS. Record accepted security-guidance false positives in `.claude/claude-security-guidance.md`.
- **Process:**
  - no code comments;
  - synthetic data only;
  - TDD for code;
  - branch `m11-release-preparation` from `origin/main` after PR #24 (M10) merges, one commit per task;
  - nothing is published, and no tag, release or GitHub setting is created, without the user's go-ahead at that step;
  - the gate: `npm run check`, `npm run test:integration` (every label), `npm run test:restricted`, `npm run verify:vsix`.

## Steps that need you

Execution pauses at each of these and asks. Everything else runs unattended.

1. **Icon:** choose one of the rendered variants (Task 5).
2. **VoiceOver:** the VoiceOver pass on the response panel and the Testing view, from the checklist Task 4 prepares (it also closes your open M6 task).
3. **README:** review it (roadmap acceptance; Task 6).
4. **Release workflow test** (Task 7):
   - create the GitHub `release` environment with you as required reviewer, or let me create it with `gh`, on your yes;
   - allow one `workflow_dispatch` dry run of `release.yml`, which stops at the approval gate, where you reject it.

## Decisions this plan makes (approving the plan approves them)

1. **Version `0.1.0`:** `package.json` moves to `0.1.0`, the first pre-release (odd minor). `CHANGELOG.md` turns `Unreleased` into a `0.1.0` section in Keep a Changelog style (Added, Changed, Fixed, Security). M12 publishes it.
2. **Measuring activation:**
   - esbuild adds the banner `const streamscopeLoadedAt = performance.now();` to `dist/extension.js`;
   - `activate()` records `performance.now() - streamscopeLoadedAt` when it returns, which covers bundle evaluation plus activation;
   - the value is logged as "Extension activated in N ms" and returned by `streamscope.benchmark.activation` (benchmark mode only);
   - `npm run bench -- activation` starts VS Code 5 times on a folder with one `.http` file and reports the median, and the 50 ms budget is checked there;
   - CI runners are too noisy for a 50 ms assertion, so CI only checks that the value is recorded.

   Design section 3's Startup row changes from "nothing loads until a `.http` file opens or a command runs" to say that a workspace containing `.http` or `.rest` files also activates (M10).

3. **VSIX size:** `scripts/verify-vsix.mjs` fails when the VSIX is over 409,600 bytes (400 KiB), with "The VSIX is N KB, over the 400 KB budget." CI's `package` job already runs it.
4. **Hardening scope:** the M10 deferred findings a stranger would meet are fixed (Tasks 2 and 3). The other deferred minors stay in their PR descriptions.
5. **Flaky timing tests (needs your yes, since it changes how tests measure):**
   - the M7 host-stall tests that measure one run against a 100 ms or 50 ms bound get `fastestOf(3, …)`, as most stall tests already do;
   - the bounds stay the same;
   - the tests affected are the ones that failed on PR #21, #23 and #24 runners.

   If you say no, Task 8 drops this step, and those tests keep failing now and then on CI runners.

6. **Recordings:**
   - two short GIFs, a live NDJSON stream and a file run in the Testing view, recorded from a real VS Code window;
   - frames come from the Chrome DevTools Protocol screencast (`Page.startScreencast`), driven by the existing benchmark runner, at 10 frames/s, and are assembled with the local `ffmpeg`;
   - each GIF is at most 8 MB and 1,200 px wide, stored in `images/`, linked through `raw.githubusercontent.com`, and left out of the VSIX;
   - synthetic server and data only.
7. **Icon:**
   - a simple vector mark drawn as `images/icon.svg`: an event stream, three rising bars or pulses, inside a rounded square, without other products' marks;
   - rendered to `images/icon.png` at 256×256 with ImageMagick;
   - three colour variants are shown to you on light and dark backgrounds, and the chosen one also gives `galleryBanner.color` and `theme`;
   - only `images/icon.png` joins the VSIX `files` list.
8. **Release workflow:** follows publishing.md's diagram.
   - **Triggers:**
     - tags `v[0-9]+.[0-9]+.[0-9]+`;
     - `workflow_dispatch` with a `version` input, which builds, tests and packages, then waits at the `release` environment and never publishes without approval.
   - **Jobs:**
     - `check` (the CI matrix);
     - `package` (once, `--pre-release` on odd minors, VSIX uploaded as an artifact);
     - `publish-marketplace`: `npx vsce publish --oidc --packagePath streamscope-VERSION.vsix`, adding `--pre-release` on odd minors, with `id-token: write` and environment `release`;
     - `publish-open-vsx`: `ovsx publish streamscope-VERSION.vsix` with Open VSX trusted publishing. It runs only when the repository variable `OPEN_VSX_TRUSTED` is `true`, which M12 sets after its first token publish. `ovsx` (approved in Phase 2, deferred until first use) joins `devDependencies`, pinned, and Task 7 checks its trusted-publishing flag against `npx ovsx publish --help` before using it;
     - `github-release` (needs both publish jobs; attaches the VSIX and the changelog section).
   - **Constraints:** every action pinned to a commit SHA; `actionlint` must pass.
9. **SECURITY.md:** says to report privately through GitHub security advisories ("Report a vulnerability"), names the supported version line (`0.x`, latest only) and describes what Streamscope never does (no telemetry, no traffic but your requests). The README links it.

## Review Focus

1. **The release workflow publishing without approval:** a tag push or a dispatch must never reach `vsce publish` or `ovsx publish` unless the `release` environment approves it. `ovsx` stays off until M12 enables it. Pinned in Task 7 by a test that parses `release.yml` and asserts:
   - each publish job's `environment` and `permissions`;
   - its `needs`;
   - that no step uses a secret named like a token.
2. **Masked text in the Testing view after hardening:** item ids, error labels and messages for files outside the workspace, symlinked files or oversize files must not echo credentials or read outside the workspace. Pinned in Task 2.
3. **The VSIX contents after adding the icon:** the icon is in, while recordings, `icon.svg` and test fixtures are out. Pinned in Task 5 by `npm run package:list` compared against an expected list in `test/unit/manifest.test.ts`.
4. **Activation work grown by M10's `workspaceContains`:** opening a workspace with hundreds of `.http` files must not parse them at activation. Discovery is lazy, so only open documents are parsed. Pinned in Task 1 by the activation benchmark with a 300-file workspace.
5. **Theme contrast in the response panel and decorations:** high-contrast light and dark themes must keep every state readable, including the check ✓ / ✗ marks, which are uncoloured. Pinned in Task 4 by the four-theme walkthrough screenshots and the checklist.

---

### Task 1: Startup and size budgets

**Files:**

- Modify:
  - `esbuild.mjs` (banner for the extension bundle only);
  - `src/extension.ts` (`declare const streamscopeLoadedAt: number`, record and log the activation time);
  - `src/vscode/benchmark/commands.ts` (`streamscope.benchmark.activation`);
  - `scripts/verify-vsix.mjs`;
  - `docs/design.md` section 3.
- Create:
  - `scripts/vsix-budget.mjs`, exporting `maxVsixBytes = 409_600` and `vsixBudgetProblem(bytes: number): string | undefined`;
  - `test/benchmark/activation.ts`, the `activation` command of `test/benchmark/main.ts`.
- Test:
  - `test/unit/vsix-budget.test.ts`;
  - `test/integration/activation.test.ts`.

- [ ] **Step 1: Write the failing tests**
  - `vsix-budget.test.ts`:
    - `it('accepts a VSIX up to 400 KB')`: 409,600 bytes gives `undefined`;
    - `it('rejects a larger VSIX with its size')`: 409,601 bytes gives "The VSIX is 400.0 KB, over the 400 KB budget.", in the existing `formatBytes` style.
  - `activation.test.ts`, `it('records how long activation took')`: the test command `streamscope.test.activationMs` returns a finite number greater than 0, and the log has a line starting "Extension activated in".
- [ ] **Step 2: Run them and watch them fail**

  Run `npx vitest run test/unit/vsix-budget.test.ts`, then `npm run build && npx vscode-test --label stable --grep "activation"`.

- [ ] **Step 3: Implement**
- [ ] **Step 4: Add `npm run bench -- activation [--files N]`**

  It reuses the `view` runner's throwaway profile. It opens a folder with N `.http` files (default 1, also run with 300) and starts VS Code 5 times. Each time it reads `streamscope.benchmark.activation` after opening the folder, then prints the median and the maximum.

- [ ] **Step 5: Run the tests and the benchmark**

  Run `npm run check`, `npm run test:integration` and `npm run verify:vsix`, then `npm run bench -- activation` and `npm run bench -- activation --files 300`. Record the medians for Task 8.

- [ ] **Step 6: Commit**

  `git commit -m "Measure activation time and gate the VSIX size"`

---

### Task 2: Testing view hardening

**Files:**

- Create: `src/runs/test-file.ts`, `test/unit/runs/test-file.test.ts`.
- Modify: `src/vscode/testing/items.ts`, `src/vscode/testing/register.ts`, `src/vscode/testing/run.ts`.
- Test:
  - `test/integration/testing.test.ts`;
  - `test/integration-workspace/discovery.test.ts`;
  - `test/restricted/index.ts`.

**Interfaces:**

- Produces:
  - `export const maxTestFileBytes = 1_048_576` in `src/runs/test-file.ts`;
  - `isTestedUri(uri: vscode.Uri): boolean`, true for the `file` and `untitled` schemes only.
  - `testFileProblem(file: { symbolicLink: boolean; file: boolean; size: number }): string | undefined` in `src/runs/test-file.ts`, using `maxTestFileBytes`, which moves there.

- [ ] **Step 1: Write the failing tests**
  - `it('gives unnamed requests an id with the URL user info masked')`: `GET https://user:secret@api.example.test/` gives an id containing `••••••@api.example.test` and not `secret`. The run key used for runs and captures does not change.
  - `it('clears a file error once the file reads again')`: workspace label. Writing a 1,048,577-byte `big.http` shows "This file is larger than 1 MiB, so Streamscope does not list its requests." and no children. Rewriting it with one request clears the error and lists the request after the watcher reloads it.
  - `it('refuses symbolic links, non-files and oversize files')`, a unit test in `test/unit/runs/test-file.test.ts` for the pure `testFileProblem({ symbolicLink, file, size }): string | undefined` in `src/runs/test-file.ts`. It covers "Streamscope does not read linked files.", "This is not a file." and the oversize message, so no platform needs symlink privileges.
  - `it('runs the other files when one file cannot be opened')`: a request run that includes a file deleted after discovery and a healthy file. The deleted file's item is errored with "Streamscope could not open FILE: REASON" and the healthy file's requests pass.
  - `it('refuses Run File for a file outside the workspace')`: workspace label, a URI outside the folder. The message reads "Run File runs .http files in this workspace or untitled ones.", and nothing runs.
  - `it('lists and runs only local and untitled documents')`: an http document on a `FileSystemProvider` the test registers (scheme `streamscope-test`) gets no item, and Run File refuses it.
- [ ] **Step 2: Run them and watch them fail**

  Run: `npm run build && npm run compile:host-tests && npx vscode-test --label stable --grep "testing view" && npx vscode-test --label workspace-stable`
  Expected: the new tests fail.

- [ ] **Step 3: Implement**
  - `load` calls `workspace.fs.stat` first. It refuses a `SymbolicLink`, a non-`File` and anything over `maxTestFileBytes`, each with its own `item.error`.
  - `sync` sets `error = undefined`.
  - Discovery, the watcher and `planOf` keep only `isTestedUri` URIs.
  - `runTests` catches a failed `openTextDocument` per file, errors that file's item and goes on.
  - The request item id uses `maskUrl` on the URL; `RequestTest.key` keeps the raw key.
  - Run File accepts a URI only when it is in a workspace folder, untitled, or the active editor's document.
- [ ] **Step 4: Run `npm run test:integration` and `npm run test:restricted`, and see them pass**
- [ ] **Step 5: Commit**

  `git commit -m "Harden the Testing view against unusual files"`

---

### Task 3: File run results hardening

**Files:**

- Modify:
  - `src/checks/registry.ts`;
  - `src/runs/file-run.ts`;
  - `src/vscode/testing/run.ts`.
- Test:
  - `test/unit/checks/registry.test.ts`;
  - `test/unit/runs/file-run.test.ts`.

**Interfaces:**

- Changes:
  - `CheckRegistry.settled(key, runId)` resolves `undefined` when the run's entries are not known: evicted, replaced or never registered;
  - the file run's `checks` hook returns `[]` itself for a request without `# @expect` lines, without asking the registry.

- [ ] **Step 1: Write the failing tests**
  - `it('resolves undefined for a run whose checks were evicted or replaced by a run without checks')`
  - `it('stops waiting for checks and captures when the run is stopped')`: `runFile` with a `checks` hook that never settles, then abort. The step is reported skipped with "The file run was stopped." within one turn, and nothing more starts.
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Implement**

  Race the `checks` and `secrets` waits against the abort signal. On abort, report the request skipped.

- [ ] **Step 4: Run `npx vitest run test/unit/runs test/unit/checks` and the `file runs` integration tests, and see them pass**
- [ ] **Step 5: Commit**

  `git commit -m "Never report a pass for checks that were lost, and stop promptly"`

---

### Task 4: Security review, accessibility and theme pass

**Files:**

- Create: `docs/accessibility.md` (the checklist and its results).
- Modify:
  - whatever the review and the pass find, each fix with a test that fails first;
  - `.claude/claude-security-guidance.md` for accepted false positives.

- [ ] **Step 1: Security review of the whole extension**

  Run the `extension-security-reviewer` on all of `src/`, not a diff. Include `docs/design.md` section 15 and every Testing view, file-run and `# @until` path. Optionally run the `security-review` skill as well.

  Fix every Critical, High and Medium finding with a failing test first. Record each Low as fixed, or accepted with a reason, in this task's commit message and the PR description.

- [ ] **Step 2: Theme pass**

  Run `npm run bench -- view --walkthrough --surface m11-<theme> --theme "<theme>"` for:
  - Default Dark Modern;
  - Default Light Modern;
  - Default High Contrast;
  - Default High Contrast Light.

  In each theme, check that the following are readable and that the focus is visible:
  - the panel tabs, the event list, a selected event, the status line;
  - the Checks tab with a passed and a failed check;
  - the capture strip;
  - the ✓ / ✗ decorations;
  - the Testing view with passed, failed, errored and skipped results.

  Record the screenshots' paths and each finding in `docs/accessibility.md`.

- [ ] **Step 3: Keyboard-only pass**

  Drive a real window over DevTools, using the M8 walkthrough method. Then do the following without the mouse:
  - send a request;
  - Tab through the panel;
  - switch views with the keyboard;
  - open an event;
  - capture a value from the Body document;
  - run a file from the Command Palette;
  - stop it.

  Record each step's result.

- [ ] **Step 4: Prepare the VoiceOver checklist (needs you)**

  Write it in `docs/accessibility.md`. For each item, the expected announcement:
  - the panel's landmarks and tab names;
  - the live status announcements while streaming;
  - an event's label;
  - a check's state word;
  - a capture's state;
  - the Testing view's results.

  Ask the user to run it, and record their results.

- [ ] **Step 5: Fix what the passes found, each with a test that fails first where a test can see it, and commit**

  `git commit -m "Fix the M11 security, accessibility and theme findings"`

---

### Task 5: Icon and Marketplace metadata

**Files:**

- Create:
  - `images/icon.svg`;
  - `images/icon.png` (256×256);
  - `images/icon-variants/` (removed again after the choice).
- Modify:
  - `package.json`:
    - `icon`;
    - `galleryBanner`;
    - `pricing: "Free"`;
    - `version: "0.1.0"`;
    - `files` gains `images/icon.png`.
  - `test/unit/manifest.test.ts`.

- [ ] **Step 1: Write the failing manifest tests**
  - `it('ships a 256×256 PNG icon')`: `icon` is `images/icon.png`, the file starts with the PNG signature, and its IHDR width and height are 256.
  - `it('carries the Marketplace listing fields')`:
    - `pricing` is `Free`;
    - `galleryBanner.theme` is `dark` or `light`;
    - `preview` is `true`;
    - `categories` and `keywords` equal publishing.md's lists.
  - `it('packages only the listed files')`: `vsce ls --no-dependencies` output equals the expected list, with `images/icon.png` and without `images/*.gif`, `images/icon.svg` and `test/`.
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Draw three variants and render them**

  Run `magick -background none -density 384 images/icon.svg -resize 256x256 images/icon.png`. Put each variant on a light and a dark 512×256 preview, and ask the user to choose (needs you).

- [ ] **Step 4: Apply the choice, delete the other variants and set the metadata**
- [ ] **Step 5: Run `npx vitest run test/unit/manifest.test.ts` and `npm run verify:vsix`, and see them pass**
- [ ] **Step 6: Commit**

  `git commit -m "Add the icon and the Marketplace listing fields"`

---

### Task 6: README, recordings, SECURITY.md and CHANGELOG

**Files:**

- Create:
  - `SECURITY.md`;
  - `images/live-stream.gif`;
  - `images/file-run.gif`;
  - `test/benchmark/record.ts`, the `record` command: `npm run bench -- record --scene stream|file-run`.
- Modify:
  - `README.md`;
  - `CHANGELOG.md`;
  - `test/unit/manifest.test.ts`.

- [ ] **Step 1: Write the failing documentation tests**
  - `it('documents every setting in the README')`: every `contributes.configuration` property name appears in the README's settings table with its default.
  - `it('documents every command in the README')`: every contributed command's title appears.
  - `it('links images through raw.githubusercontent.com over https')`: every image in the README uses `https://raw.githubusercontent.com/achrafelkhnissi/streamscope/main/images/`.
  - `it('has a 0.1.0 changelog section with Keep a Changelog headings')`
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Record the two scenes**
  - **Scenes:** each runs at most 12 s:
    - a 500 events/s NDJSON stream in the Events view;
    - a three-request file run with one skipped dependant in the Testing view.
  - **Recording:** frames come from `Page.startScreencast` (JPEG, quality 80, `everyNthFrame` 1), written to `out/record/<scene>/`. ffmpeg assembles them at 10 frames/s with a palette pass:

    ```bash
    ffmpeg -framerate 10 -i out/record/stream/%05d.jpeg -vf "scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" images/live-stream.gif
    ```

  - **Limits:** each GIF is at most 8 MB.
- [ ] **Step 4: Rewrite the README** following publishing.md's section list:
  - what it does, with the stream GIF;
  - a quick start;
  - `.http` syntax and the Streamscope directives;
  - captures, checks and file runs, with the file-run GIF;
  - environments and secrets;
  - a settings reference table;
  - commands;
  - coexistence with REST Client;
  - privacy: "Streamscope sends no telemetry, needs no account, and makes no network requests except the ones you send";
  - security notes;
  - restricted workspaces;
  - development.
- [ ] **Step 5: Write `SECURITY.md` and the `0.1.0` changelog section**

  The changelog groups M2 to M11 under Added, Changed, Fixed and Security, with the M11 hardening under Security.

- [ ] **Step 6: Run the tests and see them pass. Ask the user to review the README (needs you), and apply their changes**
- [ ] **Step 7: Commit**

  `git commit -m "Write the README, security policy and 0.1.0 changelog"`

---

### Task 7: Release workflow and dry run

**Files:**

- Create:
  - `.github/workflows/release.yml`;
  - `test/unit/release-workflow.test.ts`.
- Modify:
  - `docs/publishing.md`: the dispatch dry run, the `OPEN_VSX_TRUSTED` variable, and the environment created in M11.

- [ ] **Step 1: Write the failing workflow tests**

  They read `release.yml` as text, with no YAML library: `js-yaml` is only an indirect dependency. A helper splits the file into job blocks (each line from a two-space-indented `name:` key to the next), and the tests assert with regular expressions on those blocks:

  - `it('runs on version tags and on a manual dispatch')`
  - `it('publishes only from the release environment with id-token write')`: both publish jobs have `environment: release`, `permissions: { id-token: write, contents: read }`, and `needs: package`.
  - `it('pins every action to a commit SHA')`: every `uses:` matches `@[0-9a-f]{40}`.
  - `it('stores no publishing token')`: no `secrets.` reference other than `GITHUB_TOKEN`.
  - `it('keeps Open VSX publishing off until OPEN_VSX_TRUSTED is true')`
  - `it('packages once and reuses the VSIX')`: the publish jobs download the `vsix` artifact and never run `vsce package`.

- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Write the workflow, run `actionlint` and see it pass**
- [ ] **Step 4: Dry-run the packaging locally**

  Run `npx vsce package --pre-release --no-dependencies` and `npm run package:list`.
  Expected: `streamscope-0.1.0.vsix`, at most 400 KB; vsce's secret scan passes with no allow flags; the file list equals Task 5's.

- [ ] **Step 5: Test up to the approval gate (needs you)**
  1. On your yes, create the `release` environment with you as required reviewer: `gh api -X PUT repos/achrafelkhnissi/streamscope/environments/release` with your user id as reviewer, deployment branches limited to protected branches and `v*` tags. You can also do this in the repository settings.
  2. After the workflow is merged to `main`, dispatch it with `version=0.1.0`.
  3. Expected: `check` and `package` pass, and both publish jobs wait for review. You reject them.
  4. Record the run's URL in `docs/publishing.md`.
- [ ] **Step 6: Commit**

  `git commit -m "Add the release workflow"`

---

### Task 8: Budgets run, timing-test stability and gate

**Files:**

- Modify:
  - `docs/benchmarks.md` (an "M11 release candidate" section);
  - with decision 5's yes, the M7 timing tests: `test/unit/capture/stream-captures.test.ts`, `test/unit/capture/tracker.test.ts`, `test/unit/capture/body.test.ts`, `test/unit/expressions/jsonpath.test.ts`.

- [ ] **Step 1: With decision 5's yes, wrap the one-shot stall measurements in `fastestOf(3, …)`**

  Keep every bound. Run `npm run check` five times in a row and see no timing failure.

- [ ] **Step 2: Run every budget and record the results in `docs/benchmarks.md`**

  | Budget                                        | Command                                                                                    | Pass                                    |
  | --------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
  | Latency p95 ≤ 100 ms at 500 events/s of 1 KiB | `caffeinate -d -i npm run bench -- view --surface m11 --rate 500 --size 1024 --minutes 30` | p95 ≤ 100 ms                            |
  | No task over 50 ms; typing stays smooth       | the same run                                                                               | `tasksOverBudget` 0, typing p95 ≤ 50 ms |
  | Heap under 150 MB                             | `npm run bench -- soak --format ndjson --rate 1000 --minutes 30`                           | peak heap plus array buffers < 150 MB   |
  | 50 MB body                                    | the existing 50 MB integration test                                                        | passes                                  |
  | Activation under 50 ms                        | `npm run bench -- activation` and `--files 300`                                            | median < 50 ms                          |
  | VSIX under 400 KB                             | `npm run verify:vsix`                                                                      | passes                                  |

  A budget that fails becomes a finding. Fix it with a measurement before and after, or stop and ask the user.

- [ ] **Step 3: Run the gate**

  `npm run check`, `npm run test:integration`, `npm run test:restricted`, `npm run verify:vsix`.

- [ ] **Step 4: Run `vscode-api-verifier` and `extension-security-reviewer` on the branch, then the final review and one fix pass**
- [ ] **Step 5: Walk publishing.md's pre-publish checklist and tick what M11 can tick**

  The display name check and the post-publish installs stay for M12.

- [ ] **Step 6: Commit**

  `git commit -m "Record the release candidate's budgets"`
