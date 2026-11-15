# M12 First Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Streamscope `0.1.0` published as a pre-release on the Visual Studio Marketplace and Open VSX, tried by the team, then `0.2.0` released on both. Concretely:

- the release workflow is proven up to its approval gate (carried over from M11's acceptance);
- the installed-package check proves the product's two promises: a value captured from a live event is used by a later request while the stream is still open;
- a new `npm run verify:registry` installs a published version from either registry into a clean profile and runs that check;
- the `0.1.0` changelog describes what a first user gets, with its release date;
- the team trial has a written brief and a place for its results;
- the one-time publishing setup in `docs/publishing.md` is done, in its order;
- `0.2.0` ships through the same workflow, with Open VSX on trusted publishing.

**Architecture:** little new code; most of the milestone is release operations that you run or approve.

- **Code (branch `m12-first-release`, one pull request):** a live-capture check in `test/vsix/installed-extension.ts`; the clean-profile install moves from `scripts/verify-vsix.mjs` into `scripts/clean-profile.mjs` so a new `scripts/verify-registry.mjs` can reuse it with a registry as the source; changelog and release-check pins.
- **Documents:** `docs/team-trial.md`, GitHub issue forms, records in `docs/publishing.md`.
- **Operations:** the dry run, the Marketplace policy, the `v0.1.0` tag, the first Open VSX publish, the trial, then `0.2.0` on its own branch.

**Tech Stack:** Node 22 scripts (`.mjs` with `.d.mts` declarations, as in M11), `@vscode/test-electron` 3.1.0, `@vscode/vsce` 4.1.0, `ovsx` 1.3.0, Mocha in the VSIX harness, Vitest, GitHub Actions, `gh`. Nothing is added to `package.json` except the `verify:registry` script.

**Spec:**

- **`docs/roadmap.md`:** M12.
- **`docs/publishing.md`:** the whole file. It is the authority for versioning, the changelog, the release workflow, the one-time setup (steps 1 to 5) and the pre-publish checklist.
- **`docs/design.md`:** section 1 (users, the success and anti-goal table); section 10 (capture waiting); section 15 (secrets, privacy).
- **`CLAUDE.md`:** Security requirements, Verification.

## Global Constraints

- **Roadmap M12, verbatim:**
  - Includes: "Marketplace trusted publishing policy; GitHub `release` environment with the user as required reviewer; pre-release `0.1.0` on the Marketplace; first Open VSX publish with an access token (run by the user), then Open VSX trusted publishing; team trial against the success criteria; fixes; release `0.2.0`."
  - Acceptance: "both registries list the extension; installing from each works in a clean profile; the team confirms "no copied ids, events live"."
- **Success criteria (design section 1), verbatim:** "No more copying ids by hand", "Seeing events live". Anti-goals: "Events lag behind the network", "VS Code freezes or slows down", "A request silently sent with an empty or wrong value", "A token or secret shown or stored in clear text", "Needing an account, or sending telemetry".
- **Versioning (`docs/publishing.md`), verbatim:**
  - "Only `major.minor.patch`; the Marketplace does not accept semver pre-release tags."
  - "Odd minor = pre-release, published with `--pre-release`; even minor = release. Versions are never reused, and a pre-release and a release never share a version."
  - "Plan: `0.1.x` pre-release for the team trial, `0.2.0` first public release."
- **Tokens, verbatim:** "No long-lived publishing tokens are stored." The Open VSX token is entered "in a hidden prompt (never in chat or in files)" and deleted after trusted publishing is set up.
- **Already done in M11:** one-time setup step 1, the `release` environment. Checked on 2026-11-14: reviewer `achrafelkhnissi`, `can_admins_bypass: false`, deployment policies branch `main` and tag `v*.*.*`. Task 1 re-checks it.
- **Permissions:** nothing is pushed, tagged, dispatched, published or changed in GitHub, Marketplace or Open VSX settings without your yes at that step.
- **Process:**
  - no code comments;
  - synthetic data only, and nothing from the private reference `.http` file;
  - TDD for code;
  - the gate before the pull request: `npm run check`, `npm run test:integration` (every label), `npm run test:restricted`, `npm run verify:vsix`.

## Steps that need you

Execution pauses at each of these and asks.

1. **Dry run (Task 1):** say yes to the dispatch; at the approval gate, reject it (or tell me to cancel the run).
2. **Pull request (after Task 5):** say yes to push `m12-first-release` and open the PR; say when to merge.
3. **Marketplace policy (Task 6):** create the trusted publishing policy on the publisher page, or tell me to do it in your personal Chrome profile.
4. **`v0.1.0` (Task 6):** say yes to push the tag; approve the `release` environment in the run. If the Marketplace refuses OIDC for a first version, upload the VSIX on the publisher page.
5. **Open VSX (Task 7):** create the token, run the publish command in your terminal, set up trusted publishing, delete the token; say yes to setting `OPEN_VSX_TRUSTED`.
6. **Trial (Task 8):** run it with the team, record their answers, approve each fix.
7. **`0.2.0` (Task 9):** say yes to the push, the merge and the tag; approve both publish jobs.

## Review Focus

1. **The Marketplace installs another version than the one asked for** (a newer release, or the pre-release channel): `verify:registry` must fail and name both versions. Pinned in Task 3 (`installedVersionProblem`).
2. **Open VSX metadata without a download URL, or with one on another host or over `http:`:** `verify:registry` must refuse before downloading anything. Pinned in Task 3 (`openVsxDownloadUrl`).
3. **A capture that resolves only when the stream ends:** the installed check must fail with a message within its time bound, not hang. Pinned in Task 2 by the server's 15 s bound and the `last(` mutation step.
4. **A version that is not on the registry yet** (a typo, or a publish the Marketplace has not indexed): a usage or "not found" error, not a stack trace. Pinned in Task 3 (`registryRequest`, the Open VSX 404 path) and smoke-tested before publishing.
5. **A dated changelog heading** (`## [0.1.0] - 2026-11-16`): the release notes must still be found and must not include the date line. Pinned in Task 4 (`changelogSection`).

---

### Task 1: Release workflow dry run

The M11 acceptance asked for the workflow to be tested up to the approval gate; it runs on `main` as merged, before any M12 code.

**Files:**

- Modify: `docs/publishing.md` (the "Dry run" bullet of the workflow section)

**Interfaces:**

- Consumes: `.github/workflows/release.yml` on `main` at `2e1e9dd`.
- Produces: the dry-run URL, recorded in `docs/publishing.md`.

- [ ] **Step 1: Re-check the environment**

Run: `gh api repos/achrafelkhnissi/streamscope/environments/release --jq '{can_admins_bypass,reviewers:[.protection_rules[]|select(.type=="required_reviewers")|.reviewers[].reviewer.login]}'`
Expected: `{"can_admins_bypass":false,"reviewers":["achrafelkhnissi"]}`

- [ ] **Step 2: Dispatch, on your yes**

Run: `gh workflow run release.yml --ref main -f version=0.1.0`, then `gh run list --workflow release.yml --limit 1 --json databaseId,url`.
Expected: one run, `workflow_dispatch` on `main`.

- [ ] **Step 3: Watch it reach the gate**

Run: `gh run watch <id> --exit-status` in the background; when `check` and `package` have passed, `gh run view <id> --json jobs --jq '.jobs[]|{name,status,conclusion}'`.
Expected: `check (ubuntu-latest)`, `check (macos-latest)`, `check (windows-latest)` and `package` succeeded; `publish-marketplace` is `waiting`; `publish-open-vsx` is skipped (`OPEN_VSX_TRUSTED` unset); `gh run download <id> -n release -D <scratch>` gives `streamscope-0.1.0.vsix` and `release-notes.md`.

If a job fails, find the cause before anything else; a workflow fix becomes a commit on `m12-first-release` with a pin in `test/unit/release-workflow.test.ts`, and the dry run is repeated from that branch's merge.

- [ ] **Step 4: You reject the approval**

Expected: the run ends `failure` or `cancelled` at `publish-marketplace`; `github-release` did not run; `gh release list` is empty.

- [ ] **Step 5: Record and commit**

Replace the "Dry run" bullet's text with what it did and the run URL: "Done on <date>: <url>. `check` and `package` passed, the publish job waited for approval, and the approval was rejected."

```bash
git add docs/publishing.md
git commit -m "Record the release workflow dry run"
```

### Task 2: Live capture check in the installed package

**Files:**

- Modify: `test/vsix/installed-extension.ts`

**Interfaces:**

- Consumes: `streamscope.sendRequest(uri: vscode.Uri, line: number)`, where `line` is the zero-based line of the request line; `responsePanelTabs()` and `until()` in the same file.
- Produces: `capturesFromALiveStream(scratch: string): Promise<void>`, called at the end of `run()`, after `ignoresTestArguments`. Task 3 runs it from both registries.

- [ ] **Step 1: Write the check**

A local `node:http` server on `127.0.0.1:0` with two routes and recorded state `{ started: boolean, finished: boolean, continuedWhileOpen: boolean, threadId: string | undefined }`:

- `POST /agent/run`: status 200, `Content-Type: application/json` (NDJSON mislabelled, as the team's backend sends it); writes `{"type":"RUN_STARTED","threadId":"thread-synthetic-7f3a"}\n` and sets `started`; then waits until `/agent/continue` has arrived or 15 s have passed; then writes `{"type":"RUN_FINISHED"}\n`, sets `finished` and ends.
- `POST /agent/continue`: reads the JSON body, sets `threadId` from it and `continuedWhileOpen = !finished`, responds `{"ok":true}`.

`live.http` in `scratch`, with the port substituted:

```http
### Start agent run
# @name startRun
# @capture threadId = first(type == "RUN_STARTED").threadId
POST http://127.0.0.1:PORT/agent/run
Content-Type: application/json

{"message": "hello"}

### Continue
POST http://127.0.0.1:PORT/agent/continue
Content-Type: application/json

{"threadId": "{{startRun.threadId}}"}
```

The function opens the file, starts the first request without awaiting it (`const first = vscode.commands.executeCommand('streamscope.sendRequest', uri, runLine)`), waits for `started`, awaits `streamscope.sendRequest` on the second request line, waits until `threadId` is set (`until` gains a `timeoutMs` parameter, default `dialogTimeoutMs`, and this wait passes `20_000`), then asserts:

```ts
assert.equal(
  state.threadId,
  'thread-synthetic-7f3a',
  'Continue was not sent with the captured threadId',
);
assert.ok(state.continuedWhileOpen, 'Continue was sent only after the stream ended');
```

Then it awaits `first`, closes the response panels and the server.

- [ ] **Step 2: Prove the check can fail**

Change `first(` to `last(` in the test's `live.http` (a capture that resolves only when the stream ends).
Run: `npm run verify:vsix > <scratch>/vsix.log 2>&1; tail -30 <scratch>/vsix.log`
Expected: FAIL with "Continue was sent only after the stream ended" in about 15 s, not a hang.

- [ ] **Step 3: Restore `first(` and run it**

Run: `npm run verify:vsix > <scratch>/vsix.log 2>&1; tail -30 <scratch>/vsix.log`
Expected: PASS, "achrafelkhnissi.streamscope activated from the isolated profile".

- [ ] **Step 4: Commit**

```bash
git add test/vsix/installed-extension.ts
git commit -m "Check a live capture in the installed package"
```

### Task 3: Install a published version from either registry

**Files:**

- Create: `scripts/clean-profile.mjs`, `scripts/clean-profile.d.mts`, `scripts/registry-source.mjs`, `scripts/registry-source.d.mts`, `scripts/verify-registry.mjs`
- Modify: `scripts/verify-vsix.mjs`, `package.json` (scripts), `CLAUDE.md` (layout and commands tables), `docs/publishing.md` (pre-publish checklist's last line)
- Test: `test/unit/clean-profile.test.ts`, `test/unit/registry-source.test.ts`

**Interfaces:**

- Consumes: `capturesFromALiveStream` through the unchanged `test/vsix` harness.
- Produces:
  - `installedVersionProblem(listOutput: string, extensionId: string, version: string): string | undefined` in `scripts/clean-profile.mjs`;
  - `verifyInCleanProfile(options: { root: string; install: readonly string[]; extensionId: string; version: string }): Promise<void>` in `scripts/clean-profile.mjs`, where `install` is the arguments after `--install-extension`: `[vsixPath]` or `['<id>@<version>']`. It holds what `verify-vsix.mjs` does today from the sandbox onwards, with the list check through `installedVersionProblem`;
  - `registryRequest(args: readonly string[]): { registry: 'marketplace' | 'open-vsx'; version: string }`, `openVsxMetadataUrl(extensionId: string, version: string): string` and `openVsxDownloadUrl(metadata: unknown, extensionId: string, version: string): string` in `scripts/registry-source.mjs`;
  - `npm run verify:registry -- marketplace|open-vsx <version>`, which Tasks 6, 7 and 9 run.

- [ ] **Step 1: Write the failing tests**

`test/unit/clean-profile.test.ts`:

```ts
it('accepts the expected id and version among others', () => {
  expect(
    installedVersionProblem(
      'other.ext@1.0.0\nachrafelkhnissi.streamscope@0.1.0\n',
      'achrafelkhnissi.streamscope',
      '0.1.0',
    ),
  ).toBeUndefined();
});
it('names the version it found when another one is installed', () => {
  expect(
    installedVersionProblem(
      'achrafelkhnissi.streamscope@0.2.0\n',
      'achrafelkhnissi.streamscope',
      '0.1.0',
    ),
  ).toBe(
    'Expected achrafelkhnissi.streamscope@0.1.0 in the clean profile, found: achrafelkhnissi.streamscope@0.2.0',
  );
});
it('says so when the extension is missing', () => {
  expect(installedVersionProblem('', 'achrafelkhnissi.streamscope', '0.1.0')).toBe(
    'Expected achrafelkhnissi.streamscope@0.1.0 in the clean profile, found: nothing',
  );
});
```

`test/unit/registry-source.test.ts`:

```ts
it('reads the registry and version', () => {
  expect(registryRequest(['open-vsx', '0.1.0'])).toEqual({
    registry: 'open-vsx',
    version: '0.1.0',
  });
  expect(registryRequest(['marketplace', '0.2.0'])).toEqual({
    registry: 'marketplace',
    version: '0.2.0',
  });
});
it('refuses other registries, missing arguments and partial versions', () => {
  const usage = 'Usage: npm run verify:registry -- marketplace|open-vsx <version>';
  expect(() => registryRequest([])).toThrow(usage);
  expect(() => registryRequest(['npm', '0.1.0'])).toThrow(usage);
  expect(() => registryRequest(['marketplace', '0.1'])).toThrow(
    '"0.1" is not a major.minor.patch version.',
  );
});
it('builds the Open VSX metadata URL', () => {
  expect(openVsxMetadataUrl('achrafelkhnissi.streamscope', '0.1.0')).toBe(
    'https://open-vsx.org/api/achrafelkhnissi/streamscope/0.1.0',
  );
});
it('takes the download URL from metadata for the same version', () => {
  const download =
    'https://open-vsx.org/api/achrafelkhnissi/streamscope/0.1.0/file/achrafelkhnissi.streamscope-0.1.0.vsix';
  expect(
    openVsxDownloadUrl(
      { version: '0.1.0', files: { download } },
      'achrafelkhnissi.streamscope',
      '0.1.0',
    ),
  ).toBe(download);
});
it('refuses metadata for another version or without a download', () => {
  const missing = 'Open VSX has no 0.1.0 of achrafelkhnissi.streamscope.';
  expect(() =>
    openVsxDownloadUrl({ error: 'Extension not found' }, 'achrafelkhnissi.streamscope', '0.1.0'),
  ).toThrow(missing);
  expect(() =>
    openVsxDownloadUrl(
      { version: '0.2.0', files: { download: 'https://open-vsx.org/x.vsix' } },
      'achrafelkhnissi.streamscope',
      '0.1.0',
    ),
  ).toThrow(missing);
  expect(() =>
    openVsxDownloadUrl({ version: '0.1.0', files: {} }, 'achrafelkhnissi.streamscope', '0.1.0'),
  ).toThrow(missing);
});
it('refuses a download URL off open-vsx.org or over http', () => {
  for (const download of [
    'http://open-vsx.org/x.vsix',
    'https://open-vsx.example.test/x.vsix',
    'not a url',
  ]) {
    expect(() =>
      openVsxDownloadUrl(
        { version: '0.1.0', files: { download } },
        'achrafelkhnissi.streamscope',
        '0.1.0',
      ),
    ).toThrow(`Open VSX gave an unexpected download URL: ${download}`);
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/unit/clean-profile.test.ts test/unit/registry-source.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement the modules and the script**

- `registryRequest` reuses the `major.minor.patch` pattern and message from `scripts/release.mjs`.
- `openVsxDownloadUrl` accepts only `https:` with hostname `open-vsx.org`.
- `verify-registry.mjs`: reads the extension id from `package.json`; for `marketplace`, calls `verifyInCleanProfile` with `install: ['<id>@<version>']` (if the CLI installs another version of a pre-release, `installedVersionProblem` says so, and adding `--pre-release` to `install` is the ruling); for `open-vsx`, fetches the metadata URL with the global `fetch` (a 404 is "Open VSX has no … of …"), downloads the VSIX into a new temporary directory of its own, verifies with that path, and removes the directory on every exit path.
- `verify-vsix.mjs` keeps its size and contents checks and then calls `verifyInCleanProfile` with `install: [vsix]`.
- `package.json`: `"verify:registry": "npm run compile:host-tests && node scripts/verify-registry.mjs"`.
- `CLAUDE.md`: a layout row for `scripts/verify-registry.mjs` ("Installs a published version from the Marketplace or Open VSX into a clean profile and runs `test/vsix`") and a commands row "Published-version check | `npm run verify:registry -- marketplace|open-vsx <version>`".
- `docs/publishing.md`, last checklist line: "After publishing: `npm run verify:registry -- marketplace <version>` and `-- open-vsx <version>`, which install from each registry in a clean profile, send a streaming request and use a value captured from it".

- [ ] **Step 4: Run the tests and the existing VSIX check**

Run: `npx vitest run test/unit/clean-profile.test.ts test/unit/registry-source.test.ts && npm run verify:vsix > <scratch>/vsix.log 2>&1; tail -5 <scratch>/vsix.log`
Expected: PASS; the VSIX check passes as in Task 2.

- [ ] **Step 5: Smoke-test against the registries before anything is published**

Run: `npm run verify:registry -- open-vsx 0.1.0` and `npm run verify:registry -- marketplace 0.1.0`
Expected: both fail with a clear message: "Open VSX has no 0.1.0 of achrafelkhnissi.streamscope." and the VS Code CLI's "not found" for `achrafelkhnissi.streamscope@0.1.0`; no stack trace from the scripts' own code.

- [ ] **Step 6: Commit**

```bash
git add scripts/clean-profile.mjs scripts/clean-profile.d.mts scripts/registry-source.mjs scripts/registry-source.d.mts scripts/verify-registry.mjs scripts/verify-vsix.mjs package.json CLAUDE.md docs/publishing.md test/unit/clean-profile.test.ts test/unit/registry-source.test.ts
git commit -m "Verify a published version from either registry"
```

### Task 4: First-release changelog and pre-publish checks

The `0.1.0` section has Changed and Fixed entries for builds nobody received (an M11 deferred minor). A first release describes what its users get, so the section becomes Added only, with a date.

**Files:**

- Modify: `CHANGELOG.md`, `docs/publishing.md` (Identity table), `test/unit/manifest.test.ts:486-500`, `test/unit/release.test.ts`, `test/unit/release-workflow.test.ts`

**Interfaces:**

- Consumes: `changelogSection(changelog, version)` from `scripts/release.mjs`.
- Produces: a dated `## [0.1.0] - YYYY-MM-DD` heading, which the `v0.1.0` release notes come from.

- [ ] **Step 1: Write the failing tests**

- `manifest.test.ts`, the 0.1.0 test: the section's `###` headings equal `['### Added']`, and `changelog` matches `/^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}$/m`.
- `release.test.ts`, in `changelogSection`: `it('finds a dated section and leaves the date out', …)` with `'## [0.1.0] - 2026-11-16'` as the heading line, expecting the same body as the undated case.
- `release-workflow.test.ts`: `it('packages and publishes without vsce allow or skip flags', …)`: neither `JSON.stringify(manifest.scripts)` nor the workflow text matches `/--(allow-[a-z-]+|skip-license|no-verify)\b/`.

- [ ] **Step 2: Run them to see the manifest test fail**

Run: `npx vitest run test/unit/manifest.test.ts test/unit/release.test.ts test/unit/release-workflow.test.ts`
Expected: the manifest test FAILS (four headings, no date); the other two pass at once because they pin behaviour that already exists.

- [ ] **Step 3: Rewrite the 0.1.0 section**

- Heading: `## [0.1.0] - <the day you plan to tag>`. If the tag moves to another day, the date changes in a commit before the merge.
- Keep "The first pre-release." and every Added bullet.
- The Changed bullets that describe the product become Added bullets in present tense: activation when a workspace has `.http` or `.rest` files, and the response panel with documents on request. "Version 0.1.0, with an icon and Marketplace listing fields" is dropped.
- The Fixed bullets are dropped.
- The Security bullets become one Added bullet, "**Security:**", listing the protections in present tense (decompression that stops while its output is not read; cross-origin 307/308 never resending the body and dropping headers that carry a secret; what **Run File** and the Testing view read; masking in every message).

- [ ] **Step 4: Check the display name is free**

Run: `curl -s -X POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery -H 'Content-Type: application/json' -H 'Accept: application/json;api-version=7.2-preview.1' -d '{"filters":[{"criteria":[{"filterType":10,"value":"Streamscope"}],"pageSize":50}],"flags":0}' | jq -r '.results[0].extensions[] | "\(.publisher.publisherName).\(.extensionName) \(.displayName)"'`
Expected: no extension other than `achrafelkhnissi.streamscope` has the display name "Streamscope: HTTP Client with Live Streaming". Record "Free on <date>" in the Identity table's Display name row. If it is taken, stop and ask.

- [ ] **Step 5: Run the tests and the gate**

Run: `npm run check > <scratch>/check.log 2>&1; tail -8 <scratch>/check.log`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md docs/publishing.md test/unit/manifest.test.ts test/unit/release.test.ts test/unit/release-workflow.test.ts
git commit -m "Date the 0.1.0 changelog and describe what first users get"
```

### Task 5: Team trial brief and issue forms

**Files:**

- Create: `docs/team-trial.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/config.yml`

**Interfaces:**

- Consumes: the success criteria and anti-goals (Global Constraints).
- Produces: the results table Task 8 fills in.

- [ ] **Step 1: Write `docs/team-trial.md`**

Sections:

- **Goal:** the two success criteria, verbatim, and the acceptance sentence "no copied ids, events live".
- **Install:** search "Streamscope" in the Extensions view and install `0.1.0` (a pre-release, so the listing shows it as one); or `code --install-extension achrafelkhnissi.streamscope --pre-release`. REST Client can stay installed (README "Coexistence").
- **What to try, on your own streaming endpoints and `.http` files:** send a streaming request and watch the Events view; capture an id from one event (`first(…)`, or **Capture This Value…**) and use it in the next request while the stream runs; a file run in the Testing view with `# @expect` and `# @until`; a long stream while typing.
- **Each anti-goal as a question:** did events lag; did VS Code slow down; was a request ever sent with an empty or wrong value; did a token or secret show in clear text.
- **Reporting:** a GitHub issue with the bug form for anything reproducible with synthetic data; anything that needs the team's own backend goes to Achraf directly. Never paste tokens, real ids, real URLs or the team's `.http` files into an issue.
- **Results:** a table with columns Tester (Tester 1, 2, …, no names), OS, VS Code version, "Copied an id by hand?", "Events appeared live?", Issues; and a final line for the team's confirmation with its date.

- [ ] **Step 2: Write the issue forms**

- `bug_report.yml`: name "Bug report"; fields: what happened (required), steps with a synthetic `.http` request (required, `render: http`), expected, Streamscope version (required), VS Code version (required), OS (dropdown macOS, Windows, Linux, Remote), log excerpt from **Streamscope: Show Log** (`render: text`); a checkbox, required: "I removed tokens, secrets and real URLs from everything above".
- `config.yml`: `blank_issues_enabled: true`; a contact link "Report a security vulnerability" to `https://github.com/achrafelkhnissi/streamscope/security/advisories/new`.

- [ ] **Step 3: Verify**

Run: `npm run format:check` (Prettier parses the YAML, so a syntax error fails it).
Expected: PASS. GitHub validates issue forms only when it renders them, so Task 6, Step 1 opens the bug form from the pushed branch and checks every field shows.

- [ ] **Step 4: Commit**

```bash
git add docs/team-trial.md .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/config.yml
git commit -m "Add the team trial brief and issue forms"
```

### Task 6: Publish 0.1.0 to the Marketplace

**Interfaces:**

- Consumes: the merged `m12-first-release` (Tasks 1 to 5); `npm run verify:registry`.
- Produces: `0.1.0` on the Marketplace as a pre-release; the GitHub release `v0.1.0` with the VSIX that Task 7 publishes to Open VSX.

- [ ] **Step 1: Gate, push and pull request, on your yes**

Run the gate (Global Constraints), then the reviews: `extension-security-reviewer` (scripts that download and install packages, the trial brief's reporting rules), and the final whole-branch review. Then push and open the PR with the review results, rulings and measurements, as in M11. Check the bug form renders on the branch. Merge when you say.
Expected: CI green on Linux, macOS and Windows; the PR merged into `main`.

- [ ] **Step 2: Marketplace trusted publishing policy (you, or me in your personal Chrome on your word)**

Publisher `achrafelkhnissi` → Trusted Publishing → Create: name "Release workflow", repository owner `achrafelkhnissi`, repository `streamscope`, workflow `release.yml`, environment `release`.
Expected: the policy is listed on the publisher page.

- [ ] **Step 3: Tag, on your yes**

Run: `git tag v0.1.0 <merge commit> && git push origin v0.1.0`, then watch the run in the background.
Expected: `check` and `package` pass; `publish-marketplace` waits for you.

- [ ] **Step 4: You approve the `release` environment**

Expected: `publish-marketplace` succeeds; `publish-open-vsx` is skipped; `github-release` creates `v0.1.0` marked as a pre-release with `streamscope-0.1.0.vsix` and the dated notes.

If `publish-marketplace` fails because the Marketplace refuses OIDC for an extension that does not exist yet: you upload `streamscope-0.1.0.vsix` from the run's `release` artifact on the publisher page (New extension → Visual Studio Code); then, on your yes, I create the GitHub release from the same artifact with the workflow's command (`gh release create v0.1.0 streamscope-0.1.0.vsix --title "Streamscope 0.1.0" --notes-file release-notes.md --target <merge commit> --prerelease`). `0.2.0` then activates the policy through the workflow.

- [ ] **Step 5: Verify from the Marketplace**

The Marketplace can take minutes to index a new version.
Run: `npm run verify:registry -- marketplace 0.1.0`
Expected: PASS, including the live capture. The listing at `https://marketplace.visualstudio.com/items?itemName=achrafelkhnissi.streamscope` shows the Pre-Release and Preview badges, the icon, README images and the changelog tab. Note the run URL and how 0.1.0 reached the Marketplace for Task 9's records.

### Task 7: First Open VSX publish, then trusted publishing

**Interfaces:**

- Consumes: `streamscope-0.1.0.vsix` from the GitHub release `v0.1.0`.
- Produces: `0.1.0` on Open VSX; the repository variable `OPEN_VSX_TRUSTED=true`.

- [ ] **Step 1: Download the released VSIX**

Run: `gh release download v0.1.0 --pattern 'streamscope-0.1.0.vsix' --dir <a new empty directory>`
Expected: one file whose `shasum -a 256` equals the run artifact's.

- [ ] **Step 2: You create a token and publish from your own terminal**

Create an access token at open-vsx.org (Settings → Access Tokens), then in a terminal in the repository:

```bash
( read -rs OVSX_PAT && export OVSX_PAT && npm exec --no -- ovsx publish --packagePath <dir>/streamscope-0.1.0.vsix )
```

The token is typed into the hidden prompt, so it is not in the command line, the shell history or any file, and the subshell drops it on every exit, Ctrl+C included. Delete the token in Step 3 even if the publish fails. `ovsx` reads the pre-release flag from the VSIX.
Expected: "Published achrafelkhnissi.streamscope v0.1.0".

- [ ] **Step 3: You set up trusted publishing and delete the token**

Open VSX Settings → Trusted Publishers → GitHub Actions: owner `achrafelkhnissi`, repository `streamscope`, workflow `release.yml`, environment `release`. Then delete the token.
Expected: the trusted publisher is listed and no access token remains.

- [ ] **Step 4: Turn on the workflow's Open VSX job, on your yes**

Run: `gh variable set OPEN_VSX_TRUSTED --body true --repo achrafelkhnissi/streamscope && gh variable list`
Expected: `OPEN_VSX_TRUSTED  true`.

- [ ] **Step 5: Verify from Open VSX**

Run: `npm run verify:registry -- open-vsx 0.1.0`
Expected: PASS, including the live capture.

### Task 8: Team trial and fixes

**Interfaces:**

- Consumes: `docs/team-trial.md`; `0.1.0` on both registries.
- Produces: the filled results table and the team's confirmation; one plan amendment per approved fix.

- [ ] **Step 1: You run the trial with the team** for as long as you decide, and fill in the results table.

- [ ] **Step 2: Triage with you**

Each finding gets one of: fix before `0.2.0`, backlog (`docs/backlog.md`), or no change. Each fix you approve becomes a task appended to this plan, written like Tasks 2 to 4 (a failing test first) and placed before Task 9.

- [ ] **Step 3: Patch pre-releases, only if the team needs a fix before `0.2.0`**

A `0.1.x` patch is a version bump in `package.json` and `test/unit/manifest.test.ts`, a dated `## [0.1.x]` changelog section and link, a pull request, then the tag and approval as in Task 6, Steps 3 and 4, with both publish jobs running; then `verify:registry` on both registries.

- [ ] **Step 4: Acceptance**

Expected: the team's confirmation of "no copied ids, events live" is recorded in `docs/team-trial.md` with its date, and every fix approved for `0.2.0` is merged.

### Task 9: Release 0.2.0

**Files:**

- Modify: `package.json` (`version`), `package-lock.json`, `test/unit/manifest.test.ts:140` and the changelog test, `CHANGELOG.md`, `docs/publishing.md`, `docs/team-trial.md`

**Interfaces:**

- Consumes: everything above.
- Produces: Streamscope `0.2.0` on both registries; the GitHub release `v0.2.0`, not marked as a pre-release.

- [ ] **Step 1: Write the failing test**

`manifest.test.ts`: `expect(manifest.version).toBe('0.2.0')`, and a `0.2.0` changelog test like the 0.1.0 one: heading `/^## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}$/m` and a link definition to `releases/tag/v0.2.0`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/unit/manifest.test.ts`
Expected: FAIL, version `0.1.0` and no `0.2.0` section.

- [ ] **Step 3: Version, changelog and records**

- `npm version 0.2.0 --no-git-tag-version` (it updates `package-lock.json` too).
- `## [0.2.0] - <the day you plan to tag>`, "The first release.", with Added, Changed, Fixed and Security as they apply since `0.1.0` (and any `0.1.x`), and the `[0.2.0]` link definition.
- `docs/publishing.md`: in the one-time setup, steps 2 to 4 each get "Done on <date>" and how it went (OIDC or manual upload for the first Marketplace version); the identity table's statuses; the Open VSX switch now on.
- `docs/team-trial.md`: final results.
- `preview` stays `true` (publishing.md: "until 1.0").

- [ ] **Step 4: Run the gate**

Run: `npm run check`, `npm run verify:vsix`
Expected: PASS.

- [ ] **Step 5: Commit, pull request and merge, on your yes**

```bash
git add package.json package-lock.json test/unit/manifest.test.ts CHANGELOG.md docs/publishing.md docs/team-trial.md
git commit -m "Release 0.2.0"
```

Branch `release-0.2.0` from `main`; push and open the PR on your yes; merge when you say.

- [ ] **Step 6: Tag and approve**

Run, on your yes: `git tag v0.2.0 <merge commit> && git push origin v0.2.0`.
Expected: `package` packages without `--pre-release`; after your approval, `publish-marketplace` and `publish-open-vsx` both succeed through OIDC; `github-release` creates `v0.2.0`, not marked as a pre-release.

- [ ] **Step 7: Verify the acceptance**

Run: `npm run verify:registry -- marketplace 0.2.0` and `npm run verify:registry -- open-vsx 0.2.0`
Expected: both PASS. Both listings show `0.2.0` as a release. With the team's confirmation from Task 8, the roadmap's M12 acceptance is met.
