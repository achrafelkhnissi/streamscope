# M1 .http Language and Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.http` and `.rest` files open as language `http`, are coloured by Streamscope's own grammar, show one outline entry and one fold per request, and report syntax problems as diagnostics; underneath, a pure parser turns a document into requests with exact ranges that later milestones build on.

**Architecture:** A pure `src/http-file` module (no `vscode` import) parses text into an `HttpFile` model following REST Client's rules plus Streamscope directives. `src/vscode/language` caches one parse per document version and serves document symbols, folding ranges and diagnostics. A TextMate grammar and language configuration are contributed in `package.json`. The M0 review carry-overs land first.

**Tech Stack:** TypeScript 6.0.3, Vitest 5, @vscode/test-cli, TextMate grammar JSON. No new dependencies.

**Spec:** `docs/design.md` (FR-A1 to FR-A3, sections 4, 5, 16, 19), `docs/roadmap.md` (M1). REST Client behaviour reference: its MIT-licensed source (`src/common/constants.ts`, `src/utils/selector.ts`, `src/utils/httpRequestParser.ts`, `src/utils/requestParserUtil.ts`), read for behaviour only.

## Global Constraints

- Only `src/vscode/**` and `src/extension.ts` import `vscode`; `src/http-file/**` is pure and Vitest-tested.
- Lines split on `\r?\n`; ranges are zero-based `{ line, character }` and never include `\r`.
- REST Client rules to match:
  - separator: a line matching `/^#{3,}/` (column 0); text after the hashes, trimmed, is the request title;
  - comment line: `/^\s*(#|\/{2})/`; comment lines are dropped from request line, headers and body;
  - metadata: `/^\s*(?:#|\/{2})\s*@([\w-]+)(?:\s+(.*?))?\s*$/`, read only before the request line;
  - file variable: `/^\s*@([^\s=]+)\s*=\s*(.*?)\s*$/` on any line of the file;
  - request name: `# @name` argument must match `/^\w+$/`;
  - request line: optional method from `GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE|LOCK|UNLOCK|PROPFIND|PROPPATCH|COPY|MOVE|MKCOL|MKCALENDAR|ACL|SEARCH` (case-insensitive) followed by whitespace, else `GET`; following lines matching `/^\s*[&?]/` continue the URL (joined after trimming); a trailing `/\s+HTTP\/.*$/i` is the HTTP version;
  - headers: the lines after the request line up to the first blank line; `Name: value` split at the first colon, both trimmed; a line without a colon is a header with that name and an empty value;
  - body: the lines after that blank line; a line matching `/^<(?:(@)(\w+)?)?\s+(.+?)\s*$/` is a file part (`@` = process variables, the word after it = encoding);
  - variable reference: `{{` … `}}` with at least one character, non-greedy.
- Streamscope directives (known keywords): `name`, `capture`, `expect`, `stream`, `timeout`, `until`, `insecure`, `no-redirect`, `no-cookie-jar`, `note`, `prompt`. Other `# @word` lines are plain comments.
- Language contribution: id `http`, extensions `.http` and `.rest`, alias `HTTP`, grammar scope `source.http.streamscope`.
- No code comments. No new dependencies. TDD for all code; configuration and docs carry-overs in Task 1 are verified by running the commands named there.
- Work happens on branch `m1-http-language`, one commit per task; push and pull request only with the user's go-ahead.

## Review Focus

- **Windows line endings:** a `.http` file saved with CRLF must parse to the same requests, with ranges that never include `\r`. Task 2 has a CRLF test.
- **`###` inside a body:** REST Client treats any column-0 `###` line as a separator, even in a body. Streamscope must split the same way, so a file behaves identically in both tools. Task 2 has the test.
- **Commented-out JSON fields:** body lines starting with `//` or `#` are dropped as REST Client does. People rely on this to disable fields. Task 3 has the test.
- **Installed package missing language files:** if `files` omits the grammar or language configuration, the Marketplace build loses colouring silently. The manifest test and the installed-VSIX test check both files (Task 5).
- **Large files while typing:** a 5,000-line file must parse in well under a frame so diagnostics and outline never stall typing. Task 4 has a generous-bound timing test, and Task 6 debounces diagnostics.

