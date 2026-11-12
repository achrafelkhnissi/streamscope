# M3 Environments, Secrets and Workspace Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** variables come from every agreed source with the documented precedence, secrets never leak into anything Streamscope writes, and a restricted workspace never reads secrets, `.env`, private environment files, process environment variables or body files.

**Architecture:**

- Pure modules:
  - `src/environments` parses REST Client settings, `http-client.env.json`, `http-client.private.env.json` and `.env` files, and merges them into one catalog per active environment.
  - `src/variables` resolves `{{…}}` against a `VariableSources` value (file variables, environment, `$shared`, secrets, `.env`, process environment, system variables, the trust state), reports which resolved values are sensitive, and describes single references for hovers, completion and diagnostics.
  - `src/runs` carries the sources and the trust state into each run, masks sensitive values in everything it renders, and asks once before sending from a restricted workspace.
- `src/vscode` adds the environment store and status bar picker, the secret store and its commands, the "Move to secret storage" quick fix, hovers, completion, unresolved-variable diagnostics, and the manifest's Workspace Trust and virtual workspace declarations.
- A separate launcher runs integration tests in a real restricted workspace.

**Tech Stack:** TypeScript 6.0.3, Node `crypto`/`fs`, VS Code `SecretStorage`, `workspaceState`, `StatusBarItem`, hover, completion and code action providers, `@vscode/test-electron` (already a dev dependency). No new dependencies.

**Spec:** `docs/design.md`:

- FR-A3 (hover, completion, unknown-variable diagnostics), FR-A4, FR-N1 to FR-N4, FR-S2;
- sections 6 (environment TLS opt-out), 10 (resolution order), 14 (state), 15 (Workspace Trust, masking) and 19;
- `docs/roadmap.md` M3.

REST Client behaviour reference: its MIT-licensed `environmentVariableProvider.ts` and `systemVariableProvider.ts`, read for behaviour only.

## Global Constraints

- **Layers.** Only `src/vscode/**` and `src/extension.ts` import `vscode`. `src/environments` is pure, like the M2 modules.
- **Precedence** (FR-N4 and design section 10). A bare `{{name}}` resolves from:
  1. a file variable;
  2. the active environment;
  3. `$shared`.

  Captures come first from M7. Within one environment name, `http-client.private.env.json` beats `http-client.env.json`, which beats `rest-client.environmentVariables` (FR-N1).

- **Environment files** are looked up next to the `.http` file first, then at the root of its workspace folder. The public and private files are looked up independently. Only scalar values are read: strings as written, numbers and booleans as text. Objects, arrays and `null` are skipped. The key `"streamscope.insecure": true` (boolean `true` only) marks that environment's requests as TLS opt-out (design section 6), in trusted workspaces only.
- **System variables added in M3:**
  - `{{$secret name}}` with `name` matching `^[\w.-]+$`;
  - `{{$dotenv [%]name}}` with `name` matching `^[\w.-]+$`;
  - `{{$processEnv [%]name}}` with `name` matching `^\w+$`;
  - `{{$shared name}}`.

  The `%` prefix first looks the name up in the active environment and `$shared`, and uses that value as the real name. `$aadToken` and `$aadV2Token` stay "not supported". Request references stay "not supported yet" until M7.

- **`.env` lookup.**
  1. Start in the `.http` file's folder, at `.env.<active environment>` and then `.env`.
  2. Walk up parent folders, stopping at the containment root: the workspace folder, or the file's own folder when it has none.
  3. Read at most 1,048,576 bytes.
  4. An untitled file has no `.env`.
- **Secrets.**
  - SecretStorage key: `streamscope:<workspace hash>:<name>`. The workspace hash is the first 16 hex characters of SHA-256 of the workspace identity, which is `workspace.workspaceFile`, else the first folder's URI, else the literal `no-workspace`.
  - The secret names are listed in `workspaceState` under `streamscope.secretNames`. Names are not secret; values never leave SecretStorage.
- **Sensitive values** are:
  - every `{{$secret}}` value;
  - every value of a variable whose name looks like a credential, from any source: file variable, environment, `$shared`, `.env` key or process environment name.

  A name looks like a credential when, lowercased with `-`, `_`, `.` and spaces removed, it contains `token`, `bearer`, `apikey`, `secret` or `password` (FR-A4). Sensitive values are masked as `••••••` wherever Streamscope writes text: the Headers document, the CodeLens outcome, the log, notifications, problem messages and hovers. Response bodies and saved files are never masked (design section 15).

