# Streamscope

Send requests from `.http` files and watch streaming responses arrive event by event: NDJSON, Server-Sent Events, chunked bodies and LLM streams, even when the server labels NDJSON as `application/json`. Capture values from any single event, such as a `threadId` from a `RUN_STARTED` event, and reuse them in later requests.

![A streaming response in Streamscope: events arrive live in the Events view while the editor shows the request with its capture and checks](https://raw.githubusercontent.com/achrafelkhnissi/streamscope/main/images/live-stream.gif)

Streamscope reads the same request syntax as REST Client, so existing `.http` files work.

## Quick start

1. Install Streamscope and open or create a file ending in `.http` or `.rest`.
2. Write a request:

   ```http
   ### Start agent run
   # @name startRun
   POST https://agent.example.test/run
   Content-Type: application/json

   {"message": "hello"}
   ```

3. Put the cursor in it and press `Cmd+Alt+Enter` (`Ctrl+Alt+Enter` on Windows and Linux), or click **Send Request** above it.

The response opens beside the editor. A stream shows each event as it arrives, and **Stop** above the request or in the panel cancels it.

## Responses

Each request has one response panel, which a new run of the request replaces. Its views:

- **Events:** one row per event while the stream runs. Expand a row to see the event, open it in the editor with **Open Event in Editor**, or click a value and press **Capture This Value…**.
- **Reply:** the text assembled from an LLM stream's deltas, for AG-UI, OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Ollama streams.
- **Raw:** the response text exactly as received.
- **Headers:** the status line and response headers, the request as sent with credentials masked, each redirect and the timing.
- **Body:** a normal response's body, with JSON indented and numbers and duplicate keys kept as received.
- **Checks:** the result of each `# @expect` line.

Streamscope detects NDJSON and Server-Sent Events from the bytes, not only from `Content-Type`, and never adds an `Accept` header you did not write. Besides what HTTP needs (`Host`, `Content-Length`, `Connection`), it adds only `Accept-Encoding` when you did not set one, and `Authorization` when the URL holds user info. A long stream keeps its newest events in memory and older ones on disk, so it can run for hours. **Streamscope: Save Response** saves the body as received, after decompression, and **Streamscope: Show History** lists the session's last 50 runs.

## Request syntax

Requests are separated by `###` lines. File variables (`@name = value`) and the system variables `{{$guid}}`, `{{$timestamp}}`, `{{$datetime}}`, `{{$localDatetime}}` and `{{$randomInt}}` work as in REST Client. A request that refers to a value Streamscope cannot resolve is never sent: the message names the variable and its line. A body can come from a file in the workspace with `< path` or `<@ path`.

Streamscope's directives go on comment lines before the request line:

| Directive                         | Effect                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `# @name startRun`                | Names the request, so other requests can read its captures and response                                         |
| `# @capture threadId = …`         | Takes a value from the response or from one event (see Captures)                                                |
| `# @expect status == 200`         | States what the response must satisfy (see Checks)                                                              |
| `# @until type == "RUN_FINISHED"` | Ends a stream at the first matching event, closes the connection and counts the request as completed            |
| `# @stream ndjson`                | Reads the response as `sse`, `ndjson`, `json`, `text` or `raw` instead of detecting its format (`auto` detects) |
| `# @timeout 30s`                  | Limits the request's total time                                                                                 |
| `# @no-redirect`                  | Returns a redirect response instead of following it                                                             |
| `# @insecure`                     | Skips TLS verification for this request only                                                                    |

Hover over `{{…}}` to see a value and where it comes from (secrets and credential-like values stay hidden). Completion offers variables after `{{` and directives after `# @`, and undefined variables get a warning.

## Captures

A `# @capture` line takes a value from a response, including from single events of a stream, for later requests:

```http
@baseUrl = https://agent.example.test

### Start agent run
# @name startRun
# @capture threadId = first(type == "RUN_STARTED").threadId
# @capture messageId = last(type == "RUN_FINISHED").result.messageId
# @capture secret sessionToken = headers["x-session-token"]
POST {{baseUrl}}/agent/run
Content-Type: application/json

{"message": "hello"}

### Continue
POST {{baseUrl}}/agent/continue
Content-Type: application/json

{"threadId": "{{startRun.threadId}}", "messageId": "{{messageId}}"}
```

- **When a value is ready.** `first(…)` and `nth(k, …)` resolve as soon as the matching event arrives, so a request can use `threadId` while the stream is still running. `last(…)`, `all(…)`, `count(…)` and `text` resolve when the stream ends; `status`, `headers` and `cookies` when the headers arrive; `body` and `jsonpath("$…")` when the body has arrived. A stream labelled `application/json` becomes NDJSON when its second line arrives, so a `first(…)` capture from its first line waits for that line; `# @stream ndjson` on the request reads it as NDJSON from the first line.
- **Capturing without typing.** Click a value in an expanded event or in the Body view and press **Capture This Value…**, or put the cursor on a value in an event or body opened in the editor and run **Streamscope: Capture This Value…**. Streamscope suggests a name, writes the line, such as `# @capture delta = nth(3, type == "TEXT_MESSAGE_CONTENT").delta`, on the request that produced the response, and selects it. Start the name with `secret ` to mask the value; a name or key that looks like a credential, such as `sessionId` or `auth`, gets `secret` on its own. The line takes effect the next time the request runs.
- **Reading a value.** `{{startRun.threadId}}` reads the capture of the request named `startRun`. `{{messageId}}` reads the newest capture with that name from a request in the same file that still has the `# @capture` line. A file variable, environment or `$shared` value of that name comes next, and a capture from another file only after them. So `@cursor = start` seeds a request that captures `cursor` itself: the first send uses `start`, later sends the captured value.
- **Waiting.** A request that needs a value still pending waits for it, up to `streamscope.capture.waitTimeout` (30 s), and its CodeLens shows "Waiting for startRun › threadId" beside **Stop**. If the producer has not run in this session and nothing else defines the name, the request is not sent, and the message offers to run it. Streamscope never sends a request you did not send.
- **Failures.** A capture that fails, such as an event that never arrived or a missing field, blocks the requests that need it, with the reason.
- **Seeing values.** After a run, the value or the reason it failed appears after each `# @capture` line, and the response panel lists the run's captured values.
- **Secrets.** A `secret` capture, a capture of a credential header such as `headers["x-session-token"]` or of a session cookie, and a capture whose name looks like a credential show as `••••••`. The response itself is shown as received.

Expressions also filter and reshape values: `body.items[?status == "ok"].id | join(",")`, `count(type == "TEXT_MESSAGE_CONTENT")`, `headers["location"] | match(/orders\/(\d+)/)`, `jsonpath("$.items[0].id")` and `body.next | default("none")`. REST Client's `{{login.response.body.$.token}}` and `{{login.response.headers.X-Token}}` work as well. The full syntax is in [section 10 of the design](docs/design.md#10-variable-extraction-and-resolution).

## Checks

A `# @expect` line states what a response must satisfy. It uses the capture language plus `exists(…)`, `count(…)`, `before(…)` and `unique(…)`:

```http
### Start agent run
# @name startRun
# @expect status == 200
# @expect exists(first(type == "RUN_STARTED"))
# @expect count(type == "TEXT_MESSAGE_CONTENT") > 2
# @expect before(type == "RUN_STARTED", type == "RUN_FINISHED")
# @expect !exists(first(type == "RUN_ERROR"))
POST {{baseUrl}}/agent/run
```

- **Live:** each check settles at the first event that decides it, while the stream is still running, and never changes afterwards. `count(…) > 2` passes at the third match; `!exists(first(type == "RUN_ERROR"))` fails at the first error. A failed check does not stop the stream or block captures.
- **Results:** the Checks view lists every check with its expected and actual values, such as `status == 201` got 500. The status line shows `4/5 checks`, the CodeLens shows `✓ 200 OK · 120 events · 4.3 s · 5/5 checks`, and a ✓ or ✗ appears after each `# @expect` line, with the detail on hover.
- **Secrets:** values in a check's detail are masked the same way capture failures are.

## File runs

Each `.http` and `.rest` file is a suite in VS Code's Testing view, and each request is a test with a run button in the gutter. Run a whole file from the Testing view or with **Streamscope: Run File**:

![A file run in the Testing view: the first request passes, the second cannot connect, and the third is skipped because it needs a value from the second](https://raw.githubusercontent.com/achrafelkhnissi/streamscope/main/images/file-run.gif)

```http
@baseUrl = https://api.example.test

### Start agent run
# @name startRun
# @capture threadId = first(type == "RUN_STARTED").threadId
# @expect status == 200
# @until type == "RUN_FINISHED"
POST {{baseUrl}}/agent/run

### Continue
# @name continue
# @timeout 30s
# @expect body.threadId == "synthetic-thread-1"
POST {{baseUrl}}/agent/continue
X-Thread: {{threadId}}
```

- **Order:** requests run in file order, one at a time, and each finishes, with its checks settled, before the next starts. The file's text when the run starts is used, saved or not.
- **Results:** a request passes when it gets a response and all its checks pass, whatever its HTTP status. A failed check is reported at its `# @expect` line, for example `` `status == 201` got 500 ``. A request that fails to connect, times out or cannot be sent is an error.
- **Skips:** a request that needs a capture from a request that failed, was not sent or was stopped in the same run is skipped, and the test output gives the reason. That carries down a chain of requests.
- **Stopping:** stopping the run cancels the request in progress; the rest stay not run.
- File runs open no response panels; a request whose panel is already open shows its new run there. The Testing view lists files in the workspace and untitled files, skips `node_modules`, and does not read a closed file that is itself a link or is over 1 MiB. File runs need a trusted workspace.

## Environments and secrets

Variables come from, in order: captures, file variables (`@name = value`), the active environment, then `$shared`.

- **Environments** are read from REST Client's `rest-client.environmentVariables` setting, and from `http-client.env.json` and `http-client.private.env.json` next to the `.http` file or at the root of its workspace folder. For the same name, the private file wins over the public file, which wins over the setting. `$shared` values apply to every environment.
- **Choose the environment** from the status bar or with **Streamscope: Select Environment**. The choice is remembered per workspace.
- **`{{$secret name}}`** asks for the value once, keeps it in VS Code's secret storage for this workspace, and hides it everywhere Streamscope writes. Use **Streamscope: Set Secret**, **Streamscope: Clear Secret** and **Streamscope: List Secrets** to manage values, or **Streamscope: Move to Secret Storage**, also offered as a quick fix on a line like `@apiToken = …`.
- **`{{$dotenv name}}`** reads `.env.<environment>` or `.env` next to the file, or in a parent folder up to the workspace folder.
- **`{{$processEnv name}}`** reads VS Code's own environment.
- Both accept `%name`, which first looks up the real name in the environment.
- A missing value never becomes an empty one: the request is not sent.
- An environment can set `"streamscope.insecure": true` to skip TLS verification for its requests.

## Settings

| Setting                                | Default                     | Description                                                                                |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `streamscope.request.connectTimeout`   | `30s`                       | How long to wait for the connection, including the TLS handshake                           |
| `streamscope.request.headersTimeout`   | `300s`                      | How long to wait for the response headers once connected                                   |
| `streamscope.request.followRedirects`  | `true`                      | Follow redirects; `# @no-redirect` turns it off for one request                            |
| `streamscope.request.maxRedirects`     | `10`                        | The most redirects to follow for one request                                               |
| `streamscope.request.caFile`           | `""`                        | A PEM file of extra certificate authorities to trust, added to the default and system ones |
| `streamscope.capture.waitTimeout`      | `30s`                       | How long a request waits for a captured value that has not arrived yet                     |
| `streamscope.stream.maxEventSize`      | `16MiB`                     | The largest single event to read; a larger one becomes an oversize event with a preview    |
| `streamscope.stream.memoryEvents`      | `10000`                     | How many of the newest events of a stream stay in memory; older ones are read from disk    |
| `streamscope.stream.maxSpillSize`      | `512MiB`                    | The most raw data kept on disk for one streaming response                                  |
| `streamscope.stream.maxTotalSpillSize` | `2GiB`                      | The most raw data kept on disk across all runs in the history                              |
| `streamscope.stream.typeFields`        | `["type","event","object"]` | The JSON fields whose value labels an event, tried in order                                |
| `streamscope.view.default`             | `events`                    | The view a streaming response opens on until you pick another one                          |
| `streamscope.codeLens.enabled`         | `true`                      | Show Send Request and the last outcome above each request                                  |

Durations accept `500ms`, `30s` or `5m`, and sizes `512KiB`, `16MiB` or `2GiB`.

## Commands

All commands are in the Command Palette under **Streamscope:**.

| Command                                          | What it does                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Streamscope: Send Request**                    | Sends the request under the cursor (`Cmd+Alt+Enter`, `Ctrl+Alt+Enter`)                 |
| **Streamscope: Stop Request**                    | Stops the request under the cursor                                                     |
| **Streamscope: Run File**                        | Runs every request of the file in the Testing view                                     |
| **Streamscope: Show Response**                   | Shows the response panel of the request under the cursor, or of a response document    |
| **Streamscope: Switch Response View…**           | Picks the panel's view: Events, Reply, Raw, Headers, Body or Checks                    |
| **Streamscope: Open Response Body in Editor**    | Opens the body in an editor, for large bodies                                          |
| **Streamscope: Open Response Headers in Editor** | Opens the Headers view as an editor document                                           |
| **Streamscope: Save Response**                   | Saves the body as received, after decompression                                        |
| **Streamscope: Capture This Value…**             | Writes a `# @capture` line for the value under the cursor in an event or body document |
| **Streamscope: Show History**                    | Lists the session's last 50 runs                                                       |
| **Streamscope: Select Environment**              | Picks the active environment                                                           |
| **Streamscope: Set Secret**                      | Stores a value for `{{$secret name}}`                                                  |
| **Streamscope: Clear Secret**                    | Removes a stored secret                                                                |
| **Streamscope: List Secrets**                    | Lists the names of stored secrets, never their values                                  |
| **Streamscope: Move to Secret Storage**          | Moves a file variable's value into secret storage                                      |
| **Streamscope: Show Log**                        | Opens Streamscope's output log                                                         |

## Using Streamscope with REST Client

Streamscope uses the same `http` language and reads REST Client's syntax, request references, system variables and `rest-client.environmentVariables`, so both extensions can open the same files. When REST Client or httpyac is installed, Streamscope offers once to turn off their Send link above each request, so only one shows. Streamscope's shortcut, `Cmd+Alt+Enter` (`Ctrl+Alt+Enter`), does not clash with REST Client's.

## Privacy

Streamscope sends no telemetry, needs no account, and makes no network requests except the ones you send. Responses stay on your machine: the newest events in memory, and every response body also in a private file (readable only by you) in Streamscope's storage folder, deleted when the run leaves the history, when VS Code closes, or at the next start after a crash. Secrets you enter stay in VS Code's secret storage.

## Security notes

- Credentials are masked wherever Streamscope describes a request or a captured value (the log, notifications, hovers, the Headers view's request, captured values, the Testing view, history and errors): `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, API-key headers, URL user info, `{{$secret …}}` values and `secret` captures. Response bodies, events and response headers are shown and saved as the server sent them.
- Redirects to another origin drop credential headers and any header that carries a secret, and a 307 or 308 redirect never resends a request body to another origin or from https to http.
- TLS verification is on unless you opt out for one request (`# @insecure`) or one environment.
- Body files must lie inside the workspace folder, and a captured value or response can never choose which file is sent.
- The response panel runs with a strict content security policy and shows response data as text only.

Report a vulnerability privately as described in [SECURITY.md](SECURITY.md).

## Restricted workspaces

In a workspace you have not trusted, Streamscope still colours, outlines and checks `.http` files. Before sending, it asks once per session. It never reads secrets, `.env` files, `http-client.private.env.json`, environments from your user settings, process variables or body files there, ignores `# @insecure` and environment TLS opt-outs, and does not run files from the Testing view. It uses only your own `streamscope.request.caFile` setting, and only when it is an absolute path. When you trust the workspace, the values captured and the responses received until then are no longer used by later requests, so run their requests again.

## Requirements

- VS Code 1.101 or later, on macOS, Windows or Linux, desktop only.

## Development

```sh
npm ci
npm run check
npm run test:integration
npm run package
```

Press F5 in VS Code to launch an Extension Development Host with the extension loaded. [docs/design.md](docs/design.md) describes the design and [docs/benchmarks.md](docs/benchmarks.md) the benchmarks, including how the recordings above are made (`npm run bench -- record`).