---

### Task 1: M0 carry-overs

**Files:**

- Modify: `.github/workflows/ci.yml`, `scripts/verify-vsix.mjs`, `package-lock.json`, `CLAUDE.md`, `docs/design.md`, `docs/roadmap.md`, `docs/publishing.md`

- [ ] **Step 1: CI workflow**
  - Cache only `.vscode-test/vscode-*`, keyed `vscode-test-<os>-<hash of .vscode-test.mjs>-<ISO week>`, with a `restore-keys` prefix without the week. Compute the week in a `shell: bash` step with `date -u +%G-%V` written to `$GITHUB_OUTPUT`.
  - `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.
  - `timeout-minutes: 30` on both jobs.
  - `persist-credentials: false` on every checkout.
- [ ] **Step 2: VSIX size gate** — in `scripts/verify-vsix.mjs`, after locating the VSIX, print its size and throw `VSIX is <n> bytes, over the 409600-byte limit` when `statSync(vsix).size > 409600`.
- [ ] **Step 3: Lockfile metadata** — run `npm install --package-lock-only`; `git diff package-lock.json` must change only the root `name` and `license`.
- [ ] **Step 4: Docs** — set the status line of `docs/design.md`, `docs/roadmap.md` and `docs/publishing.md` to `Status: approved 2026-11-11.`. In `CLAUDE.md`, mark product planning as approved, add a `.github/` row to Layout ("CI on Linux, macOS and Windows; Dependabot"), and add to Verification that CI runs `npm run check`, the integration tests and `npm run verify:vsix` on every push and pull request. In `docs/roadmap.md`, move the REST Client and httpyac coexistence notice from M1 to M2 (it concerns the Send CodeLens that M2 adds).
- [ ] **Step 5: Verify** — Run: `npm run check && npm run verify:vsix`. Expected: pass, and verify-vsix prints the VSIX size under 409600 bytes.
- [ ] **Step 6: Commit** — `git commit -m "Apply M0 review follow-ups"`.

### Task 2: Parser skeleton, blocks and directives

**Files:**

- Create: `src/http-file/model.ts`, `src/http-file/parse.ts`
- Test: `test/unit/http-file/blocks.test.ts`

**Interfaces:**

- Produces (in `model.ts`):

```ts
export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export type DirectiveKind =
  | 'name'
  | 'capture'
  | 'expect'
  | 'stream'
  | 'timeout'
  | 'until'
  | 'insecure'
  | 'no-redirect'
  | 'no-cookie-jar'
  | 'note'
  | 'prompt';
export interface Directive {
  kind: DirectiveKind;
  argument: string;
  range: Range;
  argumentRange: Range;
}
export interface FileVariable {
  name: string;
  value: string;
  range: Range;
  nameRange: Range;
  valueRange: Range;
}
export interface RequestLine {
  method: string;
  methodRange: Range | undefined;
  url: string;
  urlRanges: Range[];
  httpVersion: string | undefined;
  range: Range;
}
export interface Header {
  name: string;
  value: string;
  range: Range;
  nameRange: Range;
  valueRange: Range;
}
export type BodyPart =
  | { kind: 'text'; lines: string[]; range: Range }
  | {
      kind: 'file';
      path: string;
      processVariables: boolean;
      encoding: string | undefined;
      range: Range;
      pathRange: Range;
    };
export interface VariableReference {
  expression: string;
  range: Range;
}
export interface HttpRequest {
  range: Range;
  title: string | undefined;
  name: string | undefined;
  directives: Directive[];
  requestLine: RequestLine;
  headers: Header[];
  body: BodyPart[];
  variableReferences: VariableReference[];
}
export type DiagnosticCode =
  | 'unclosed-variable'
  | 'empty-variable'
  | 'invalid-name'
  | 'duplicate-name'
  | 'invalid-capture'
  | 'empty-expect'
  | 'invalid-stream'
  | 'invalid-timeout'
  | 'empty-until'
  | 'unexpected-argument'
  | 'misplaced-directive'
  | 'header-without-colon'
  | 'directives-without-request';
