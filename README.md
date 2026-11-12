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

## Environments and secrets

Variables come from, in order: file variables (`@name = value`), the active environment, then `$shared`.

- **Environments** are read from REST Client's `rest-client.environmentVariables` setting, and from `http-client.env.json` and `http-client.private.env.json` next to the `.http` file or at the root of its workspace folder. For the same name, the private file wins over the public file, which wins over the setting. `$shared` values apply to every environment.
- **Choose the environment** from the status bar or with **Streamscope: Select Environment**. The choice is remembered per workspace.
- **`{{$secret name}}`** asks for the value once, keeps it in VS Code's secret storage for this workspace, and hides it everywhere Streamscope writes. Use **Set Secret**, **Clear Secret** and **List Secrets** to manage values, or the **Move to secret storage** quick fix on a line like `@apiToken = …`.
- **`{{$dotenv name}}`** reads `.env.<environment>` or `.env` next to the file, or in a parent folder up to the workspace folder.
- **`{{$processEnv name}}`** reads VS Code's own environment.
- Both accept `%name`, which first looks up the real name in the environment.
- A missing value never becomes an empty one: the request is not sent.
- An environment can set `"streamscope.insecure": true` to skip TLS verification for its requests.

Hover over `{{…}}` to see the value and where it comes from (secrets and credential-like values stay hidden). Completion offers variables after `{{` and directives after `# @`, and undefined variables get a warning.

## Restricted workspaces

In a workspace you have not trusted, Streamscope still colours, outlines and checks `.http` files. Before sending, it asks once per session. It never reads secrets, `.env` files, `http-client.private.env.json`, process variables or body files there, ignores `# @insecure` and environment TLS opt-outs, and uses only your own `streamscope.request.caFile` setting.

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
