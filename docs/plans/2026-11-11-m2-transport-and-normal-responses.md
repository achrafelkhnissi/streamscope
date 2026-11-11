# M2 Transport and Normal Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** put the cursor in a request, press `Cmd+Alt+Enter` (or click Send), and see the response: a pretty body, a Headers view with the request as sent (secrets masked), redirect hops and timing, Stop while it runs, and Save Response. File and system variables resolve first, and a request with a missing value is never sent.

**Architecture:** four pure modules, all Vitest-tested against real local sockets:

- `src/variables` resolves `{{…}}`.
- `src/transport` sends over `node:http`/`node:https` and emits raw bytes.
- `src/runs` turns a parsed request into an outgoing request and drives one run to a terminal state.
- `src/response` formats bodies (in a worker above 1 MiB) and renders the Headers document.

`src/vscode` adds the commands, the CodeLens, a read-only `FileSystemProvider` for response documents, settings, the redacting log and the coexistence notice. The M1 review carry-overs land first.

**Tech Stack:** TypeScript 6.0.3, Node `http`/`https`/`zlib`/`tls`/`worker_threads`/`crypto`, Vitest 5, @vscode/test-cli, esbuild (second entry point for the worker). No new dependencies.

**Spec:** `docs/design.md`:

- FR-S1 to FR-S5, FR-V2 (Headers and Body), FR-V6 (body), FR-X1;
- sections 6, 11, 12, 15 (masking), 16, 17 and 19;
- `docs/roadmap.md` M2.

REST Client behaviour reference: its MIT-licensed bundle (system variable regexes, `parseBody`, `resolveRequestBodyPath`, `FileVariableProvider`), read for behaviour only.

## Global Constraints

- **Layers.** Only `src/vscode/**` and `src/extension.ts` import `vscode`. `src/variables`, `src/transport`, `src/runs`, `src/response`, `src/masking` and `src/coexistence` are pure and may use Node built-ins.
- **Transport.**
  - Use `http.request`/`https.request` called through the module object (`import * as https from 'node:https'`), never `fetch` or another client.
  - Headers are sent in the order written, with their original casing. The only headers added are:
    - `Host` when missing;
    - `Accept-Encoding: gzip, deflate, br, zstd` when missing;
    - `Content-Length` when there is a body and no user `Transfer-Encoding`. A user-written `Content-Length` is replaced by the computed one, as REST Client does.
- **Redirects.**
  - Our own loop, at most `streamscope.request.maxRedirects` (default 10).
  - 301, 302 and 303 become GET (HEAD stays HEAD) and drop the body together with `Content-Type`, `Content-Length`, `Content-Encoding`, `Content-Language`, `Content-Location` and `Transfer-Encoding`.
  - 307 and 308 replay method and body.
  - A cross-origin hop (scheme, host or port differs) drops `Authorization`, `Proxy-Authorization`, `Cookie` and a user `Host`.
  - Every hop is recorded.
- **Decompression.**
  - `Content-Encoding` values: `gzip`, `x-gzip`, `deflate`, `br` and `zstd`, possibly chained. They are decoded in reverse order.
  - `identity` is ignored, and an unknown coding passes the bytes through unchanged.
  - The decoder is created on the first body byte, so an empty body never fails.
- **Timeouts.**
  - `streamscope.request.connectTimeout` defaults to `30s`. It runs until the socket is ready (TCP, plus the TLS handshake for https).
  - `streamscope.request.headersTimeout` defaults to `300s`. It runs from connect until the response head.
  - `# @timeout` sets the total limit.
  - Durations match `^(\d+)(ms|s|m)$`.
- **TLS.**
  - Verification is on unless the request has `# @insecure`.
  - A custom CA from `streamscope.request.caFile` is merged with `tls.getCACertificates('default')` and `tls.getCACertificates('system')`, without duplicates.
- **Cancellation.** One `AbortController` per run. Abort destroys the request, the response and the decoder at once. Every listener and timer is removed on every exit path.
- **Masking.**
  - The masked value is `••••••`.
  - Sensitive header names, case-insensitive: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key` and `api-key`.
  - URL passwords are masked.
  - Masking applies to the Headers document, the log and messages. Response bodies and saved files are never masked.
- **Variables (REST Client rules).**
  - `{{ name }}` is trimmed.
  - File variables:
    - are file-wide, and the last definition wins;
    - their values unescape `\n`, `\r` and `\t`, and `\x` becomes `x`;
    - may reference other file variables and system variables;
    - a system variable inside a file variable is evaluated once per send.
  - Each system variable reference in the request is evaluated separately.
  - System variables match these anchored patterns, and anything else is a problem:
    - `$guid`;
    - `$timestamp( -?\d+ (y|Q|M|w|d|h|m|s|ms))?`, which gives Unix seconds;
    - `$datetime (rfc1123|iso8601|'…'|"…")( -?\d+ unit)?` in UTC;
    - `$localDatetime` with the same arguments, in local time;
    - `$randomInt -?\d+ -?\d+`, which gives an integer in [min, max).
  - `$processEnv`, `$dotenv`, `$aadToken`, `$aadV2Token` and `{{$secret …}}` are "not supported yet" until M3. Request references (`{{login.response…}}`) are "not supported yet" until M7.
- **Body (REST Client rules).**
  - Text lines are joined with `\n`, or `\r\n` for `multipart/form-data`.
  - For `application/x-www-form-urlencoded`, a line starting with `&` is appended without a separator.
  - `application/x-ndjson` gets a trailing line ending.
  - When the body has a file part, every line and part is followed by the line ending.
  - `< path` is streamed. `<@[encoding] path` is read with that Node encoding (default `utf8`), its variables are resolved, and it is sent as UTF-8.
  - Relative paths try the workspace folder first, then the `.http` file's folder.
  - The real path (`fs.promises.realpath.native`) must stay inside the workspace folder, or the file's folder when there is no workspace folder. An untitled file cannot use body files.
- **Response surface.**
  - URI scheme `streamscope-response`, served by a read-only `FileSystemProvider`.
  - Per request:
    - body document `/<n>/<label><ext>`, where `<ext>` is `.json`, `.xml`, `.html`, `.js`, `.css` or `.txt`;
    - Headers document `/<n>/<label>.headers.http`.
  - Opened with `vscode.open`, beside the editor, preserving focus.
  - Bodies over 1,048,576 bytes are formatted in a worker (`dist/format-worker.js`), one worker per job, terminated afterwards.
  - Run bodies are buffered up to `maxBodyBytes` (268,435,456). Beyond that the run fails with `body-too-large`.
- **Language features.** They apply only to `http` documents with scheme `file` or `untitled`.
- **Workspace Trust.** M2 does not declare `capabilities.untrustedWorkspaces`, so VS Code keeps the extension disabled in restricted workspaces. Body files, `caFile` and `# @insecure` therefore never run there. M3 adds limited mode.
- **Commands** (category `Streamscope`):
  - `streamscope.sendRequest`, `streamscope.stopRequest` and `streamscope.saveResponse`;
  - `streamscope.showResponseHeaders` and `streamscope.showResponseBody`;
  - the existing `streamscope.showLog`.