export interface ParseDiagnostic {
  code: DiagnosticCode;
  message: string;
  severity: 'error' | 'warning';
  range: Range;
}
export interface HttpFile {
  requests: HttpRequest[];
  fileVariables: FileVariable[];
  diagnostics: ParseDiagnostic[];
}
```

- Produces (in `parse.ts`): `export function parseHttpFile(text: string): HttpFile`. In this task the request line, headers and body are filled by a minimal implementation (request line only); Task 3 completes them.
- Block rules: a block runs from the line after a separator (or line 0) to the line before the next separator; `range` spans the whole block including its separator line; blocks without a request line are not requests.

- [ ] **Step 1: Write the failing tests** (`blocks.test.ts`), with synthetic files:
  - `splits requests on ### lines and keeps the separator title` → two requests; titles `undefined` and `Create user`; first `range.start.line` 0, second starts at the separator line.
  - `treats ### inside a body as a separator, like REST Client` → a JSON body containing a column-0 `###` line yields two requests.
  - `ignores blocks without a request line` → a file with only comments and `@baseUrl = http://localhost:8080` has zero requests and one file variable `{ name: 'baseUrl', value: 'http://localhost:8080' }`.
  - `collects file variables from any line` → `@a = 1` before the first request and `@b = two words` between requests both appear, with exact `nameRange`/`valueRange`.
  - `reads directives only before the request line` → `# @name createUser`, `// @capture userId = body.id`, `# @expect status == 201` become three directives with kinds, arguments and `argumentRange`; `name` is `createUser`.
  - `treats unknown @ words as comments` → `# @ref other` produces no directive.
  - `handles CRLF without leaking \r into ranges` → the same file with `\r\n` gives identical requests, names and ranges.
- [ ] **Step 2: Run** `npx vitest run test/unit/http-file/blocks.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `model.ts` (types above) and `parseHttpFile` block splitting, file variables and directive collection in `parse.ts`.
- [ ] **Step 4: Run** the same command — Expected: PASS (7 tests).
- [ ] **Step 5: Commit** — `git commit -m "Parse .http files into request blocks"`.

### Task 3: Request line, headers and body

**Files:**

- Modify: `src/http-file/parse.ts`
- Test: `test/unit/http-file/request.test.ts`

**Interfaces:**

- Consumes: `parseHttpFile`, `HttpRequest`, `RequestLine`, `Header`, `BodyPart` from Task 2.

- [ ] **Step 1: Write the failing tests** (`request.test.ts`):
  - `defaults the method to GET` → `https://api.example.test/items` gives method `GET`, `methodRange` `undefined`.
  - `reads method, url and http version` → `post https://api.example.test/items HTTP/1.1` gives method `post` (as written), url `https://api.example.test/items`, httpVersion `HTTP/1.1`, and a `methodRange` covering `post`.
  - `joins query continuation lines` → `GET https://api.example.test/search` followed by `  ?q=stream` and `  &limit=10` gives url `https://api.example.test/search?q=stream&limit=10` with three `urlRanges`.
  - `splits headers at the first colon` → `Authorization: Bearer {{token}}` and `X-Time: 12:30` give values `Bearer {{token}}` and `12:30`.
  - `keeps a header without a colon as an empty-valued header` → `X-Flag` gives `{ name: 'X-Flag', value: '' }`.
  - `drops comment lines from headers and body, like REST Client` → a `// "debug": true,` line inside a JSON body is absent from the body part's `lines`.
  - `reads file parts` → body lines `< ./payload.json`, `<@ ./template.json` and `<@latin1 ./legacy.txt` give file parts with `processVariables` false, true, true and `encoding` `undefined`, `undefined`, `latin1`.
  - `mixes text and file parts in order` → a text line, a file line and another text line give three parts in order.
  - `has no body without a blank line after the headers` → `body` is `[]`.