- **Workspace Trust** (design section 15). The manifest declares:

  ```json
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited",
      "restrictedConfigurations": ["streamscope.request.caFile"]
    },
    "virtualWorkspaces": { "supported": "limited" }
  }
  ```

  Both entries also carry descriptions. In a restricted workspace:
  - `$secret`, `$dotenv` and `$processEnv` block the request with an explanation.
  - `http-client.private.env.json` is not read.
  - Body files block the request.
  - `# @insecure` and `streamscope.insecure` are ignored.
  - Sending a request that would otherwise go out asks once per session.

- **Commands** (category `Streamscope`):
  - `streamscope.selectEnvironment`;
  - `streamscope.setSecret(name?: string, value?: string)`;
  - `streamscope.clearSecret(name?: string)`;
  - `streamscope.listSecrets(): Promise<string[]>`;
  - `streamscope.moveToSecretStorage(uri: Uri, line: number)`, hidden from the command palette.
- **Process.**
  - No code comments, no new dependencies, TDD for all code.
  - Work happens on branch `m3-environments` from `main`, one commit per task. Push and pull request only with the user's go-ahead.
  - Synthetic data only: `*.example.test`, `*.streamscope.test`, `localhost`, values like `synthetic-token`.

## Decisions this plan makes (builder's call, approval of this plan approves them)

1. **Missing `$processEnv` and `$dotenv` values block the send.** REST Client sends an empty string for an unset process variable and only warns for a missing `.env` key. Sending an empty credential is the anti-goal, as M2's strict system variables argued.
2. **The `.env` search stops at the workspace folder.** REST Client walks up to the filesystem root, which could read a `.env` from a parent folder the user never opened.
3. **`$shared` is also accepted inside `http-client*.env.json`.** This is Visual Studio's convention for the same file; JetBrains has no shared environment yet. Without an active environment, only `$shared` applies, as in REST Client.
4. **Sensitive values are masked by value, not only by header name.** Masking replaces every occurrence of each sensitive value, longest first, in all text Streamscope writes. A credential-like name can over-mask (for example `tokenUrl`). That is the safe failure.
5. **The restricted-mode confirmation comes after the request validates, just before connecting.**
   - A request that would be blocked anyway never asks.
   - Declining cancels the run.
   - The answer is remembered until the window reloads.
   - `startRun` takes the confirmation as an injected function, so the rule is unit-tested.
6. **The secret names index lives in `workspaceState`.** VS Code 1.101's `SecretStorage` cannot list keys.
7. **Unresolved-variable diagnostics are warnings.** The value may come from an environment that is not selected yet, and sending still blocks on any missing value. Malformed system variables are errors.
8. **Restricted-mode integration tests use their own launcher.** `@vscode/test-electron`'s `runTests` always passes `--disable-workspace-trust`. `scripts/run-restricted-tests.mjs` spawns VS Code itself, with a seeded user profile and a fresh fixture folder, like `scripts/verify-vsix.mjs`.

## Review Focus

- **A sensitive value appearing in text Streamscope writes:** Headers document, CodeLens outcome, log, error notification, hover, or a problem message that quotes the URL.
  - Tasks 1, 6, 10 and 11: tests.
- **A restricted workspace reading or applying anything design section 15 forbids:** secrets, `.env`, private environment file, process environment, body files, `# @insecure`, `streamscope.insecure`, or a workspace-level `caFile`.
  - Tasks 5, 6 and 12: tests.
- **Wrong precedence:** an environment shadowing a file variable, the shared file beating the private file, `$shared` beating the active environment, or `%` indirection reading the wrong source.
  - Tasks 2 and 4: tests.
- **An empty value sent:** unset process variable, missing `.env` key, a cancelled or empty secret prompt.
  - Tasks 5 and 10: tests.
- **Stale environment state:** editing an environment file or switching environments must change the next send, the hover and the diagnostics without a reload.
  - Tasks 8 and 11: tests.

---

### Task 1: Credential names and value masking

**Files:**

- Modify: `src/masking/masking.ts`
- Test: `test/unit/masking/masking.test.ts`

**Interfaces:**

- Produces:
  - `export function looksLikeCredential(name: string): boolean`;
  - `export function maskValues(text: string, values: readonly string[]): string`. It replaces every occurrence of every non-empty value with `maskedValue`, longest first, so a value that contains another is masked whole.

- [ ] **Step 1: Failing tests:**
  - `recognises credential names in any casing and separator style`:
    - true for `token`, `accessToken`, `ACCESS_TOKEN`, `api-key`, `apiKey`, `clientSecret`, `db.password`, `Bearer`;
    - false for `host`, `baseUrl`, `userId`, `keyboard`.
  - `masks every occurrence of every value, longest first`: `maskValues('a=synthetic-token-2;b=synthetic-token', ['synthetic-token', 'synthetic-token-2'])` gives `'a=••••••;b=••••••'`.
  - `ignores empty values`: `maskValues('abc', [''])` gives `'abc'`.
