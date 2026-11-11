# M0 Foundation and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The project carries the Streamscope identity, ships with an MIT license and repository metadata, and runs its checks in GitHub Actions on Linux, macOS and Windows.

**Architecture:** No product code. The manifest, the one existing command, the tests that name them, and the docs move from the placeholder identity to Streamscope; CI and Dependabot are added; the first commit is pushed to the empty public repository only after the user's go-ahead.

**Tech Stack:** npm, TypeScript 6.0.3, esbuild, ESLint, Prettier, Vitest, @vscode/test-cli, @vscode/vsce 4.1.0, GitHub Actions.

**Spec:** `docs/design.md` (sections 19 and 20), `docs/roadmap.md` (M0), `docs/publishing.md` (Manifest, Packaging).

## Global Constraints

- Extension id `achrafelkhnissi.streamscope`: `name` `streamscope`, `publisher` `achrafelkhnissi`.
- Display name `Streamscope: HTTP Client with Live Streaming`; command category `Streamscope`; command and settings prefix `streamscope.`.
- `description`: `Send requests from .http files and watch streaming responses (NDJSON, SSE, LLM streams) arrive event by event. Capture values from any event and reuse them.`
- License MIT, `Copyright (c) 2026 Achraf El Khnissi`.
- Repository `https://github.com/achrafelkhnissi/streamscope`.
- `engines.vscode` stays `^1.101.0` with `@types/vscode` `1.101.0`.
- `extensionKind: ["workspace", "ui"]`; `preview: true`.
- `categories`: `Programming Languages`, `Testing`, `Other`; `keywords`: `http`, `rest`, `rest client`, `api`, `sse`, `server-sent events`, `ndjson`, `streaming`, `llm`, `agent`, `ag-ui`, `api testing`.
- No code comments anywhere, including YAML. GitHub Actions pinned to full commit SHAs.
- No new npm dependencies.
- Committing and pushing need the user's explicit go-ahead; the active `gh` account is never switched.

## Review Focus

- **Windows line endings:** a Windows checkout with `core.autocrlf` turns files into CRLF and `prettier --check` fails. `.gitattributes` forces LF; the Windows CI job running `npm run check` proves it.
- **Stale identity:** any leftover `httpClient.` or `local-dev` reference (apart from the VSIX test harness) breaks activation or tests. Task 1 ends with a grep that must find none.
- **License packaging:** without `--skip-license`, vsce stops if `LICENSE` is missing from the package. The manifest test asserts `files` lists it, and `npm run verify:vsix` packages without the flag.
- **Headless Linux:** integration tests need a display on Ubuntu runners. CI runs them under `xvfb-run -a`.
- **Install scripts:** `.npmrc` sets `ignore-scripts`, so esbuild must work from its platform package on every runner. `npm ci && npm run build` in the CI matrix proves it.

---

### Task 1: Streamscope identity, license and metadata

**Files:**

- Modify: `package.json`
- Modify: `src/extension.ts`
- Modify: `test/unit/manifest.test.ts`
- Modify: `test/integration/activation.test.ts`
- Modify: `test/vsix/installed-extension.ts`
- Create: `LICENSE`
- Create: `.gitattributes`
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

**Interfaces:**

- Produces: command `streamscope.showLog` (title `Show Log`, category `Streamscope`); log output channel named `Streamscope`; extension id `achrafelkhnissi.streamscope` used by the integration and VSIX tests.

- [ ] **Step 1: Write the failing manifest tests**

Extend `test/unit/manifest.test.ts` (keep the existing `@types/vscode` and `main` tests):

```ts
it('carries the Streamscope identity', () => {
  expect(manifest.name).toBe('streamscope');
  expect(manifest.publisher).toBe('achrafelkhnissi');
  expect(manifest.displayName).toBe('Streamscope: HTTP Client with Live Streaming');
  expect(manifest.license).toBe('MIT');
  expect(manifest.repository).toEqual({
    type: 'git',
    url: 'https://github.com/achrafelkhnissi/streamscope.git',
  });
  expect(manifest.bugs).toEqual({ url: 'https://github.com/achrafelkhnissi/streamscope/issues' });
  expect(manifest.homepage).toBe('https://github.com/achrafelkhnissi/streamscope#readme');
});

it('runs in the workspace extension host', () => {
  expect(manifest.extensionKind).toEqual(['workspace', 'ui']);
});

it('ships the license and changelog', () => {
  expect(manifest.files).toEqual(['dist/extension.js', 'CHANGELOG.md', 'LICENSE']);
});
```

Change the command test so every command matches `/^streamscope\.[a-z][A-Za-z]+$/` and has category `Streamscope`. Add the new fields to the `Manifest` interface.

- [ ] **Step 2: Run the unit tests to see them fail**

Run: `npm run test:unit`
Expected: FAIL on identity, extension kind, files and command prefix.

- [ ] **Step 3: Update `package.json`**

