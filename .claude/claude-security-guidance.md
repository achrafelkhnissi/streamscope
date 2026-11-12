# Project security rules

This project is a VS Code extension (Node.js extension host) that sends HTTP requests written by the user in `.http` files and renders the responses, including long-running streams.

- Sending a request to a URL the user wrote in a `.http` file is the product's purpose. Do not report it as SSRF. Do report requests sent without an explicit user action, requests sent from an untrusted workspace, or request targets taken from response data.
- Credentials and secret-marked values must be stored only through VS Code SecretStorage (`context.secrets`), never in settings, `globalState`, `workspaceState`, history or files.
- `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, API-key headers and secret-marked captured values must be masked in logs, output channels, notifications, hovers, error messages and history.
- `.http` files, environment files and responses may come from untrusted repositories. Report any `eval`, `new Function`, `vm` or dependency that evaluates expressions from them (for example `jsonpath-plus`, `jsonpath`, JSONata).
- In an untrusted workspace the extension must not read `.env` files, inject secrets, run scripts or send requests automatically.
- TLS verification may be disabled only per request or environment after explicit user opt-in, never globally and never through `NODE_TLS_REJECT_UNAUTHORIZED`.
- Webviews need a CSP of `default-src 'none'` with nonces, `localResourceRoots` limited to the extension, and no remote scripts or styles.
- Test fixtures must contain only synthetic tokens and hosts.
- This project forbids code comments. Never suggest an inline suppression comment. Accepted false positives are listed below instead.

## Accepted findings

- `rejectUnauthorized: options.rejectUnauthorized` in `src/transport/node-transport.ts` turns TLS verification off only for a request marked `# @insecure` or a request sent in an environment that sets `"streamscope.insecure": true` (design section 6), and only in a trusted workspace (`src/runs/run.ts` computes it). It is never global and never uses `NODE_TLS_REJECT_UNAUTHORIZED`.