- **Keybinding.** `cmd+alt+enter` on macOS and `ctrl+alt+enter` elsewhere, when `editorTextFocus && editorLangId == http && resourceScheme != streamscope-response`.
- **Settings and fixtures.** Settings are listed in Task 13. Synthetic data only: `*.example.test`, `*.streamscope.test`, `localhost`.
- **Process.**
  - No code comments, no new dependencies, TDD for all code.
  - Work happens on branch `m2-transport`, one commit per task. Push and pull request only with the user's go-ahead.

## Decisions this plan makes (builder's call, approval of this plan approves them)

1. **No idle timeout in M2.**
   - M2 cannot yet tell a stream from a body, so a 60 s idle limit would cut slow streams. Connect, headers and total timeouts apply now.
   - The non-streaming idle timeout arrives with stream detection in M6.
   - `docs/design.md` section 6 is updated to say so.
2. **The proxy check runs in the real Extension Development Host instead of a separate Electron harness.**
   - The test sets `http.proxy` and sends to `*.streamscope.test` hosts, which only a proxy can reach.
   - It also tunnels an `# @insecure` https request through `CONNECT`. This proves both the proxy patch and that `rejectUnauthorized` survives it.
   - Design section 18 is updated.
3. **System variable arguments are matched strictly.** REST Client ignores a malformed offset (`{{$timestamp 1 x}}` silently gives "now"). Streamscope blocks the request instead, because sending a wrong value is an anti-goal.
4. **Body text uses `\n`, not the platform's EOL.** REST Client uses `os.EOL`, which is CRLF on Windows. `\n` gives the same bytes on every machine.
5. **Form bodies are sent as written.** REST Client's automatic form-encoding is not reproduced.
6. **Pretty JSON is produced by re-indenting the original text after `JSON.parse` validates it, instead of `JSON.stringify(JSON.parse())`.** Numbers keep their digits and duplicate keys stay, as received.
7. **The response document opens when the run ends.** Live viewing is M6.
8. **Large responses rely on VS Code's own large-file handling.** The body document is served through a `FileSystemProvider`, so bytes cross to the renderer without being serialized as a string in the extension host. It is not rendered progressively. The extension stays one bundle (plus the worker), so transport code loads at activation rather than on first send; the M11 benchmark checks the 50 ms activation budget. Design section 17 is updated.

## Review Focus

- **A request sent with an unresolved or wrong value.** Every unresolved reference must block the send and name the variable and its line.
  - Task 3: resolver tests.
  - Task 11: blocked runs never reach the server.
  - Task 13: integration test.
- **Sockets left open after Stop, timeout or failure.** The server side must see its socket close.
  - Task 5: cancel tests.
  - Task 11: re-send test.
  - Task 13: Stop integration test.
- **Credentials crossing origins.** A redirect from one origin to another must not carry `Authorization` or `Cookie`.
  - Task 8: pure and socket-level tests.
- **A body that looks different from what was received.** Big integers, duplicate keys, non-UTF-8 charsets and NDJSON labelled `application/json` must be shown as received.
  - Task 9: format tests.
- **Empty compressed bodies.** HEAD, 204 and 304 responses with `Content-Encoding: gzip` must complete.
  - Task 6: tests.

The 50 MB acceptance test (Task 14) guards against freezes. Its event-loop bound (250 ms) is a CI-noise guard, not the 50 ms design budget; that budget is measured by the M11 benchmark.

---

### Task 1: M1 carry-overs

**Files:**

- Create: `src/http-file/ranges.ts`
- Modify:
  - `src/http-file/model.ts`, `src/http-file/parse.ts`, `src/http-file/references.ts`
  - `src/vscode/language/register.ts`
  - `package.json`
- Test: `test/unit/manifest.test.ts`, `test/unit/http-file/request.test.ts`, `test/integration/language.test.ts`

**Interfaces:**

- Produces: `export function span(line: number, start: number, end: number): Range` in `ranges.ts`, used by `parse.ts` and `references.ts`; `export const directiveKinds = ['name', 'capture', 'expect', 'stream', 'timeout', 'until', 'insecure', 'no-redirect', 'no-cookie-jar', 'note', 'prompt'] as const` and `export type DirectiveKind = (typeof directiveKinds)[number]` in `model.ts`, used by `parse.ts`; `export const httpSelector: vscode.DocumentFilter[] = [{ language: 'http', scheme: 'file' }, { language: 'http', scheme: 'untitled' }]` in `register.ts`.

- [ ] **Step 1: Failing tests**
  - In `manifest.test.ts`, `contributes the http language and grammar` expects `embeddedLanguages: { 'meta.embedded.block.json': 'json' }`.
  - In `request.test.ts`, `reports references inside body file paths`: a body line `< ./{{dir}}/payload.json` yields a `variableReferences` entry with expression `dir` whose range is on that line, columns 4 to 11.
  - In `language.test.ts`, `ignores http documents from other schemes`:
    1. The test registers a `TextDocumentContentProvider` for scheme `streamscope-test` that returns `GET {{unclosed`.
    2. It opens `streamscope-test:/broken.http` and waits 500 ms.
    3. It expects `vscode.languages.getDiagnostics(uri)` to be empty.
- [ ] **Step 2: Run** `npx vitest run test/unit/manifest.test.ts test/unit/http-file/request.test.ts` — Expected: 2 failures. Run `npm run test:integration -- --label stable` — Expected: the new test fails.
- [ ] **Step 3: Implement**
  - Grammar key in `package.json`.
  - `requestReferences` scans body file lines too.
  - `span` and `directiveKinds` deduplicated.
  - `register.ts` uses `httpSelector`, ignores documents whose scheme is not `file`/`untitled`, and skips `onDidChangeTextDocument` events with no `contentChanges`.
- [ ] **Step 4: Verify** — Run: `npm run check && npm run test:integration`. Expected: pass on stable and 1.101.0.
- [ ] **Step 5: Commit** — `git commit -m "Apply M1 review follow-ups"`.

### Task 2: Dates and system variables

**Files:**

- Create: `src/variables/dates.ts`, `src/variables/system.ts`
- Test: `test/unit/variables/dates.test.ts`, `test/unit/variables/system.test.ts`

**Interfaces:**

- Produces:

```ts
export type OffsetUnit = 'y' | 'Q' | 'M' | 'w' | 'd' | 'h' | 'm' | 's' | 'ms';
export type Zone = 'utc' | 'local';
export function addOffset(date: Date, amount: number, unit: OffsetUnit, zone: Zone): Date;
export function formatDate(date: Date, pattern: string, zone: Zone): string;

export interface SystemContext {
  now(): Date;
  randomInt(minInclusive: number, maxExclusive: number): number;
  uuid(): string;
}
export type SystemValue = { ok: true; value: string } | { ok: false; message: string };
export function resolveSystemVariable(expression: string, context: SystemContext): SystemValue;
```