- [ ] **Step 2: Run** `npx vitest run test/unit/http-file/request.test.ts` — Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement** request line, continuation lines, headers and body parts in `parse.ts` with the Global Constraints rules.
- [ ] **Step 4: Run** `npx vitest run test/unit/http-file` — Expected: PASS (16 tests).
- [ ] **Step 5: Commit** — `git commit -m "Parse request lines, headers and bodies"`.

### Task 4: Variable references and syntax diagnostics

**Files:**

- Modify: `src/http-file/parse.ts`
- Test: `test/unit/http-file/diagnostics.test.ts`

**Interfaces:**

- Consumes: Task 2 model. Produces `HttpRequest.variableReferences` (from the request line, headers and body text; directive lines are not scanned) and `HttpFile.diagnostics`.

Diagnostic rules (severity in brackets):

| Code                                   | Trigger                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `unclosed-variable` [error]            | `{{` with no `}}` later on the same non-comment line                   |
| `empty-variable` [error]               | `{{}}` or `{{ }}`                                                      |
| `invalid-name` [error]                 | `# @name` argument not matching `/^\w+$/`                              |
| `duplicate-name` [error]               | a second request with the same name (range on the later one)           |
| `invalid-capture` [error]              | `capture` argument not matching `/^(secret\s+)?[A-Za-z_]\w*\s*=\s*\S/` |
| `empty-expect` / `empty-until` [error] | no argument                                                            |
| `invalid-stream` [error]               | argument not one of `sse ndjson json text raw auto`                    |
| `invalid-timeout` [error]              | argument not matching `/^\d+(ms                                        | s   | m)$/` |
| `unexpected-argument` [warning]        | an argument on `insecure`, `no-redirect` or `no-cookie-jar`            |
| `misplaced-directive` [warning]        | a known directive after the request line                               |
| `header-without-colon` [warning]       | a header line with no colon                                            |
| `directives-without-request` [warning] | Streamscope directives in a block with no request line                 |

- [ ] **Step 1: Write the failing tests** — one test per code above, each asserting `code`, `severity` and the exact `range`, plus:
  - `records variable references with their ranges` → `GET {{baseUrl}}/users/{{ userId }}` gives expressions `baseUrl` and `userId` (trimmed) and ranges covering the braces;
  - `parses a 5,000-line file quickly` → 1,000 synthetic five-line requests parse in under 200 ms.
- [ ] **Step 2: Run** `npx vitest run test/unit/http-file/diagnostics.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** reference scanning and the diagnostics in `parse.ts`.
- [ ] **Step 4: Run** `npx vitest run test/unit/http-file` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Report .http syntax problems"`.

### Task 5: Language contribution and grammar

**Files:**

- Create: `syntaxes/http.tmLanguage.json`, `language-configuration.json`
- Modify: `package.json`, `test/unit/manifest.test.ts`, `test/vsix/installed-extension.ts`
- Test: `test/unit/grammar.test.ts`

**Interfaces:**

- Produces: `contributes.languages` entry `{ id: 'http', aliases: ['HTTP'], extensions: ['.http', '.rest'], configuration: './language-configuration.json' }`; `contributes.grammars` entry `{ language: 'http', scopeName: 'source.http.streamscope', path: './syntaxes/http.tmLanguage.json', embeddedLanguages: { 'source.json': 'json' } }`; `files` gains `syntaxes/http.tmLanguage.json` and `language-configuration.json`.

- [ ] **Step 1: Write the failing tests**
  - `manifest.test.ts`: `contributes the http language and grammar` asserts the two entries above; `ships the language files` asserts `files` equals `['dist/extension.js', 'syntaxes/http.tmLanguage.json', 'language-configuration.json', 'CHANGELOG.md', 'LICENSE']`.
  - `grammar.test.ts`: `declares the Streamscope scope` (scopeName `source.http.streamscope`); `compiles every pattern` (every `match`, `begin`, `end` and `while` compiles with `new RegExp`); `covers each line kind` (a pattern list contains scopes `meta.separator.http`, `comment.line.http`, `keyword.other.directive.http`, `variable.other.definition.http`, `keyword.control.method.http`, `entity.name.tag.header.http` and `variable.other.reference.http`).
  - `installed-extension.ts`: assert `syntaxes/http.tmLanguage.json` and `language-configuration.json` exist under `extension.extensionPath`.
- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL on the new manifest and grammar tests.
- [ ] **Step 3: Write the grammar and configuration**
  - Patterns, in order: separator with title; directive line (known keywords, argument as `string.unquoted.argument.http`); other comments (`#`, `//`); file variable definition; request line (method, URL, HTTP version); header (name, value); a JSON body region beginning at a line that starts with `{` or `[` and ending before the next separator line, with `contentName` `meta.embedded.block.json` including `source.json`; and `{{…}}` references included in URL, header value, file variable value and body.
  - Case-insensitive parts use scoped groups such as `(?i:GET|POST)`, never a bare `(?i)`, so each pattern compiles in both Oniguruma and JavaScript.
  - Language configuration: line comment `#`, brackets `{}` `[]` `()`, auto-closing `{`/`}`, `[`/`]`, `"`/`"`, folding markers off (folding comes from the provider).
- [ ] **Step 4: Run** `npm run test:unit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Contribute the http language and grammar"`.

### Task 6: Outline, folding and diagnostics in VS Code

**Files:**

- Create: `src/vscode/language/parse-cache.ts`, `src/vscode/language/register.ts`
- Modify: `src/extension.ts`
- Test: `test/integration/language.test.ts`

**Interfaces:**

- Consumes: `parseHttpFile` and the model (Tasks 2 to 4).
- Produces:
  - `parse-cache.ts`: `export class ParseCache { get(document: vscode.TextDocument): HttpFile; delete(uri: vscode.Uri): void }`, which caches by URI and `document.version`.
  - `register.ts`: `export function registerLanguageFeatures(context: vscode.ExtensionContext): void`, registering for selector `{ language: 'http' }`:
    - a DocumentSymbolProvider: one `SymbolKind.Method` symbol per request, named by its `name`, else its `title`, else `METHOD url`, with `detail` `METHOD url`; plus `SymbolKind.Variable` symbols for file variables;
    - a FoldingRangeProvider: one range per request block;
    - a DiagnosticCollection named `streamscope`: updated on open and on change (debounced 200 ms), cleared on close, with severity mapped and `source` `Streamscope`;
    - converting the model's `Range` to `vscode.Range` in one helper.
- `extension.ts` calls `registerLanguageFeatures(context)`; activation stays implicit (`onLanguage:http` from the contribution).

- [ ] **Step 1: Write the failing integration tests** (`language.test.ts`), using a temporary `.http` file written under `os.tmpdir()`:
  - `opens .http files as the http language and activates` → `document.languageId === 'http'` and the extension is active.
  - `lists one symbol per request` → for a three-request synthetic file with one `# @name login`, one title-only request and one bare request, `vscode.executeDocumentSymbolProvider` returns names `login`, `List items` and `GET https://api.example.test/health` (plus the file variable).
  - `folds each request` → `vscode.executeFoldingRangeProvider` returns three ranges matching the blocks.
  - `reports and clears syntax diagnostics` → a document with `{{baseUrl` shows one `unclosed-variable` diagnostic within 2 s; after an edit closing the braces, diagnostics are empty within 2 s.
- [ ] **Step 2: Run** `npm run test:integration -- --label stable` — Expected: FAIL.
- [ ] **Step 3: Implement** `parse-cache.ts`, `register.ts` and the call in `extension.ts`.
- [ ] **Step 4: Run** `npm run check && npm run test:integration && npm run verify:vsix` — Expected: all pass on 1.101.0 and stable; installed VSIX activates and has the language files.
- [ ] **Step 5: Visual check** — open a synthetic `.http` file covering every line kind in the Extension Development Host (light and dark themes) and save screenshots to the plan workspace; colours must distinguish separators, directives, comments, methods, URLs, headers, variables and JSON bodies.
- [ ] **Step 6: Commit** — `git commit -m "Add outline, folding and diagnostics for .http files"`.