- [ ] **Step 2: Run** `npx vitest run test/unit/masking` — Expected: FAIL.
- [ ] **Step 3: Implement** both functions. `maskValues` uses `split(value).join(maskedValue)` per value, with no regex built from the value.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Recognise credential names and mask values"`.

### Task 2: Environment sources and the catalog

**Files:**

- Create: `src/environments/model.ts`, `src/environments/parse.ts`, `src/environments/catalog.ts`
- Test: `test/unit/environments/parse.test.ts`, `test/unit/environments/catalog.test.ts`

**Interfaces:**

- Produces:

```ts
export type EnvironmentOrigin =
  { kind: 'settings' } | { kind: 'file'; path: string } | { kind: 'private-file'; path: string };
export interface EnvironmentLayer {
  origin: EnvironmentOrigin;
  environments: ReadonlyMap<string, ReadonlyMap<string, string>>;
  insecure: ReadonlySet<string>;
}
export interface SourcedValue {
  value: string;
  origin: string;
}
export interface EnvironmentCatalog {
  names: string[];
  active: string | undefined;
  variables: ReadonlyMap<string, SourcedValue>;
  shared: ReadonlyMap<string, SourcedValue>;
  insecure: boolean;
}
export function parseSettingsEnvironments(value: unknown): EnvironmentLayer;
export function parseEnvironmentFile(
  text: string,
  origin: EnvironmentOrigin,
): { ok: true; layer: EnvironmentLayer } | { ok: false; message: string };
export function environmentCatalog(
  layers: readonly EnvironmentLayer[],
  active: string | undefined,
): EnvironmentCatalog;
export function originLabel(origin: EnvironmentOrigin, environment: string): string;
```

- Layers are passed lowest first: settings, file, private file.
- `names` is every environment name except `$shared`, sorted, without duplicates.
- An `active` name that no layer defines gives empty `variables`.
- `originLabel` gives labels such as:
  - `dev environment (settings)`;
  - `dev environment (http-client.env.json)`;
  - `$shared (http-client.private.env.json)`.

- [ ] **Step 1: Failing tests:**
  - **`parse.test.ts`:**
    - `reads REST Client environments including $shared`.
    - `reads an environment file and stringifies numbers and booleans`: `{"dev":{"port":8080,"debug":true}}` gives `'8080'` and `'true'`.
    - `skips objects, arrays and null values`.
    - `marks environments that set streamscope.insecure to true`: the key does not become a variable, and `"streamscope.insecure": "true"` (a string) does not count.
    - `reports invalid JSON with the file name`: the message contains `http-client.env.json`.
    - `treats a settings value that is not an object as no environments`.
  - **`catalog.test.ts`:**
    - `lets the private file win over the public file, and both over settings`.
    - `falls back to $shared for names the active environment lacks`.
    - `uses only $shared when no environment is active`.
    - `lists environment names from every layer without $shared`.
    - `labels each value with its environment and origin`.
- [ ] **Step 2: Run** `npx vitest run test/unit/environments` — Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Read REST Client and JetBrains environments into one catalog"`.

### Task 3: `.env` parsing and lookup order

**Files:**

- Create: `src/environments/dotenv.ts`
- Test: `test/unit/environments/dotenv.test.ts`

**Interfaces:**

- Produces:
  - `export function parseDotenv(text: string): ReadonlyMap<string, string>`;
  - `export function dotenvCandidates(documentDir: string, containmentRoot: string, environment: string | undefined): string[]`.
- `dotenvCandidates` lists, for each folder from `documentDir` up to and including `containmentRoot`, `.env.<environment>` (when an environment is active) and then `.env`. It never goes above `containmentRoot`.

- [ ] **Step 1: Failing tests:**
  - `parses KEY=value lines, export prefixes and comments`.
  - `keeps # inside quotes and strips it after unquoted values`.
  - `unescapes \n in double-quoted values and keeps single-quoted values literal`.
  - `ignores lines without =`.
  - `lists .env.<environment> before .env in each folder up to the root`: `('/w/a/b', '/w', 'dev')` gives `['/w/a/b/.env.dev', '/w/a/b/.env', '/w/a/.env.dev', '/w/a/.env', '/w/.env.dev', '/w/.env']`, built with `path.join`.
  - `stops at the containment root`.
- [ ] **Step 2: Run** `npx vitest run test/unit/environments/dotenv.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Parse .env files and order their lookup"`.

### Task 4: Variable sources, precedence and sensitive values

**Files:**

