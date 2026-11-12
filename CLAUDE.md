# HTTP client VS Code extension

## Product

A VS Code extension that sends HTTP requests written in `.http` files and shows the responses inside the editor, comparable to REST Client (`humao.rest-client`). Its two differentiators:

1. Live streaming responses (NDJSON, Server-Sent Events, chunked bodies, LLM streams), shown event by event as data arrives, even when the server labels NDJSON as `application/json`.
2. Capturing values from individual streamed events (for example `threadId` from a `RUN_STARTED` event) and reusing them in later requests.

The product is **Streamscope** (`achrafelkhnissi.streamscope`, display name "Streamscope: HTTP Client with Live Streaming", command and settings prefix `streamscope.`, MIT). Repository: https://github.com/achrafelkhnissi/streamscope.

## Status and workflow

- Work runs in approved phases: research (done), project setup (done), product planning and technical design (approved 2026-11-11), then the implementation milestones in `docs/roadmap.md`. Do not build product functionality before the user approves the design, and ask before starting a new phase or milestone.
- The design is `docs/design.md`, the milestone plan `docs/roadmap.md`, the release process `docs/publishing.md`, and the approved response view mockup `docs/mockups/response-view.html`. They win over anything older in this file.
- Settled decisions: VS Code `^1.101.0` with forks best effort; desktop only; native VS Code UI first, except the response view, which M5 made a webview panel with editor documents for large content (`docs/decisions/response-surface.md`); REST Client syntax compatibility (core syntax, request references, system variables, `rest-client.environmentVariables`, JetBrains env files); language id `http` with our own grammar scope; in-memory history for the MVP; captured values wait up to 30 s and never auto-run producers; Marketplace and Open VSX via OIDC trusted publishing.

## Layout

