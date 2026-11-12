# Streamscope

A VS Code extension for sending requests from `.http` files and watching streaming responses (NDJSON, Server-Sent Events, chunked and LLM streams) arrive event by event.

This version sends requests and shows normal responses. Live streaming views and captures from streamed events come in later versions.

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

Streamscope stays disabled in restricted mode until you trust the workspace.

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