- Create: `src/variables/sources.ts`, `test/unit/variables/sources.ts` (test helper `testSources(overrides?: Partial<VariableSources>): VariableSources`)
- Modify: `src/variables/resolve.ts`, `test/unit/variables/resolve.test.ts`, `src/runs/run.ts` (passes sources)
- Test: `test/unit/variables/resolve.test.ts`

**Interfaces:**

- Consumes: `SourcedValue` (Task 2), `looksLikeCredential` (Task 1).
- Produces:

```ts
export type DotenvState =
  | { kind: 'loaded'; values: ReadonlyMap<string, string>; path: string }
  | { kind: 'missing' }
  | { kind: 'restricted' };
export interface VariableSources {
  system: SystemContext;
  restricted: boolean;
  environmentName: string | undefined;
  environment: ReadonlyMap<string, SourcedValue>;
  shared: ReadonlyMap<string, SourcedValue>;
  secrets: ReadonlyMap<string, string>;
  dotenv: DotenvState;
  processEnv: Readonly<Record<string, string | undefined>>;
  privateFileIgnored: boolean;
}
export function resolveRequest(
  file: HttpFile,
  request: HttpRequest,
  sources: VariableSources,
): Resolution;
```

- `Resolution`'s `ok: true` variant gains `sensitiveValues: string[]`.
- Environment and `$shared` values resolve like file variables: they may reference other variables and system variables, they are cached per send, and cycles are reported. A problem inside one is reported at the reference that used it, with the message naming the variable and its origin, for example: ``In `{{token}}` from dev environment (http-client.env.json): `{{$processEnv API_KEY}}` is not set.``
- The undefined-variable message names where it looked:
  - ``\`{{host}}\` is not defined in this file, the \`dev\` environment or \`$shared\`.``;
  - with no active environment: ``\`{{host}}\` is not defined in this file or \`$shared\` (no environment selected).``;
  - when `privateFileIgnored`, it adds ` A restricted workspace does not read http-client.private.env.json.`

- [ ] **Step 1: Failing tests** (update the existing ones to pass `testSources()`):
  - `prefers a file variable over the environment and the environment over $shared`.
  - `resolves environment values that reference other variables and $shared`: `{{$shared base}}` inside an environment value reads `$shared` even when the environment also defines `base`.
  - `reports a cycle across file and environment variables`.
  - `names the environment and $shared when a variable is undefined`, both with and without an active environment.
  - `reports values from credential-named variables and secrets as sensitive`: `@accessToken = synthetic-token` used in a header gives `sensitiveValues` `['synthetic-token']`, and `{{host}}` does not.
  - `adds the restricted-workspace hint for undefined variables when the private file was ignored`.
- [ ] **Step 2: Run** `npx vitest run test/unit/variables` — Expected: FAIL.
- [ ] **Step 3: Implement** `sources.ts` and extend `resolve.ts`. `run.ts` builds sources from its input (Task 6 adds the input fields; until then `startRun` passes empty maps, `restricted: false` and `dotenv: { kind: 'missing' }`).
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Resolve variables from environments with the documented precedence"`.

### Task 5: `$secret`, `$dotenv`, `$processEnv` and `$shared`

**Files:**

- Modify: `src/variables/system.ts` (drop `secret`, `dotenv` and `processEnv` from the "not supported yet" list), `src/variables/resolve.ts`
- Create: `src/variables/secrets.ts`
- Test: `test/unit/variables/sources.test.ts`

**Interfaces:**

- Consumes: `VariableSources` (Task 4).
- Produces: `export function referencedSecrets(file: HttpFile, request: HttpRequest, sources: VariableSources): string[]`. It lists the secret names the request needs, including those reached through file and environment variables, in first-use order, without duplicates.
- Messages:
  - ``\`{{$secret apiToken}}\` has no stored value.``
  - ``\`{{$processEnv API_KEY}}\`: API_KEY is not set in VS Code's environment.``
  - ``\`{{$dotenv API_KEY}}\`: no .env file was found next to the .http file or above it in the workspace.``
  - ``\`{{$dotenv API_KEY}}\`: API_KEY is not in <path>.``
  - ``\`{{$shared base}}\` is not defined in \`$shared\`.``
  - In a restricted workspace: ``\`{{$secret apiToken}}\` is not available in a restricted workspace. Trust the workspace to use it.`` The same applies to `$dotenv` and `$processEnv`.
  - A malformed argument: the M2 "expected format" message, with formats `$secret <name>`, `$dotenv [%]<name>`, `$processEnv [%]<name>` and `$shared <name>`.

- [ ] **Step 1: Failing tests:**
  - `resolves $secret from the provided secrets and marks it sensitive`.
  - `blocks a $secret with no stored value`.
  - `resolves $processEnv and its % indirection through the environment`: `{{$processEnv %keyName}}` with environment `keyName = API_KEY` reads `processEnv.API_KEY`.
  - `blocks an unset process variable instead of sending an empty value`.
  - `resolves $dotenv, with %, from the loaded file`.
  - `blocks $dotenv when no file was found or the key is missing`.
  - `blocks $secret, $dotenv and $processEnv in a restricted workspace`.
  - `lists the secrets a request needs through file and environment variables`.
  - `keeps $aadToken unsupported`.
- [ ] **Step 2: Run** `npx vitest run test/unit/variables` — Expected: FAIL.
- [ ] **Step 3: Implement.** Values from `$dotenv` and `$processEnv` are sensitive when their name looks like a credential.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Resolve secrets, .env values and process variables"`.