- `addOffset`:
  - `y`, `Q`, `M`, `w` and `d` use calendar fields in the zone. Months clamp to the last day, like Day.js.
  - `h`, `m`, `s` and `ms` add milliseconds.
- `formatDate` supports the Day.js core tokens:
  - `YYYY YY M MM MMM MMMM D DD d dd ddd dddd H HH h hh m mm s ss SSS A a Z ZZ`;
  - `[literal]` escapes;
  - English names.
- Fixed values:
  - `rfc1123` in UTC is `Date.prototype.toUTCString()`; local is `ddd, DD MMM YYYY HH:mm:ss ZZ`.
  - `iso8601` in UTC is `toISOString()`; local is `YYYY-MM-DDTHH:mm:ssZ`.

- [ ] **Step 1: Failing tests.** Context: `now` = `2026-11-11T10:20:30.456Z`, `uuid` returns `'00000000-0000-4000-8000-000000000001'`, `randomInt` records its arguments and returns `7`. Local-time tests use `vi.stubEnv('TZ', 'Asia/Kolkata')`.
  - **`dates.test.ts`:**
    - `adds calendar months and clamps to the month end`: `2026-01-31T10:00Z + 1 M` (utc) gives `2026-02-28T10:00:00.000Z`.
    - `formats every supported token`: pattern `[at] YYYY YY M MM MMM MMMM D DD d dd ddd dddd H HH h hh m mm s ss SSS A a Z ZZ` in utc gives `at 2026 26 11 11 Nov November 11 11 3 We Wed Wednesday 10 10 10 10 20 20 30 30 456 AM am +00:00 +0000`.
    - `formats in local time`: `HH:mm Z` gives `15:50 +05:30`.
  - **`system.test.ts`:**
    - `$guid` gives the context uuid.
    - `$timestamp` gives `'1794392430'`.
    - `$timestamp -3 h` gives `'1794381630'`.
    - `$datetime iso8601` gives `'2026-11-11T10:20:30.456Z'`.
    - `$datetime rfc1123` gives `'Wed, 11 Nov 2026 10:20:30 GMT'`.
    - `$datetime "YYYY-MM-DD" 1 M` gives `'2026-12-11'`.
    - `$datetime 'DD MMM YYYY' -1 y` gives `'11 Nov 2025'`.
    - `$localDatetime iso8601` gives `'2026-11-11T15:50:30+05:30'`.
    - `$localDatetime rfc1123` gives `'Wed, 11 Nov 2026 15:50:30 +0530'`.
    - `$randomInt 1 10` gives `'7'`, with arguments `(1, 10)`.
    - Each of these is a problem, and its message contains the quoted text: `$timestamp 1 x` (expected format), `$randomInt 5` (expected format), `$nope` ("Unknown system variable"), `$processEnv HOME` ("not supported yet"), `$dotenv KEY`, `$aadToken`.
- [ ] **Step 2: Run** `npx vitest run test/unit/variables` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Resolve REST Client system variables"`.

### Task 3: File variables and request resolution

**Files:**

- Create: `src/variables/resolve.ts`
- Test: `test/unit/variables/resolve.test.ts`

**Interfaces:**

- Consumes:
  - `HttpFile`, `HttpRequest`, `Range` from `src/http-file/model.ts`;
  - `parseHttpFile` (in tests);
  - `resolveSystemVariable`, `SystemContext` (Task 2).
- Produces:

```ts
export interface ResolutionProblem {
  message: string;
  range: Range;
}
export type ResolvedBodyPart =
  | { kind: 'text'; lines: string[] }
  | {
      kind: 'file';
      path: string;
      processVariables: boolean;
      encoding: string | undefined;
      pathRange: Range;
    };
export interface ResolvedRequest {
  method: string;
  url: string;
  urlRange: Range;
  headers: { name: string; value: string }[];
  body: ResolvedBodyPart[];
}
export interface VariableScope {
  resolveText(text: string): { ok: true; text: string } | { ok: false; messages: string[] };
}
export type Resolution =
  | { ok: true; request: ResolvedRequest; scope: VariableScope }
  | { ok: false; problems: ResolutionProblem[] };
export function resolveRequest(
  file: HttpFile,
  request: HttpRequest,
  context: SystemContext,
): Resolution;
```

- Problem ranges:
  - A reference in the request reports every matching `request.variableReferences` range.
  - A problem inside a file variable's value reports that variable's `valueRange`.
- Messages:
  - `` `{{host}}` is not defined. ``
  - `` `{{a}}` and `{{b}}` refer to each other. ``
  - ``Request references such as `{{login.response.body.$.token}}` are not supported yet.``
  - The system-variable message from Task 2.

- [ ] **Step 1: Failing tests** (`resolve.test.ts`), with files built from string arrays:
  - `resolves file variables in the url, header names and values, and body text`.
  - `unescapes \n, \r, \t and other escaped characters in file variable values`: the raw value `a\nb\tc\\d\qe` gives `a`, LF, `b`, TAB, `c\dqe`.
  - `uses the last definition of a file variable`.
  - `resolves file variables that refer to later file variables and to system variables`: `@base = https://{{host}}/v1` comes before `@host = api.example.test`.
  - `evaluates a system variable inside a file variable once per send`: `@id = {{$guid}}`, used twice with a uuid stub returning successive values, gives the same value twice.
  - `evaluates each system variable in the request separately`.
  - `trims whitespace inside braces`.
  - `reports an undefined variable at every place it is used`: two ranges, `ok: false`.
  - `reports file variables that refer to each other` at the first variable's `valueRange`.
  - `reports request references as not supported yet`.
  - `resolves variables in body file paths and keeps the file part`.
  - `scope.resolveText resolves file and system variables in file contents`, and reports an undefined one by message.
- [ ] **Step 2: Run** `npx vitest run test/unit/variables/resolve.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**
  1. Build a map of unescaped file variables.
  2. Resolve file variables depth-first with cycle detection, caching values per `resolveRequest` call.
  3. Substitute references in a single pass. Inserted values are not re-scanned.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Resolve file and system variables before sending"`.

### Task 4: Test support (local servers and certificates)

**Files:**

- Create: `test/support/servers.ts`, `test/support/certificate.ts`
- Modify:
  - `test/unit/tsconfig.json` (include `../support`);
  - `test/integration/tsconfig.json` (`rootDir: ".."`, `outDir: "../../out"`, include `.` and `../support`).
- Test: `test/unit/support.test.ts`

**Interfaces:**

- Produces:

