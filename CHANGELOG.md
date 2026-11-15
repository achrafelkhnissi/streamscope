# Changelog

All notable changes to Streamscope are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions with an odd minor number, such as 0.1, are pre-releases.

## [0.1.0] - 2026-11-15

The first pre-release.

### Added

- **Requests:** `.http` and `.rest` files in REST Client's request syntax, with syntax colouring, an outline, folding, diagnostics, hovers and completion. Send the request under the cursor with `Cmd+Alt+Enter` (`Ctrl+Alt+Enter` on Windows and Linux) or the **Send Request** CodeLens, and stop it while it runs.
- **Variables:** file variables, request references, the `$guid`, `$timestamp`, `$datetime`, `$localDatetime` and `$randomInt` system variables, `{{$dotenv}}` and `{{$processEnv}}`. A request with a value that cannot be resolved is never sent.
- **Environments:** `rest-client.environmentVariables`, `http-client.env.json` and `http-client.private.env.json`, with `$shared` values, a status bar picker and **Select Environment**.
- **Secrets:** `{{$secret name}}` asks for a value once and keeps it in VS Code's secret storage. **Set Secret**, **Clear Secret** and **List Secrets** manage the values, and a quick fix moves a credential-like file variable into secret storage.
- **Transport:** gzip, deflate, br and zstd decompression, redirects, `# @timeout`, `# @no-redirect`, an extra CA file, and body files (`< path`, `<@ path`) inside the workspace. TLS verification stays on unless a request (`# @insecure`) or an environment (`"streamscope.insecure": true`) turns it off.
- **Streaming:** NDJSON, Server-Sent Events, chunked bodies and LLM streams show event by event as data arrives. NDJSON and Server-Sent Events are detected from the bytes, not only from `Content-Type`, so NDJSON labelled `application/json` streams too, and `# @stream` sets the format when detection should not decide. `# @until` ends a stream at the first matching event. The newest events stay in memory and older ones on disk, so a stream can run for hours.
- **Response panel:** Events, Reply, Raw, Headers, Body and Checks views, a live status line, and buttons to stop the request, save the response and open the body or headers in an editor. Reply assembles the text of AG-UI, OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Ollama streams. **Show History** reopens any of the session's last 50 runs.
- **Documents on request:** **Open Response Body in Editor** and **Open Response Headers in Editor** open a response's body and headers as editor documents, handy for large content, and the panel's **Open Event in Editor** button does the same for one event.
- **Captures:** `# @capture` takes values from a response or from single streamed events with an expression language (`first`, `nth`, `last`, `all`, `count`, filters, pipes, `jsonpath`). A later request that needs a value still on its way waits for it, 30 s by default. After a run, each `# @capture` line shows its value or why it failed, and **Capture This Value…** writes the line for a value you pick in a response.
- **Checks:** `# @expect` lines settle live, at the event that decides them. Results show in the Checks view, the panel's status line and the CodeLens, and as ✓ or ✗ after each `# @expect` line.
- **File runs:** each `.http` or `.rest` file is a suite in the Testing view, with a test per request. **Run File** runs a file's requests one at a time, in order, and reports each as passed, failed, errored or skipped.
- **Security:**
  - Streamscope masks credentials everywhere it describes a request or a captured value, including the Headers view, the log, notifications, hovers, the Testing view, history and errors. It masks URL user info, credential headers in requests and responses (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie` and any header whose name contains a word such as `auth`, `token`, `key`, `secret`, `password`, `session` or `signature`), and the values of `{{$secret …}}`, `secret` captures and variables whose names contain `token`, `bearer`, `apikey`, `secret` or `password`, such as `apiToken` or `API_KEY`.
  - A 307 or 308 redirect to another origin never resends the request body, and redirects to another origin drop credential headers and any header that contains one of those values.
  - Credentials written in a URL query string are not masked, but a `{{$secret …}}` value there is. Response bodies, events and raw data are shown as the server sent them.
  - Decompression pauses until its output is read, so a small response that expands to gigabytes cannot fill memory.
  - **Run File** runs only files in the workspace, untitled files or the file in the active editor. The Testing view ignores files on other file systems, and closed files that are links or larger than 1 MiB.
- **REST Client and httpyac:** when either is installed, Streamscope offers once to turn off their Send link above each request, so only Streamscope's shows.
- **Restricted workspaces:** in a workspace you have not trusted, Streamscope still colours, outlines and checks `.http` files, and asks once per session before sending. It never reads secrets, `.env` files, `http-client.private.env.json`, environments from your user settings, process variables or body files there, and ignores TLS opt-outs. File runs need a trusted workspace.
- **Activation:** Streamscope starts when a workspace contains `.http` or `.rest` files, so the Testing view can list them. Starting takes only milliseconds, even with hundreds of such files.

[0.1.0]: https://github.com/achrafelkhnissi/streamscope/releases/tag/v0.1.0