### Task 6: Runs: sources, trust, environment TLS opt-out, confirmation and masking

**Files:**

- Create: `src/runs/confirm-once.ts`
- Modify:
  - `src/runs/run.ts`, `src/runs/build-request.ts`, `src/runs/body-files.ts`;
  - `src/response/headers-document.ts`, `src/response/labels.ts`;
  - `test/unit/runs/support.ts`.
- Test: `test/unit/runs/run.test.ts`, `test/unit/runs/build-request.test.ts`, `test/unit/runs/confirm-once.test.ts`, `test/unit/response/headers-document.test.ts`, `test/unit/response/labels.test.ts`

**Interfaces:**

- Consumes: Tasks 4 and 5.
- Produces:
  - `RunInput` gains:
    - `variables: Omit<VariableSources, 'system' | 'restricted'>`;
    - `restricted: boolean`;
    - `confirmSend: (() => Promise<boolean>) | undefined`.
  - `RequestSettings` gains `insecureEnvironment: boolean`.
  - `BodyFileContext` gains `restricted: boolean`.
  - `RunSnapshot` gains `sensitiveValues: readonly string[]`.
  - `export function confirmOnce(ask: () => Promise<boolean>): () => Promise<boolean>` remembers a `true` answer and asks again after `false`.
- Rules:
  - `rejectUnauthorized` is `false` only when the workspace is not restricted and either `# @insecure` or `insecureEnvironment` applies.
  - A restricted body file is the problem `Body files are not read in a restricted workspace. Trust the workspace to send them.` at its path.
  - `confirmSend` runs after the request is built and before the transport. A `false` answer ends the run `cancelled` without connecting.
  - `renderHeadersDocument` and `describeOutcome` pass their whole output through `maskValues(…, run.sensitiveValues)`.

- [ ] **Step 1: Failing tests:**
  - `turns off TLS verification for an insecure environment only when trusted`.
  - `ignores # @insecure in a restricted workspace`.
  - `blocks body files in a restricted workspace`.
  - `asks before sending and cancels without connecting when declined`: the server sees 0 sockets.
  - `confirmOnce remembers yes and asks again after no`.
  - `masks sensitive values in the Headers document, including inside other header values and the URL`.
  - `masks sensitive values in the outcome text`.
- [ ] **Step 2: Run** `npx vitest run test/unit/runs test/unit/response` — Expected: FAIL.
- [ ] **Step 3: Implement.** Update `test/unit/runs/support.ts` defaults (empty sources, `restricted: false`, `confirmSend: undefined`, `insecureEnvironment: false`).
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Carry sources and trust into runs and mask sensitive values"`.

### Task 7: Describing references for hovers, completion and diagnostics

**Files:**

- Create: `src/variables/inspect.ts`
- Modify: `src/http-file/model.ts` (`DiagnosticCode` gains `'undefined-variable'` and `'invalid-variable'`)
- Test: `test/unit/variables/inspect.test.ts`

**Interfaces:**

- Consumes: `VariableSources` (Task 4).
- Produces:

```ts
export type ReferenceDescription =
  | { kind: 'value'; value: string; origin: string; sensitive: boolean }
  | { kind: 'secret'; name: string; stored: boolean }
  | { kind: 'generated'; description: string }
  | { kind: 'problem'; message: string };
export function describeReference(
  file: HttpFile,
  expression: string,
  sources: VariableSources,
): ReferenceDescription;
export function variableDiagnostics(file: HttpFile, sources: VariableSources): ParseDiagnostic[];
export interface VariableCompletion {
  label: string;
  detail: string;
}
export function variableCompletions(file: HttpFile, sources: VariableSources): VariableCompletion[];
export function secretCandidates(file: HttpFile): FileVariable[];
```

