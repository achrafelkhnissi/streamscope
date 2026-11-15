# Changelog

All notable changes to Streamscope are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions with an odd minor number, such as 0.1, are pre-releases.

## [0.1.0] - 2026-11-15

The first pre-release.

### Added

- **Requests:** `.http` and `.rest` files with REST Client's request syntax: syntax colouring, outline, folding and diagnostics. Send the request under the cursor with `Cmd+Alt+Enter` (`Ctrl+Alt+Enter` on Windows and Linux) or the **Send Request** CodeLens, and stop it while it runs.
- **Variables:** file variables, request references, the `$guid`, `$timestamp`, `$datetime`, `$localDatetime` and `$randomInt` system variables, `{{$dotenv}}` and `{{$processEnv}}`. A request with a value that cannot be resolved is never sent.
- **Environments:** `rest-client.environmentVariables`, `http-client.env.json` and `http-client.private.env.json`, with `$shared`, a status bar picker and **Select Environment**.
- **Secrets:** `{{$secret}}` values in VS Code's secret storage, with **Set Secret**, **Clear Secret**, **List Secrets** and **Move to Secret Storage**.
- **Transport:** gzip, deflate, br and zstd decompression, redirects, `# @timeout`, `# @no-redirect`, `# @insecure`, an extra CA file, and body files (`< path`, `<@ path`) inside the workspace.
- **Streaming:** NDJSON and Server-Sent Events detected from the bytes, chunked bodies, and LLM streams. `# @stream` sets the format when detection should not decide. Events are shown as they arrive, the newest in memory and older ones on disk, so a stream can run for hours.
- **Response panel:** Events, Reply (AG-UI, OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Ollama), Raw, Headers, Body and Checks views, live status, Stop, **Save Response**, **Show History** and Open in Editor for large bodies and events.
- **Captures:** `# @capture` takes values from a response or from single streamed events with an expression language (`first`, `nth`, `last`, `all`, `count`, filters, pipes, `jsonpath`), for later requests that wait up to 30 s for them. **Capture This Value…** writes the line from a clicked value.
- **Checks:** `# @expect` lines settle live, at the event that decides them, and show in the Checks view, the status line, the CodeLens and as ✓ / ✗ beside each line.
- **File runs:** each `.http` file is a suite in the Testing view. **Run File** runs its requests in order, reports passed, failed, errored and skipped requests, and `# @until` ends a stream at the first matching event.
- **Activation:** Streamscope starts when a workspace contains `.http` or `.rest` files, so the Testing view lists them; activation stays well under the 50 ms budget, also with hundreds of such files.
- **Documents on request:** a response's body, headers and events open as editor documents with **Open Response Body in Editor**, **Open Response Headers in Editor** and **Open Event in Editor**.
- **Security:** credentials are masked wherever Streamscope describes a request or a captured value: the log, notifications (including "Not sent"), hovers, captured values, the Testing view, history and errors. Decompression stops while its output is not read, so a response compressed many times over cannot fill memory. A 307 or 308 redirect to another origin never resends the request body, and redirects to another origin drop any header that carries a secret. **Run File** runs only files in the workspace, untitled ones or the one in the active editor, and the Testing view ignores files on other file systems and closed files that are links or over 1 MiB.
- A one-time offer to hide REST Client's and httpyac's Send links when they are installed.
- Restricted (untrusted) workspaces are supported with limited features.

[0.1.0]: https://github.com/achrafelkhnissi/streamscope/releases/tag/v0.1.0
