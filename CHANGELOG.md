# Changelog

## Unreleased

- Project setup: build, lint, formatting, unit and integration tests, packaging and installed-VSIX verification.
- Renamed to Streamscope; MIT license; CI on Linux, macOS and Windows.
- **Streamscope: Show Log** command.
- `.http` and `.rest` files: syntax colouring, outline, folding and syntax diagnostics, matching REST Client's request syntax.
- Send the request under the cursor with `Cmd+Alt+Enter` (`Ctrl+Alt+Enter` on Windows and Linux) or the **Send Request** CodeLens, and stop it while it runs.
- Responses open beside the editor: an indented body (large bodies are formatted off the main thread) and a Headers view with the status, the request as sent with credentials masked, redirect hops and timing.
- File variables and the `$guid`, `$timestamp`, `$datetime`, `$localDatetime` and `$randomInt` system variables; a request with a value that cannot be resolved is never sent.
- Body files (`< path`, `<@ path`) limited to the workspace folder; gzip, deflate, br and zstd decompression; redirects that drop credentials across origins.
- `# @timeout`, `# @no-redirect` and `# @insecure`; settings for connect and headers timeouts, redirects and an extra CA file.
- **Save Response** saves the decoded body exactly as received.
- A one-time offer to hide REST Client's and httpyac's Send links when they are installed.