- `describeReference`:
  - never evaluates `$guid`, `$timestamp`, `$datetime`, `$localDatetime` or `$randomInt`; each is `generated`, with one sentence saying what is generated at send time;
  - `$secret` is `secret` with `stored` read from `sources.secrets`;
  - a sensitive value keeps `sensitive: true`, and the caller shows `••••••`.
- `variableDiagnostics` reports, in every request:
  - each undefined bare variable as a warning `undefined-variable`;
  - each malformed system variable as an error `invalid-variable`, at the reference.

  It does not check `$secret`, `$dotenv` or `$processEnv` values, or request references, which are resolved only at send time.

- `variableCompletions`:
  - lists file variables, then active environment variables, then `$shared` variables, without duplicates;
  - then lists `$guid`, `$timestamp`, `$datetime`, `$localDatetime`, `$randomInt`, `$processEnv`, `$dotenv`, `$secret` and `$shared`;
  - `detail` is the origin label or the system variable's format.
- `secretCandidates` gives file variables whose name looks like a credential and whose value is non-empty and contains no `{{` (FR-A4).

- [ ] **Step 1: Failing tests:** one `it` per bullet above, plus `describes a file variable with its origin` and `describes an environment value with its environment and file`.
- [ ] **Step 2: Run** `npx vitest run test/unit/variables/inspect.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `inspect.ts` on top of the resolver (no second resolution algorithm).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Describe variable references for hovers, completion and diagnostics"`.

### Task 8: Environment store and picker in VS Code

**Files:**

- Create: `src/vscode/environments/environment-store.ts`, `src/vscode/environments/picker.ts`
- Modify: `src/extension.ts`, `package.json` (command `streamscope.selectEnvironment`), `test/unit/manifest.test.ts`
- Test: `test/integration/environments.test.ts`

**Interfaces:**

- Consumes: Task 2.
- Produces:

```ts
export class EnvironmentStore implements vscode.Disposable {
  constructor(context: vscode.ExtensionContext);
  readonly onDidChange: vscode.Event<void>;
  active(): string | undefined;
  setActive(name: string | undefined): Promise<void>;
  catalogFor(
    document: vscode.Uri,
  ): Promise<{ catalog: EnvironmentCatalog; privateFileIgnored: boolean }>;
}
```

- The active environment is kept in `workspaceState` under `streamscope.activeEnvironment`.
- Files are read with `workspace.fs` and cached per URI. The cache is invalidated when `workspace.fs.stat` reports a different `mtime`.
- `onDidChange` fires when:
  - `rest-client.environmentVariables` changes;
  - a watched `**/http-client{,.private}.env.json` changes;
  - the active environment changes;
  - trust is granted.
- An invalid file is treated as empty. The store logs a warning and shows one notification per file version.
- The private file is skipped when `!vscode.workspace.isTrusted`.
- The status bar item (id `streamscope.environment`, left, priority 100):
  - shows `$(server-environment) <name>` or `$(server-environment) No Environment`;
  - is visible while an `http` editor is active;
  - runs `streamscope.selectEnvironment`, a quick pick of the active document's environment names plus `No Environment`.

- [ ] **Step 1: Failing tests:**
  - **`manifest.test.ts`:** the command list gains `streamscope.selectEnvironment`.
  - **`environments.test.ts`** (temp folder with `.http` and env files):
    - `uses the environment selected for the workspace`.
    - `lets the private file override the public file`.
    - `picks up an edited environment file on the next send`.
    - `reads REST Client environments from settings`: the test sets `rest-client.environmentVariables` at `ConfigurationTarget.Global` and restores it.
    - `selectEnvironment(name)` accepts the name as an argument, so tests skip the quick pick.
- [ ] **Step 2: Run** `npx vitest run test/unit/manifest.test.ts`, then `npm run test:integration -- --label stable`. Expected: FAIL.
- [ ] **Step 3: Implement** the store, the picker and the command wiring.
- [ ] **Step 4: Run** `npm run check && npm run test:integration` — Expected: PASS on stable and 1.101.0.
- [ ] **Step 5: Commit** — `git commit -m "Choose environments from settings and env files"`.

### Task 9: Secret store and commands

**Files:**

- Create: `src/secrets/keys.ts`, `src/vscode/secrets/secret-store.ts`, `src/vscode/secrets/commands.ts`
- Modify: `src/extension.ts`, `package.json` (commands `setSecret`, `clearSecret`, `listSecrets`), `test/unit/manifest.test.ts`
- Test: `test/unit/secrets/keys.test.ts`, `test/integration/secrets.test.ts`

**Interfaces:**

- Produces:
  - `export function workspaceHash(identity: string): string`, giving 16 lowercase hex characters;
  - `export function secretKey(hash: string, name: string): string`, giving `streamscope:<hash>:<name>`.