```ts
export interface LocalServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  sockets: { opened: number; closed: number };
  close(): Promise<void>;
}
export interface RecordedRequest {
  method: string;
  url: string;
  rawHeaders: string[];
  body: Buffer;
}
export function startHttpServer(handler: http.RequestListener): Promise<LocalServer>;
export function startHttpsServer(
  credentials: { cert: string; key: string },
  handler: http.RequestListener,
): Promise<LocalServer>;
export function startRawServer(onSocket: (socket: net.Socket) => void): Promise<LocalServer>;
export function createSelfSignedCertificate(hosts: readonly string[]): {
  cert: string;
  key: string;
};
```

- The HTTP servers record each request with its full body before calling `handler`, and count socket open and close.
- `createSelfSignedCertificate`:
  - builds an X.509 v3 certificate in DER with `node:crypto` only: a P-256 key, ECDSA-SHA256, validity now ±1 day, CN of the first host, `subjectAltName` with DNS or IP entries, and `basicConstraints CA:TRUE`;
  - returns PEM.
- No openssl and no committed key.

- [ ] **Step 1: Failing tests** (`support.test.ts`):
  - `creates a certificate Node accepts`: `new X509Certificate(cert).subjectAltName` is `'DNS:localhost, IP Address:127.0.0.1'`, and `tls.createSecureContext({ cert, key })` does not throw.
  - `records requests and socket lifecycle`: a POST via `http.request` is recorded with its body, and after `close()`, `sockets.closed === sockets.opened`.
- [ ] **Step 2: Run** `npx vitest run test/unit/support.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both helpers (a minimal DER encoder for SEQUENCE, SET, INTEGER, OID, UTF8String, UTCTime, BIT STRING, OCTET STRING, BOOLEAN and context tags).
- [ ] **Step 4: Run** the same command, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add local test servers and a generated test certificate"`.

### Task 5: Transport exchange

**Files:**

- Create: `src/transport/model.ts`, `src/transport/node-transport.ts`, `src/transport/failures.ts`
- Test: `test/unit/transport/exchange.test.ts`

**Interfaces:**

- Consumes: test support (Task 4).
- Produces:

```ts
export type Headers = readonly (readonly [string, string])[];
export type BodyPart =
  { kind: 'bytes'; bytes: Uint8Array } | { kind: 'file'; path: string; size: number };
export interface OutgoingRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: readonly BodyPart[];
}
export interface TransportOptions {
  rejectUnauthorized: boolean;
  ca: readonly string[] | undefined;
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  totalTimeoutMs: number | undefined;
  followRedirects: boolean;
  maxRedirects: number;
}
export interface SentRequest {
  method: string;
  url: string;
  headers: Headers;
}
export interface ResponseHead {
  httpVersion: string;
  status: number;
  statusText: string;
  headers: Headers;
}
export interface RedirectHop {
  request: SentRequest;
  status: number;
  statusText: string;
  location: string;
}
export interface Timing {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  firstByteMs?: number;
  totalMs: number;
}
export interface ResponseSink {
  onHead(head: ResponseHead, sent: SentRequest): void;
  onData(chunk: Uint8Array): void;
}
export type FailureKind =
  | 'dns'
  | 'refused'
  | 'reset'
  | 'tls'
  | 'connect-timeout'
  | 'headers-timeout'
  | 'total-timeout'
  | 'premature-close'
  | 'protocol'
  | 'decompression'
  | 'redirect'
  | 'invalid-request'
  | 'body-file';
export interface Failure {
  kind: FailureKind;
  message: string;
  code: string | undefined;
}
export interface Exchange {
  hops: RedirectHop[];
  timing: Timing;
  wireBytes: number;
  decodedBytes: number;
}
export type Outcome =
  | ({ kind: 'completed' } & Exchange)
  | ({ kind: 'failed'; failure: Failure } & Exchange)
  | ({ kind: 'cancelled' } & Exchange);
export interface Transport {
  send(
    request: OutgoingRequest,
    options: TransportOptions,
    sink: ResponseSink,
    signal: AbortSignal,
  ): Promise<Outcome>;
}
export class NodeTransport implements Transport {}
export function classifyError(error: unknown, phase: 'connect' | 'headers' | 'body'): Failure;
```

- `classifyError` maps Node error codes to kinds:
  - `ENOTFOUND` and `EAI_AGAIN` → `dns`;
  - `ECONNREFUSED` → `refused`;
  - `ECONNRESET` before the head → `reset`, and after it → `premature-close`;
  - TLS certificate and `ERR_SSL_*` / `ERR_TLS_*` codes → `tls`;
  - `HPE_*` → `protocol`;
  - `ERR_INVALID_HTTP_TOKEN` and `ERR_INVALID_CHAR` → `invalid-request`.

  Each failure message is one plain sentence naming the host or setting involved, for example `Connection refused: nothing is listening at 127.0.0.1:9.`

- Timing comes from the socket's `lookup`, `connect` and `secureConnect` events and the `response` event. A reused or already-connected socket leaves those fields undefined.
- Headers are passed as an object whose keys keep their casing; repeated names become arrays.

- [ ] **Step 1: Failing tests** (`exchange.test.ts`):
  - `sends the method in upper case, headers in written order and casing, and the body`: the server's `rawHeaders` start with the user headers in order.
  - `adds Host, Accept-Encoding and Content-Length only when missing`: with no Accept-Encoding, it is `gzip, deflate, br, zstd`. A user `Accept-Encoding: identity` is kept. GET with no body has no Content-Length. A user `Content-Length: 1` is replaced by the true length.
  - `sends body parts in order, streaming file parts`: bytes, a temp file and bytes arrive concatenated, with matching Content-Length.
  - `delivers the head with duplicate raw headers and every body chunk`: two `Set-Cookie` lines are kept.
  - `records connect, first-byte and total timing`.
  - `fails with refused when nothing listens` (port of a closed server).
  - `fails with dns for an unresolvable host` (`http://streamscope.invalid/`).
  - `fails with premature-close when the connection drops mid-body` (raw server: Content-Length 100, 10 bytes, destroy). The sink received 10 bytes and `decodedBytes` is 10.
  - `fails with protocol for invalid chunked encoding` (raw server writes chunk size `zz`).
  - `parses a response whose CRLFs arrive split across packets` (raw server writes one byte every 2 ms) → completed.
  - `fails with headers-timeout when the server never answers` (`headersTimeoutMs: 200`).
  - `fails with total-timeout during a slow body` (`totalTimeoutMs: 300`, server drips every 100 ms).
  - `cancels before the response and closes the socket`.
  - `cancels during the body and closes the socket`: the outcome is `cancelled`, and the server's `sockets.closed` reaches `sockets.opened` within 1 s.
  - `fails with invalid-request for an invalid header name without connecting` (`Bad Header`).
  - `fails with body-file when a file part has disappeared`.
- [ ] **Step 2: Run** `npx vitest run test/unit/transport/exchange.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `NodeTransport.send` for a single exchange (redirects come in Task 8, decompression in Task 6, and https options in Task 7).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Send requests over node:http with timing, timeouts and cancellation"`.

### Task 6: Decompression

**Files:**

- Create: `src/transport/decompress.ts`
- Modify: `src/transport/node-transport.ts`
- Test: `test/unit/transport/decompress.test.ts`