Set the Global Constraints values (`name`, `publisher`, `displayName`, `description`, `license`, `repository`, `bugs`, `homepage`, `categories`, `keywords`, `extensionKind`, `preview: true`, `files`), rename the command to `streamscope.showLog` with category `Streamscope`, and change `scripts.package` to `vsce package --no-dependencies`. Keep `private: true`.

- [ ] **Step 4: Update the code and host tests**

`src/extension.ts`: register `streamscope.showLog` and name the output channel `Streamscope`. `test/integration/activation.test.ts`: `extensionId = 'achrafelkhnissi.streamscope'` and execute `streamscope.showLog`. `test/vsix/installed-extension.ts`: assert and execute `streamscope.showLog`. The harness in `test/vsix/harness/` keeps its own `local-dev` publisher.

- [ ] **Step 5: Add `LICENSE`, `.gitattributes` and doc updates**

`LICENSE`: the standard MIT text with `Copyright (c) 2026 Achraf El Khnissi`. `.gitattributes`: `* text=auto eol=lf`. `README.md`: title `Streamscope`, command name **Streamscope: Show Log**. `CHANGELOG.md`: under Unreleased, "Renamed to Streamscope; MIT license; CI on Linux, macOS and Windows." `CLAUDE.md`: replace the placeholder-identity sentence with the final identity, and drop the note that `npm run package` skips the license and repository checks.

- [ ] **Step 6: Run every local check**

Run: `npm run check && npm run test:integration && npm run verify:vsix`
Expected: all pass; `verify:vsix` prints `achrafelkhnissi.streamscope activated from the isolated profile`, and the package step prints no license or repository warning.

- [ ] **Step 7: Check for leftovers**

Run: `grep -rn -E "httpClient|local-dev|HTTP Client \(working title\)" --include='*.ts' --include='*.json' --include='*.md' --include='*.mjs' . | grep -v -E "node_modules|test/vsix/harness|docs/"`
Expected: no output.

### Task 2: Continuous integration and Dependabot

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`

**Interfaces:**

- Consumes: npm scripts `check`, `test:integration`, `verify:vsix` from Task 1.
- Produces: workflow `CI` with jobs `check` (matrix) and `package`; artifact `vsix`.

- [ ] **Step 1: Resolve action SHAs**

Run `gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha` (dereferencing annotated tags with `git/tags/<sha>` when `object.type` is `tag`) for `actions/checkout` `v7.0.1`, `actions/setup-node` `v7.1.0`, `actions/cache` `v6.1.0`, `actions/upload-artifact` `v7.0.2`.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

- Triggers: `push` to `main`, `pull_request`. Top-level `permissions: contents: read`. `concurrency` per ref with `cancel-in-progress: true`.
- Job `check`: matrix `os: [ubuntu-latest, macos-latest, windows-latest]`, `fail-fast: false`. Steps: checkout; setup-node with `node-version-file: .nvmrc` and `cache: npm`; cache `.vscode-test` keyed on `runner.os` and `hashFiles('.vscode-test.mjs')`; `npm ci`; `npm run check`; integration tests with `xvfb-run -a npm run test:integration` when `runner.os == 'Linux'`, otherwise `npm run test:integration`.
- Job `package`: `needs: check`, `runs-on: macos-latest`; checkout, setup-node, the same `.vscode-test` cache, `npm ci`, `npm run verify:vsix`, upload `*.vsix` as artifact `vsix`.
- Every `uses:` is pinned to the SHA from Step 1, with no comments.

- [ ] **Step 3: Write `.github/dependabot.yml`**

Version 2; ecosystem `npm` at `/` and `github-actions` at `/`, both `interval: weekly`, `cooldown: default-days: 7`; npm dev dependencies grouped into one pull request.

- [ ] **Step 4: Validate locally**

Run: `npx prettier --check .github && node -e "for (const f of ['.github/workflows/ci.yml','.github/dependabot.yml']) require('fs').readFileSync(f,'utf8')"` and `npm run check`.
Expected: pass. The workflow itself is proven in Task 3.

### Task 3: First commit, push and green CI (needs the user's go-ahead)

**Files:** none changed.

- [ ] **Step 1: Confirm the push identity**

Run: `ssh -T git@github.com` (expects `Hi achrafelkhnissi!`) and `git config user.email` (expects the personal address). Stop and ask if either is different.

- [ ] **Step 2: Review what will be committed**

Run: `git status --short` and `git ls-files --others --exclude-standard`; confirm no `.claude/settings.local.json`, `.claude/state/`, `*.vsix`, `node_modules`, `.vscode-test` or `dist`.

- [ ] **Step 3: Commit (after the go-ahead)**

```bash
git add -A
git commit -m "Set up the Streamscope extension foundation"
```

- [ ] **Step 4: Push (after the go-ahead)**

```bash
git remote add origin git@github.com:achrafelkhnissi/streamscope.git
git push -u origin main
```

- [ ] **Step 5: Watch CI**

Run: `GH_TOKEN=$(gh auth token --user achrafelkhnissi) gh run watch --repo achrafelkhnissi/streamscope --exit-status`
Expected: `check` passes on all three systems and `package` uploads the VSIX. Fix any failure in a follow-up commit (again with the go-ahead).