```ts
export class SecretStore {
  constructor(secrets: vscode.SecretStorage, state: vscode.Memento, identity: string);
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  clear(name: string): Promise<void>;
  names(): string[];
}
```

- Commands:
  - `setSecret(name?, value?)` asks for whatever is missing:
    - the name with `showInputBox`;
    - the value with `showInputBox({ password: true, ignoreFocusOut: true })`.

    An empty value is rejected by `validateInput`.

  - `clearSecret(name?)` picks from `names()`.
  - `listSecrets()` shows a quick pick of names (selecting one offers Set New Value and Clear) and returns the names.
- Notifications name the secret, never its value.

- [ ] **Step 1: Failing tests:**
  - **`keys.test.ts`:**
    - `hashes the workspace identity to 16 hex characters`.
    - `builds the documented key`.
  - **`secrets.test.ts`:**
    - `stores, lists and clears a secret through the commands`.
    - `never shows the value in the list`: `listSecrets` returns names only.
- [ ] **Step 2: Run** the unit test, then `npm run test:integration -- --label stable`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check && npm run test:integration` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Store secrets per workspace with Set, Clear and List commands"`.

### Task 10: Sending with environments, secrets, `.env` and trust

**Files:**

- Create: `src/vscode/requests/variables.ts` (`variablesFor(document, request, file): Promise<RunVariables | undefined>`)
- Modify: `src/vscode/requests/register.ts`, `src/vscode/requests/settings.ts`, `src/vscode/log.ts`
- Test: `test/integration/send.test.ts`, `test/integration/variables.test.ts`

**Interfaces:**

- Consumes: Tasks 3 to 9.
- Produces: `type RunVariables = RunInput['variables']`.
- `variablesFor`:
  1. Builds the catalog for the document.
  2. Asks for each secret from `referencedSecrets` that has no stored value, once. It stores the answer, and returns `undefined` when a prompt is cancelled, so nothing is sent.
  3. Reads the first existing `dotenvCandidates` file when trusted.
  4. Passes `process.env`, or `{}` when restricted.
- Every send also:
  - passes `insecureEnvironment` from the catalog;
  - passes `restricted: !workspace.isTrusted`;
  - passes a session-wide `confirmOnce` around a modal `showWarningMessage('Send requests from this restricted workspace?', { modal: true, detail }, 'Send')`.
- The log masks `sensitiveValues` in every line about a run.

- [ ] **Step 1: Failing tests** (`variables.test.ts`, in a temp folder):
  - `sends a value from the selected environment`.
  - `sends a stored secret and masks it in the Headers view and the log-free outcome`: the secret is stored with `streamscope.setSecret(name, value)`.
  - `sends a .env value found next to the file`.
  - `sends a process variable`: the test sets `process.env.STREAMSCOPE_TEST_VALUE` in the extension host and deletes it afterwards.
  - `does not send when a process variable is unset`: the lens starts with `Not sent`.