**Interfaces:**

- Produces: `export function createDecoder(contentEncoding: string | undefined): Transform | undefined`, which returns `undefined` when nothing needs decoding.

- [ ] **Step 1: Failing tests:**
  - `decodes <coding>` for `gzip`, `x-gzip`, `deflate`, `br` and `zstd` (compressed with `zlib.*Sync`). The body equals the original, `wireBytes` equals the compressed length and `decodedBytes` the original length.
  - `decodes chained codings in reverse order` (`Content-Encoding: gzip, br`).
  - `completes HEAD, 204 and 304 responses that declare gzip but carry no body`.
  - `passes unknown codings through unchanged` (`Content-Encoding: snappy`).
  - `fails with decompression for a corrupt gzip body`.
  - `delivers decoded data before the response ends`: the server writes a gzip stream flushed with `Z_SYNC_FLUSH` after the first chunk and waits; the sink receives the first decoded chunk while the server is still holding the response.
- [ ] **Step 2: Run** `npx vitest run test/unit/transport/decompress.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `createDecoder` and plug it in lazily on the first body chunk.
- [ ] **Step 4: Run** `npx vitest run test/unit/transport` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Decompress gzip, deflate, br and zstd responses"`.

### Task 7: TLS options and trusted certificates

**Files:**

- Create: `src/transport/certificates.ts`
- Modify: `src/transport/node-transport.ts`
- Test: `test/unit/transport/tls.test.ts`

**Interfaces:**

- Produces: `export function trustedCertificates(custom: readonly string[]): string[]`. It returns `getCACertificates('default')`, then `getCACertificates('system')`, then `custom`, without duplicates.

- [ ] **Step 1: Failing tests:**
  - `rejects a self-signed server by default with a tls failure`.
  - `accepts it when verification is off for the request` (`rejectUnauthorized: false`).
  - `accepts it when its certificate is a custom CA` (`ca: trustedCertificates([cert])`).
  - `keeps the default and system roots when a custom CA is added`, without duplicates.
  - `records the TLS handshake time`.
  - `fails with connect-timeout when the TLS handshake never completes` (raw server that accepts and stays silent, `connectTimeoutMs: 200`).
- [ ] **Step 2: Run** `npx vitest run test/unit/transport/tls.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**
  - Pass `rejectUnauthorized` and `ca` to `https.request` only for `https:` URLs.
  - The connect timer ends at `secureConnect` for https.
  - Add an "Accepted findings" entry to `.claude/claude-security-guidance.md`: `rejectUnauthorized: false` in `src/transport/node-transport.ts` is the per-request `# @insecure` opt-out (FR, design section 6), never global.
- [ ] **Step 4: Run** `npx vitest run test/unit/transport` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Support per-request TLS opt-out and custom CAs"`.

### Task 8: Redirects

**Files:**

- Create: `src/transport/redirects.ts`
- Modify: `src/transport/node-transport.ts`
- Test: `test/unit/transport/redirects.test.ts`

**Interfaces:**

- Produces:

```ts
export const redirectStatuses: ReadonlySet<number>;
export function redirectTarget(
  request: OutgoingRequest,
  status: number,
  location: string,
): { ok: true; request: OutgoingRequest } | { ok: false; message: string };
```

- [ ] **Step 1: Failing tests.**
  - **Pure:**
    - `turns 301, 302 and 303 into GET without a body or body headers`.
    - `keeps HEAD for 301 to 303`.
    - `replays method and body for 307 and 308`.
    - `resolves relative locations against the current url`.
    - `drops Authorization, Proxy-Authorization, Cookie and a user Host across origins`: this covers `http://a` → `https://a` and a port change.
    - `keeps them within the same origin`.
    - `rejects locations that are not http or https`.
  - **Socket-level:**
    - `follows 302 then 307 and records both hops`: the 307 hop receives the replayed body, and `hops[0].request.method` is `POST`.
    - `never sends Authorization to another origin`: two servers, a 302 from the first to the second. The second's recorded headers have no `Authorization`.
    - `fails with redirect after maxRedirects` (a self-loop with `maxRedirects: 3` gives 3 hops).
    - `returns the 3xx itself when following is off`.
    - `treats a 3xx without Location as the response`.
- [ ] **Step 2: Run** `npx vitest run test/unit/transport/redirects.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**
  - `redirectTarget` and the loop in `NodeTransport.send`.
  - A redirect response is destroyed without being passed to the sink.
  - Timing covers the final exchange; `totalMs` covers the whole send.
- [ ] **Step 4: Run** `npx vitest run test/unit/transport` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Follow redirects with recorded hops and origin-safe headers"`.

### Task 9: Body formatting and the format worker

**Files:**

- Create: `src/response/reindent-json.ts`, `src/response/format-body.ts`, `src/response/format-worker.ts`, `src/response/format-off-thread.ts`
- Modify:
  - `esbuild.mjs` (entry points `extension` and `format-worker`, `outdir: 'dist'`);
  - `package.json` (`files` gains `dist/format-worker.js`);
  - `test/unit/manifest.test.ts`;
  - `test/vsix/installed-extension.ts` (checks `dist/format-worker.js` exists).
- Test: `test/unit/response/reindent-json.test.ts`, `test/unit/response/format-body.test.ts`

**Interfaces:**

- Produces:

```ts
export function reindentJson(text: string): string;
export type BodyLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'css' | 'plaintext';
export interface FormattedBody {
  languageId: BodyLanguage;
  text: string;
  binary: boolean;
}
export function formatBody(bytes: Uint8Array, contentType: string | undefined): FormattedBody;
export interface EncodedBody {
  languageId: BodyLanguage;
  binary: boolean;
  content: Uint8Array;
}
export const workerThresholdBytes = 1_048_576;
export function formatBodyOffThread(
  bytes: Uint8Array,
  contentType: string | undefined,
  workerFile: string,
): Promise<EncodedBody>;
```

- `reindentJson` takes text that `JSON.parse` accepted and re-indents it, 2 spaces per level:
  - Whitespace outside strings is dropped.
  - `{` and `[` open a new indented line unless the next token closes them (`{}`, `[]`).
  - `,` ends the line.
  - `:` becomes `: `.
  - Strings, escapes and numbers are copied verbatim.
- `formatBody` rules:
  - Empty input gives `plaintext`, `''`.
  - Binary bodies give `plaintext` with `Binary body (<size>). Use Save Response to keep it.` and `binary: true`. A body is binary when:
    - its media type is `image/*`, `audio/*`, `video/*` or `font/*`;
    - or it is `application/octet-stream`, `application/pdf`, `application/zip`, `application/gzip` or `application/wasm`;
    - or there is no content type and the body contains a NUL byte.
  - Text is decoded with `TextDecoder` using the `charset` parameter, or UTF-8 when the label is unknown.
  - JSON: when the media type is `application/json` or `*+json`, or when it is absent or `text/plain` and the first non-space character is `{` or `[`, a body that passes `JSON.parse` gives `json` with `reindentJson`. Otherwise the text stays unchanged as `plaintext`.
  - Other languages: `xml` for `*/xml` and `*+xml`, `html`, `javascript`, `css`, and `plaintext` for everything else.