| Path                               | Purpose                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`                 | Activation and VS Code wiring                                                                              |
| `src/http-file/`                   | `.http` parser, directives and diagnostics                                                                 |
| `src/environments/`                | REST Client and JetBrains environments, the merged catalog, and `.env` parsing and lookup order            |
| `src/variables/`                   | Variable resolution from every source, sensitive values, and reference descriptions for hovers             |
| `src/secrets/`                     | Secret storage key format                                                                                  |
| `src/transport/`                   | `node:http`/`node:https` exchange, decompression, TLS options and redirects                                |
| `src/runs/`                        | Outgoing request building, body files, durations, runs and the run registry                                |
| `src/response/`                    | Body formatting (worker above 1 MiB), labels and the Headers document                                      |
| `src/streaming/`                   | Byte-level line framing, format detection, and NDJSON and SSE parsing into events                          |
| `src/events/`                      | Event model, labels, reply assembly, spill files, event store, update batching, stream sessions            |
| `src/masking/`                     | Masking of secret headers, URL user info, credential names and sensitive values                            |
| `src/coexistence/`                 | Detection of other extensions' Send CodeLens                                                               |
| `src/benchmark/`                   | Latency histogram and the command contract between the view benchmark and a response view                  |
| `src/vscode/`                      | VS Code wiring: language features, environments, secrets, requests, response view, log                     |
| `test/support/`                    | Local HTTP, HTTPS, raw and stream servers, stream fixtures, a chunk splitter, a test certificate           |
| `test/benchmark/`                  | Throughput, soak and VS Code response view benchmarks, run with `npm run bench`                            |
| `test/unit/`                       | Vitest tests for pure modules and the manifest                                                             |
| `test/integration/`                | Mocha tests run by `@vscode/test-cli` inside the Extension Development Host, on VS Code stable and 1.101.0 |
| `test/restricted/`                 | Checks run in a real restricted (untrusted) workspace built from `test/fixtures/restricted`                |
| `test/vsix/`                       | Check that the packaged VSIX installs and activates in an isolated profile                                 |
| `scripts/verify-vsix.mjs`          | Installs the VSIX into a temporary profile and runs `test/vsix`                                            |
| `scripts/run-restricted-tests.mjs` | Launches VS Code on a fresh copy of the restricted fixture without `--disable-workspace-trust`             |
| `.claude/`                         | Project plugins, subagents, hooks and security-review rules                                                |
| `.github/`                         | CI on Linux, macOS and Windows; Dependabot                                                                 |

## Architecture conventions

- Keep five layers apart: HTTP transport, stream framing and parsing, event processing, variable extraction, rendering. Only rendering and command wiring may import `vscode`, so the rest stays unit-testable in Vitest.
- Transport uses `node:http` and `node:https`, which VS Code patches with the user's proxy and system certificates. The extension host's global `fetch` drops custom dispatchers (TLS options, client certificates, timeouts), so do not use it, and do not bundle another HTTP client.
- Parse streams incrementally with hand-written, size-limited framers. Never trust `Content-Type` alone and never add headers the user did not write (some servers reject `Accept: text/event-stream`).
- Read the socket at full speed into bounded buffers and batch UI updates; a slow view must never throttle the connection.
- Everything long-running accepts a `CancellationToken` or `AbortSignal` and releases its resources on every exit path.

## Commands

| Task                 | Command                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Install              | `npm ci`                                                                                 |
| Dev build / watch    | `npm run build` / `npm run watch` (F5 runs the default build task)                       |
| Production build     | `npm run build:production`                                                               |
| Typecheck            | `npm run typecheck`                                                                      |
| Lint / format        | `npm run lint` / `npm run format` (`npm run format:check` to verify)                     |
| Unit tests           | `npm run test:unit` (`npm run test:coverage` for coverage)                               |
| Integration tests    | `npm run test:integration` (add `-- --label stable` for one VS Code version)             |
| Restricted workspace | `npm run test:restricted`                                                                |
| Quick gate           | `npm run check` (typecheck, lint, format check, unit tests)                              |
| Package              | `npm run package` (VSIX in the project root), `npm run package:list` to see its contents |
| Installed-VSIX check | `npm run verify:vsix`                                                                    |
| Stream benchmarks    | `npm run bench -- throughput`, `soak` or `view` (see `docs/benchmarks.md`)               |

## Toolchain facts

- TypeScript stays on 6.0.x: TypeScript 7 has no compiler API yet and typescript-eslint requires `<6.1`.
- esbuild bundles `src/extension.ts` to CommonJS `dist/extension.js` (target `node22`, `vscode` external). Do not switch to ESM.
- `@types/vscode` must equal the `engines.vscode` floor exactly; vsce refuses to package otherwise and `test/unit/manifest.test.ts` enforces it. Raise both together, and move `@types/node` and the esbuild target to the Node version of the new floor.
- npm only (vsce does not support pnpm). `.npmrc` sets `ignore-scripts`, `save-exact` and `min-release-age=7`, so new packages resolve to versions at least a week old.
- The VSIX ships only what `files` in `package.json` lists, plus the manifest and README.

## VS Code API rules

- Check every API against `node_modules/@types/vscode/index.d.ts` before using it, then Context7 `/websites/code_visualstudio_api`, then code.visualstudio.com. Proposed APIs are not allowed.
- Prefer native UI (editors, tree views, CodeLens, status bar, quick picks, progress) and follow the VS Code UX guidelines. A webview needs a reason native UI cannot cover.
- Run the `vscode-api-verifier` agent after changing code that imports `vscode` or the manifest's `contributes`.

## Security requirements

- Secrets live only in SecretStorage. Mask `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, API-key headers and secret-marked captures in logs, notifications, hovers, history and errors.
- Support Workspace Trust in limited mode: no `.env` reading, secret injection, scripts or automatic requests in untrusted workspaces.
- No `eval`, `new Function` or `vm` on file or response content, and no eval-based expression libraries (`jsonpath-plus`, `jsonpath`, JSONata). The approved JSONPath library is `@swaggerexpert/jsonpath`, added when first used.
- Disable TLS verification only per request or environment after explicit opt-in.
- Run the `extension-security-reviewer` agent for changes touching credentials, environments, logging, rendering, file access or TLS. Record accepted security-guidance false positives in `.claude/claude-security-guidance.md`.
- Use synthetic data in every example, fixture and document. A private real-world `.http` file motivated the capture feature; never copy anything from it.

## Verification

- `npm run check` must pass before work is reported done. The Stop hook runs it automatically when files changed since the last passing run.
- CI runs `npm run check`, the integration tests, the restricted workspace tests and `npm run verify:vsix` on every push to `main` and every pull request, on Linux, macOS and Windows.
- Also run `npm run test:integration` when activation, commands, contributions or other `vscode`-facing code change, `npm run test:restricted` when Workspace Trust behaviour, variable sources or the manifest's `capabilities` change, and `npm run verify:vsix` when packaging, `files` or activation change.
- `@vscode/test-electron` always passes `--disable-workspace-trust`, so `npm run test:integration` runs trusted; only `npm run test:restricted` exercises restricted mode.
- Streaming code needs tests that split input at every byte boundary; the `stream-parser-test-author` agent writes them.

## Hooks

- PostToolUse (`Edit|Write|MultiEdit`): Prettier formats the edited file when it is inside the project.
- Stop: runs `npm run check` when the working tree changed since the last passing run (state in `.claude/state/`), and blocks once with the failure output.