- [ ] **Step 2: Run** `npm run test:integration -- --label stable` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check && npm run test:integration` — Expected: PASS on stable and 1.101.0.
- [ ] **Step 5: Commit** — `git commit -m "Send with environments, secrets, .env and process variables"`.

### Task 11: Hovers, completion, unresolved-variable diagnostics and "Move to secret storage"

**Files:**

- Create: `src/vscode/language/variables.ts` (hover, completion and code action providers)
- Modify: `src/vscode/language/register.ts` (diagnostics include `variableDiagnostics` and refresh on `EnvironmentStore.onDidChange`), `package.json` (hidden command `streamscope.moveToSecretStorage`), `test/unit/manifest.test.ts`
- Test: `test/integration/language.test.ts`

**Interfaces:**

- Consumes: Tasks 7 to 9.
- Hover on a `{{…}}` range shows Markdown:
  - **a value:** `` `{{host}}` = `api.example.test` `` and then its origin on the next line;
  - **a secret:** `` `{{$secret apiToken}}`: stored in secret storage `` or `` `{{$secret apiToken}}`: not set; Streamscope asks for it when you send ``;
  - **a sensitive value:** `••••••` in place of the value;
  - **a problem:** the problem message.
- Completion triggers on `{` after `{{` and on `@` after `# `. Directive completions are `directiveKinds`.
- The code action (kind `QuickFix`, title `Move to secret storage`) appears on file variables from `secretCandidates`. Its command:
  1. stores the value under the variable name;
  2. replaces the value range with `{{$secret <name>}}` through a `WorkspaceEdit`.

- [ ] **Step 1: Failing tests:**
  - `shows the resolved value and its source on hover`.
  - `masks a credential-named value on hover`.
  - `completes file and environment variables and system variables after {{`.
  - `completes directives after # @`.
  - `warns about an undefined variable and clears the warning when an environment defines it`.
  - `moves a literal credential into secret storage`: the line becomes `@apiToken = {{$secret apiToken}}`, and `listSecrets` includes `apiToken`.
- [ ] **Step 2: Run** `npm run test:integration -- --label stable` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check && npm run test:integration` — Expected: PASS on stable and 1.101.0.
- [ ] **Step 5: Commit** — `git commit -m "Hover, complete and check variables, and move literal credentials into secret storage"`.

### Task 12: Workspace Trust declarations and restricted-mode tests

**Files:**

- Create:
  - `scripts/run-restricted-tests.mjs`;
  - `test/restricted/index.ts` (exports `run(): Promise<void>`) and `test/restricted/tsconfig.json`;
  - `test/fixtures/restricted/` (`.vscode/settings.json` setting `streamscope.request.caFile`, `requests.http`, `http-client.private.env.json`, `.env`, `payload.json`).
- Modify:
  - `package.json` (`capabilities`, script `test:restricted`, `compile:host-tests` also compiles `test/restricted`);
  - `test/unit/manifest.test.ts`;
  - `.github/workflows/ci.yml` (a `Restricted workspace tests` step after the integration tests, under `xvfb-run -a` on Linux);
  - `eslint.config.mjs` only if the new tsconfig needs it.

**Interfaces:**

- The launcher:
  1. Copies the fixture into a fresh temp folder.
  2. Seeds `<temp>/user-data/User/settings.json` with `{"security.workspace.trust.startupPrompt": "never", "security.workspace.trust.banner": "never"}`.
  3. Spawns the VS Code from `downloadAndUnzipVSCode('stable')` with:
     - `--no-sandbox`, `--disable-gpu-sandbox`, `--disable-updates`, `--skip-welcome`, `--skip-release-notes`;
     - `--user-data-dir`, `--extensions-dir`;
     - `--extensionDevelopmentPath=<root>`;
     - `--extensionTestsPath=<root>/out/restricted/index.js`;
     - the temp folder.

     It does not pass `--disable-workspace-trust`.

  4. Exits with VS Code's exit code and removes the temp folder.
- `run()` checks with `node:assert`:
  1. `vscode.workspace.isTrusted` is `false`.
  2. A request using `{{$secret …}}`, `{{$dotenv …}}`, `{{$processEnv …}}`, a private-file variable or `< ./payload.json` ends `blocked` with the restricted-workspace message, and its local server records 0 sockets. Each is read through the CodeLens outcome after `streamscope.sendRequest`.
  3. `getConfiguration('streamscope.request').get('caFile')` is `''` although the fixture's workspace setting names a file.

- [ ] **Step 1: Failing tests:**
  - **`manifest.test.ts`:** `declares limited support for restricted and virtual workspaces`. It checks the exact `capabilities` object from Global Constraints (descriptions as non-empty strings) and the `test:restricted` script.
  - **`test/restricted/index.ts`:** the three checks.
- [ ] **Step 2: Run** `npx vitest run test/unit/manifest.test.ts`, then `npm run test:restricted`. Expected: FAIL. Before the manifest change, VS Code keeps the extension disabled in the restricted folder, so `run()` fails at the first command.
- [ ] **Step 3: Implement** the manifest change, the launcher and the fixture.
- [ ] **Step 4: Verify** — Run: `npm run check && npm run test:integration && npm run test:restricted && npm run verify:vsix`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Support restricted and virtual workspaces with limited features"`.

### Task 13: Documentation

**Files:**

- Modify: `README.md` (Environments and secrets), `CHANGELOG.md` (Unreleased), `CLAUDE.md` (layout rows for `src/environments`, `src/secrets` and `test/restricted`; the `npm run test:restricted` command; Verification), `docs/design.md` (sections 10 and 15 for decisions 1 to 5 and 8)
- Test: `npm run format:check`

- [ ] **Step 1: Update** the four files: README, CHANGELOG, CLAUDE.md and design.md.
- [ ] **Step 2: Run** `npm run check` — Expected: PASS.
- [ ] **Step 3: Commit** — `git commit -m "Document environments, secrets and restricted workspaces"`.

### After the last task

1. A fresh whole-branch review on the most capable model, with this plan's Review Focus.
2. `vscode-api-verifier` and `extension-security-reviewer` run alongside it, told to use Bash, not terminal tools.
3. One fix pass covering all three reviews.
4. Push `m3-environments` and open the pull request, only with the user's go-ahead.