- `formatBodyOffThread` formats inline below the threshold. Above it, it starts a `Worker`, transfers a copy of the bytes, receives the UTF-8 `content` as a transferred buffer, and terminates the worker on every exit path.

- [ ] **Step 1: Failing tests:**
  - **`reindent-json.test.ts`:**
    - `indents nested objects and arrays` (exact multi-line expectation).
    - `keeps empty objects and arrays inline`.
    - `copies strings with braces, commas, quotes and backslashes unchanged`.
    - `keeps numbers digit for digit` (`12345678901234567890`, `1.0`, `1e400`, `-0`).
    - `keeps duplicate keys`.
  - **`format-body.test.ts`:**
    - `pretty-prints application/json`.
    - `pretty-prints +json types`.
    - `pretty-prints JSON sent as text/plain or without a type`.
    - `shows NDJSON labelled application/json unchanged as plaintext`.
    - `maps xml, html, javascript and css`.
    - `decodes the declared charset` (`iso-8859-1` byte 0xE9 gives `é`).
    - `falls back to UTF-8 for unknown charsets`.
    - `describes image/png as binary` (`Binary body (2.0 KB). Use Save Response to keep it.`).
    - `treats NUL bytes without a type as binary`.
    - `formats an empty body as empty text`.
    - `formats small bodies inline without a worker` (worker file `/nonexistent.js`).
    - `formats large bodies in a worker`: `beforeAll` bundles `src/response/format-worker.ts` with esbuild to a temp `.js`; a 2 MiB JSON body gives the same text as `formatBody`.
- [ ] **Step 2: Run** `npx vitest run test/unit/response test/unit/manifest.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the four modules and the build and manifest changes.
- [ ] **Step 4: Verify** — Run: `npx vitest run test/unit/response test/unit/manifest.test.ts && npm run build && ls dist`. Expected: PASS, and `dist` lists `extension.js` and `format-worker.js`.
- [ ] **Step 5: Commit** — `git commit -m "Format response bodies, large ones in a worker"`.

### Task 10: Outgoing request builder and body files

**Files:**

- Create: `src/runs/body-files.ts`, `src/runs/build-request.ts`
- Test: `test/unit/runs/body-files.test.ts`, `test/unit/runs/build-request.test.ts`

**Interfaces:**

- Consumes: `ResolvedRequest`, `VariableScope`, `ResolutionProblem` (Task 3); `OutgoingRequest`, `BodyPart` (Task 5).
- Produces:

```ts
export interface BodyFileContext {
  documentDir: string | undefined;
  containmentRoot: string | undefined;
}
export function locateBodyFile(
  path: string,
  context: BodyFileContext,
): Promise<{ ok: true; path: string; size: number } | { ok: false; message: string }>;
export type BuildResult =
  { ok: true; request: OutgoingRequest } | { ok: false; problems: ResolutionProblem[] };
export function buildOutgoingRequest(
  resolved: ResolvedRequest,
  scope: VariableScope,
  context: BodyFileContext,
): Promise<BuildResult>;
```

- URL rules:
  - A URL starting with `/` plus a `Host` header becomes `http://<host><path>`, or `https://` when the Host port is 443 or 8443.
  - Anything that is not an `http:` or `https:` URL is the problem `` `<url>` is not a valid http or https URL. `` at `urlRange`.
- Body joining and file rules are in Global Constraints.
- Messages:
  - ``Body file `<path>` was not found.``
  - ``Body file `<path>` resolves outside the workspace folder.``
  - `Save the .http file first: body files are read relative to it.`
  - ``Unsupported encoding `<name>`.``
  - Each problem is placed at the file part's `pathRange`.

- [ ] **Step 1: Failing tests** (temp directories):
  - **`body-files.test.ts`:**
    - `prefers the workspace folder over the file's folder`.
    - `accepts absolute paths inside the root`.
    - `rejects ../ paths outside the root`.
    - `rejects a symlink that points outside the root`.
    - `rejects body files without a containment root`.
    - `reports a missing file`.
  - **`build-request.test.ts`:**
    - `parses the url and keeps headers in order`.
    - `builds the url from a Host header and a path` (`Host: api.example.test:8443` gives `https://api.example.test:8443/items`).
    - `reports an invalid url` (`ftp://api.example.test` and `not a url`).
    - `joins text lines with LF`.
    - `uses CRLF for multipart/form-data`.
    - `appends & lines without a separator for form bodies`.
    - `adds a trailing newline for application/x-ndjson`.
    - `ends every line and part with the line ending when a file part is present`.
    - `streams < files as file parts with their size`.
    - `reads <@latin1 files, resolves their variables and sends UTF-8`.
    - `reports an unsupported encoding`.
- [ ] **Step 2: Run** `npx vitest run test/unit/runs` — Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Build outgoing requests and read body files safely"`.

### Task 11: Runs and the run registry

**Files:**

- Create: `src/runs/duration.ts`, `src/runs/run.ts`, `src/runs/registry.ts`
- Modify: `src/http-file/directives.ts` (`# @timeout` validated with `parseDuration`)
- Test: `test/unit/runs/duration.test.ts`, `test/unit/runs/run.test.ts`, `test/unit/runs/registry.test.ts`

**Interfaces:**

- Consumes: Tasks 3, 5 and 10.
- Produces:

```ts
export function parseDuration(text: string): number | undefined;

export type RunStatus = 'sending' | 'receiving' | 'completed' | 'failed' | 'cancelled' | 'blocked';
export interface RunFailure {
  kind: FailureKind | 'body-too-large';
  message: string;
}
export interface RunSnapshot {
  id: number;
  key: string;
  label: string;
  status: RunStatus;
  startedAt: number;
  elapsedMs: number;
  sent: SentRequest | undefined;
  head: ResponseHead | undefined;
  hops: readonly RedirectHop[];
  timing: Timing | undefined;
  wireBytes: number;
  body: Uint8Array;
  failure: RunFailure | undefined;
  problems: readonly ResolutionProblem[];
}
export interface RequestSettings {
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  ca: readonly string[] | undefined;
  maxBodyBytes: number;
}
export interface RunInput {
  key: string;
  label: string;
  file: HttpFile;
  request: HttpRequest;
  bodyFiles: BodyFileContext;
  settings: RequestSettings;
}
export interface RunDependencies {
  transport: Transport;
  system: SystemContext;
  clock(): number;
}
export interface RunHandle {
  readonly id: number;
  readonly done: Promise<RunSnapshot>;
  snapshot(): RunSnapshot;
  cancel(): void;
}
export function startRun(input: RunInput, dependencies: RunDependencies): RunHandle;
export function requestKey(documentUri: string, request: HttpRequest, index: number): string;
export class RunRegistry {
  constructor(dependencies: RunDependencies);
  start(input: RunInput): RunHandle;
  latest(key: string): RunHandle | undefined;
  cancel(key: string): boolean;
  isRunning(): boolean;
  onDidChange(listener: (snapshot: RunSnapshot) => void): () => void;
  dispose(): void;
}
```

