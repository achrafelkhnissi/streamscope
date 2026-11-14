# Streamscope

A VS Code extension for sending requests from `.http` files and watching streaming responses (NDJSON, Server-Sent Events, chunked and LLM streams) arrive event by event.

This version sends requests, shows normal and streaming responses, and captures values from responses and streamed events for later requests.

## Sending requests

Put the cursor in a request and press `Cmd+Alt+Enter` (`Ctrl+Alt+Enter` on Windows and Linux), or click **Send Request** above it. The response opens beside the editor:

- **Body**: JSON is indented, keeping numbers and duplicate keys as received; other text is shown as received.
- **Headers** (**Streamscope: Show Response Headers**): the status line and response headers, the request as sent with credentials masked, each redirect and the timing.

While a request runs, **Stop** above it cancels it. **Streamscope: Save Response** saves the body as received, after decompression.

File variables (`@name = value`) and the system variables `{{$guid}}`, `{{$timestamp}}`, `{{$datetime}}`, `{{$localDatetime}}` and `{{$randomInt}}` work as in REST Client. A request that refers to a value Streamscope cannot resolve is not sent: the message names the variable and its line.

Request directives:

- `# @timeout 30s` limits the request's total time;
- `# @no-redirect` returns a redirect response instead of following it;
- `# @insecure` skips TLS verification for that request only.

Settings: `streamscope.request.connectTimeout`, `streamscope.request.headersTimeout`, `streamscope.request.followRedirects`, `streamscope.request.maxRedirects`, `streamscope.request.caFile` (extra certificate authorities to trust) and `streamscope.codeLens.enabled`.

## Environments and secrets

Variables come from, in order: captures (below), file variables (`@name = value`), the active environment, then `$shared`.

- **Environments** are read from REST Client's `rest-client.environmentVariables` setting, and from `http-client.env.json` and `http-client.private.env.json` next to the `.http` file or at the root of its workspace folder. For the same name, the private file wins over the public file, which wins over the setting. `$shared` values apply to every environment.
- **Choose the environment** from the status bar or with **Streamscope: Select Environment**. The choice is remembered per workspace.
- **`{{$secret name}}`** asks for the value once, keeps it in VS Code's secret storage for this workspace, and hides it everywhere Streamscope writes. Use **Set Secret**, **Clear Secret** and **List Secrets** to manage values, or the **Move to secret storage** quick fix on a line like `@apiToken = …`.
- **`{{$dotenv name}}`** reads `.env.<environment>` or `.env` next to the file, or in a parent folder up to the workspace folder.
- **`{{$processEnv name}}`** reads VS Code's own environment.
- Both accept `%name`, which first looks up the real name in the environment.
- A missing value never becomes an empty one: the request is not sent.
- An environment can set `"streamscope.insecure": true` to skip TLS verification for its requests.

Hover over `{{…}}` to see the value and where it comes from (secrets and credential-like values stay hidden). Completion offers variables after `{{` and directives after `# @`, and undefined variables get a warning.

## Captures

A `# @capture` line takes a value from a response, including from single events of a stream, for later requests:

```http
@baseUrl = https://agent.example.com

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

- **When a value is ready.** `first(…)` and `nth(k, …)` resolve as soon as the matching event arrives, so a request can use `threadId` while the stream is still running. `last(…)`, `all(…)`, `count(…)` and `text` resolve when the stream ends; `status`, `headers` and `cookies` when the headers arrive; `body` and `jsonpath("$…")` when the body has arrived.
- **Reading a value.** `{{startRun.threadId}}` reads the capture of the request named `startRun`. `{{messageId}}` reads the newest capture with that name from a request in the same file. A file variable, environment or `$shared` value of that name comes next, and a capture from another file only after them. So `@cursor = start` seeds a request that captures `cursor` itself: the first send uses `start`, later sends the captured value.
- **Waiting.** A request that needs a value still pending waits for it, up to `streamscope.capture.waitTimeout` (30 s), and its CodeLens shows "Waiting for startRun › threadId" beside **Stop**. If the producer has not run in this session and nothing else defines the name, the request is not sent, and the message offers to run it. Streamscope never sends a request you did not send.
- **Failures.** A capture that fails, such as an event that never arrived or a missing field, blocks the requests that need it, with the reason.
- **Seeing values.** After a run, the value or the reason it failed appears after each `# @capture` line, and the response view lists the run's captured values. Hovers and completion after `{{` know captures too.
- **Secrets.** A `secret` capture, a capture of a credential header such as `headers["x-session-token"]` or of a session cookie, and a capture whose name looks like a credential show as `••••••`. The response itself is shown as received.

Expressions also filter and reshape values: `body.items[?status == "ok"].id | join(",")`, `count(type == "TEXT_MESSAGE_CONTENT")`, `headers["location"] | match(/orders\/(\d+)/)`, `jsonpath("$.items[0].id")` and `body.next | default("none")`. REST Client's `{{login.response.body.$.token}}` and `{{login.response.headers.X-Token}}` work as well. The full syntax is in [section 10 of the design](docs/design.md#10-variable-extraction-and-resolution).

## Restricted workspaces

In a workspace you have not trusted, Streamscope still colours, outlines and checks `.http` files. Before sending, it asks once per session. It never reads secrets, `.env` files, `http-client.private.env.json`, environments from your user settings, process variables or body files there, and ignores `# @insecure` and environment TLS opt-outs. It uses only your own `streamscope.request.caFile` setting, and only when it is an absolute path.

## Requirements

- VS Code 1.101 or later

## Development

```sh
npm ci
npm run check
npm run test:integration
npm run package
```

Press F5 in VS Code to launch an Extension Development Host with the extension loaded.