- Directive mapping:
  - `# @insecure` sets `rejectUnauthorized: false`.
  - `# @no-redirect` sets `followRedirects: false`.
  - `# @timeout` sets `totalTimeoutMs`.
- `requestKey` is `<uri>\n@<name>` when the request has a name, otherwise `<uri>\n#<index> <METHOD> <url>`.
- `body` holds the concatenated bytes once the run ends (`new Uint8Array()` before).
- Exceeding `maxBodyBytes` aborts the transport and fails with `body-too-large`.
- `RunRegistry.start` cancels a running run with the same key first.
- Listeners are called on every status change.

- [ ] **Step 1: Failing tests:**
  - **`duration.test.ts`:** `parses ms, s and m` (`500ms` → 500, `30s` → 30000, `5m` → 300000); `rejects other forms` (`1h`, `30`, `s`, ` 30s`).
  - **`run.test.ts`** (real servers):
    - `completes with head, body, hops and timing`.
    - `blocks without contacting the server when a variable is missing` (server records 0 requests).
    - `turns off TLS verification only for the request marked # @insecure`: two requests in one file to the same self-signed server; the marked one completes and the other fails with `tls`.
    - `applies # @timeout as the total limit`.
    - `does not follow redirects for # @no-redirect`.
    - `fails with body-too-large past maxBodyBytes` (limit 1024).
    - `cancel() ends in cancelled`.
  - **`registry.test.ts`:**
    - `re-sending a running request cancels the earlier run and closes its socket`.
    - `keeps runs of different requests independent`.
    - `notifies listeners on every status change` (sending → receiving → completed).
    - `dispose cancels running runs`.
- [ ] **Step 2: Run** `npx vitest run test/unit/runs test/unit/http-file` — Expected: FAIL.
- [ ] **Step 3: Implement** the three files and switch `directives.ts` to `parseDuration`.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Run requests to a single terminal state"`.

### Task 12: Masking and response documents

**Files:**

- Create: `src/masking/masking.ts`, `src/response/labels.ts`, `src/response/headers-document.ts`
- Test: `test/unit/masking/masking.test.ts`, `test/unit/response/labels.test.ts`, `test/unit/response/headers-document.test.ts`

**Interfaces:**

- Produces:

```ts
export const maskedValue = '••••••';
export function isSensitiveHeader(name: string): boolean;
export function maskHeaders(headers: Headers): [string, string][];
export function maskUrl(url: string): string;

export function requestLabel(request: HttpRequest): string;
export function fileSafeName(label: string): string;
export function bodyExtension(languageId: BodyLanguage): string;
export function saveExtension(contentType: string | undefined): string;
export function formatBytes(bytes: number): string;
export function formatDuration(ms: number): string;
export function describeOutcome(run: RunSnapshot): string;

export function renderHeadersDocument(run: RunSnapshot): string;
```

- `requestLabel` is the name, else the title, else `<METHOD> <url>`.
- `fileSafeName` replaces `/ \ : * ? " < > |` and control characters with `_` and truncates to 60 characters.
- `formatBytes` gives `512 B`, `1.2 KB` or `3.4 MB` (1024-based). `formatDuration` gives `120 ms` or `2.1 s`.
- `describeOutcome` is the CodeLens and log summary:
  - `200 OK · 1.2 KB · 120 ms`;
  - `Failed: <failure message>`;
  - `Cancelled after 2.1 s`;
  - `Not sent: <first problem message>`.
- `renderHeadersDocument`:
  - A completed run (or a cancelled one with a head) starts with `HTTP/<version> <status> <text>` and the masked response headers.
  - A failed run starts with `### Failed` and the failure message.
  - Then come these sections:
    - `### Request` with the masked method, URL and headers as sent;
    - `### Redirects` (only when there are hops), one line per hop: `<METHOD> <masked url> → <status> <text>`;
    - `### Timing` with `DNS · Connect · TLS · First byte · Total` (only the measured parts) and `Received <decoded> (<wire> on the wire)`.
  - Sections are separated by one blank line.

- [ ] **Step 1: Failing tests:**
  - **`masking.test.ts`:**
    - `masks sensitive header values in any letter case and keeps names and order`.
    - `masks a URL password and leaves other URLs unchanged`.
  - **`labels.test.ts`:** each function's examples above, plus `saveExtension` for `application/json` (`.json`), `image/png` (`.png`), `text/csv` (`.csv`) and unknown (`.bin`).
  - **`headers-document.test.ts`**, with exact expected text:
    - `renders a completed run with masked request and response headers` (`Authorization` and `Set-Cookie` show `••••••`).
    - `renders redirect hops`.
    - `renders a failed run`.
    - `renders a run cancelled after its head`.
- [ ] **Step 2: Run** `npx vitest run test/unit/masking test/unit/response` — Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Mask secrets and render the Headers document"`.

### Task 13: Send, Stop, CodeLens and the response view in VS Code

**Files:**

- Create:
  - `src/vscode/requests/register.ts` (`registerRequestFeatures(context, log)`);
  - `src/vscode/requests/code-lens.ts`;
  - `src/vscode/requests/settings.ts`;
  - `src/vscode/response/response-file-system.ts`;
  - `src/vscode/response/presenter.ts`;
  - `src/vscode/log.ts`.
- Modify: `src/extension.ts`, `package.json` (commands, keybinding, menus, configuration), `test/unit/manifest.test.ts`.
- Test: `test/integration/send.test.ts`

**Interfaces:**

- Consumes: Tasks 9, 11 and 12.
- Produces:
  - **Commands:**
    - `streamscope.sendRequest(uri?: Uri, line?: number): Promise<void>` resolves when the run ends and its view is shown. Without arguments it uses the active editor's cursor.
    - `streamscope.stopRequest(uri?: Uri, line?: number)`. Without arguments it uses the cursor's request, or the active response document's request.
    - `streamscope.saveResponse(target?: Uri)` writes the raw decoded body of the active response document's run. Without `target` it asks with `showSaveDialog`, defaulting to the `.http` file's folder, `fileSafeName(label)` and `saveExtension`.
    - `streamscope.showResponseHeaders` and `streamscope.showResponseBody` switch the active response document to the other view.
  - **Settings** (`readRequestSettings(uri: Uri): Promise<{ ok: true; settings: RequestSettings } | { ok: false; message: string }>`):

    | Setting                               | Type                              | Default  |
    | ------------------------------------- | --------------------------------- | -------- |
    | `streamscope.request.connectTimeout`  | string, pattern `^\d+(ms\|s\|m)$` | `"30s"`  |
    | `streamscope.request.headersTimeout`  | same                              | `"300s"` |
    | `streamscope.request.followRedirects` | boolean                           | `true`   |
    | `streamscope.request.maxRedirects`    | integer 0–50                      | `10`     |
    | `streamscope.request.caFile`          | string, `resource` scope          | `""`     |
    | `streamscope.codeLens.enabled`        | boolean                           | `true`   |

    `caFile` is an absolute path, or a path relative to the file's workspace folder (or the file's folder when it has none). It is read with `node:fs` at send time, and an unreadable file blocks the send with a message naming the setting. `maxBodyBytes` is the constant 268,435,456, not a setting.

  - **Response view.**
    - `ResponseFileSystem` serves the per-request body and Headers documents.
    - Writes throw `FileSystemError.NoPermissions`.
    - Updates fire `onDidChangeFile`.
    - A re-run whose body extension changes closes the tabs of the old body URI.
  - **Log.**
    - `→ <METHOD> <masked url>` at info when a run starts.
    - `← <describeOutcome>` at info, or warn for failures, when it ends.
    - Masked request and response headers at debug.
    - No bodies.
  - **CodeLens** on each request line:
    - `Send Request`;
    - while running, `Stop` and `Running · <elapsed>`, refreshed every second;
    - after a run, `Send Request` plus `describeOutcome`, which opens the response with `vscode.open`.
    - Disabled by `streamscope.codeLens.enabled: false`.
  - **Blocked runs** show `showErrorMessage('Not sent: <message> (line <n>).', 'Go to Line')`.

- [ ] **Step 1: Failing tests.**
  - **`manifest.test.ts`:**
    - `contributes the request commands with the shared category`.
    - `binds Send Request to cmd+alt+enter and ctrl+alt+enter in http editors` (exact `when`).
    - `contributes request settings with their defaults`.
    - `ships the worker`.
  - **`send.test.ts`** (local servers started in the extension host):
    - `sends the request under the cursor and shows the pretty body`: a `.json` tab with the `streamscope-response` scheme opens, and `workspace.fs.readFile` gives indented JSON.
    - `shows status, masked request headers and timing in the Headers view`.
    - `lists each redirect hop`.
    - `shows Send, then the outcome, in the CodeLens` (via `vscode.executeCodeLensProvider`).
    - `stops a running request and closes its socket`: the server sees the close and the lens shows `Cancelled`.
    - `does not send a request with an undefined variable`: the server records 0 requests and the lens starts with `Not sent`.
    - `re-sending replaces the response in the same tab`.
    - `saves the raw decoded body`: a gzip JSON response saved to a temp file equals the uncompressed server bytes.
    - `trusts the CA named in streamscope.request.caFile` (self-signed server, setting set and restored).
- [ ] **Step 2: Run** `npx vitest run test/unit/manifest.test.ts`, then `npm run test:integration -- --label stable`. Expected: FAIL.
- [ ] **Step 3: Implement** the files and manifest contributions.
- [ ] **Step 4: Verify** — Run: `npm run check && npm run test:integration`. Expected: PASS on stable and 1.101.0.
- [ ] **Step 5: Commit** — `git commit -m "Send and stop requests and show responses in VS Code"`.

### Task 14: Coexistence notice, large bodies, proxy, docs

**Files:**

- Create:
  - `src/coexistence/send-lenses.ts`;
  - `src/vscode/coexistence.ts`;
  - `test/unit/coexistence/send-lenses.test.ts`;
  - `test/integration/large-body.test.ts`;
  - `test/integration/proxy.test.ts`.
- Modify:
  - `src/extension.ts`;
  - `docs/design.md` (section 6 Timeouts, section 17 activation and large views, section 18 VS Code patch row);
  - `CHANGELOG.md` (Unreleased);
  - `README.md` (Sending requests);
  - `CLAUDE.md` (layout rows for `src/variables`, `src/transport`, `src/runs`, `src/response`, `src/masking`, `src/coexistence`, `src/vscode/requests`, `src/vscode/response` and `test/support`).

**Interfaces:**

- Produces:

```ts
export interface CompetingLens {
  extensionId: string;
  displayName: string;
  section: string;
  turnOff: (current: unknown) => unknown;
}
export interface ExtensionProbe {
  isInstalled(id: string): boolean;
  setting(section: string, key: string): unknown;
}
export function competingSendLenses(probe: ExtensionProbe): CompetingLens[];
```

- REST Client (`humao.rest-client`) counts when `rest-client.enableSendRequestCodeLens !== false`. Its `turnOff` returns `false`.
- httpyac (`anweber.vscode-httpyac`) counts when `httpyac.codelens.send !== false`. Its `turnOff` returns the global object value with `send: false`.
- The notice:
  - is shown once per user (`globalState` key `streamscope.coexistenceNoticeShown`, set on any answer);
  - says `<names> also show a Send link above each request. Turn theirs off so only Streamscope's shows?`;
  - offers `Turn Off` and `Keep Both`;
  - with `Turn Off`, updates each setting at `ConfigurationTarget.Global`.

- [ ] **Step 1: Failing tests:**
  - **`send-lenses.test.ts`:**
    - `finds neither when neither is installed`.
    - `finds REST Client while its Send lens is on`.
    - `ignores REST Client when its lens is off`.
    - `turns off only httpyac's send lens and keeps its other lens settings`.
  - **`large-body.test.ts`:**
    - `opens a 50 MB JSON body without blocking the extension host`. The 50 MB synthetic JSON is built before measuring. `perf_hooks.monitorEventLoopDelay({ resolution: 10 })` runs from send until the body tab exists. Expected: `max` under 250 ms, and `workspace.fs.stat(bodyUri).size` above 50,000,000. The measured max is printed.
  - **`proxy.test.ts`:**
    - `routes http requests through http.proxy`. A local proxy answers `GET http://api.streamscope.test/items` itself, and records it.
    - `tunnels an # @insecure https request through the proxy`. `CONNECT secure.streamscope.test:443` is piped to a local self-signed server, and the request completes.
    - Both tests restore `http.proxy`.
- [ ] **Step 2: Run** `npx vitest run test/unit/coexistence`, then `npm run test:integration -- --label stable`. Expected: FAIL.
- [ ] **Step 3: Implement** the coexistence modules and wire the notice into activation (not awaited). Update the docs listed above.
- [ ] **Step 4: Verify** — Run: `npm run check && npm run test:integration && npm run verify:vsix`. Expected: PASS, with the VSIX under 409,600 bytes and `dist/format-worker.js` installed.
- [ ] **Step 5: Commit** — `git commit -m "Offer to hide other Send lenses; verify large bodies and proxies"`.

### After the last task

1. A fresh whole-branch review on the most capable model, with this plan's Review Focus.
2. One fix pass.
3. `vscode-api-verifier` and `extension-security-reviewer`, which are told to use Bash, not terminal tools, and report no open issues.
4. Push `m2-transport` and open the pull request, only with the user's go-ahead.
