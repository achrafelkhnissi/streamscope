# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. On GitHub, open the repository's **Security** tab and choose **Report a vulnerability**, which opens a private security advisory that only the maintainer can see.

Include what you did, what happened and what you expected, the Streamscope and VS Code versions, and a minimal `.http` file or server response that shows the problem. Use synthetic data: never send real tokens, passwords or production URLs.

A confirmed problem is fixed in a new release, and the advisory is published once that release is available.

## Supported versions

Streamscope is in its `0.x` pre-release line. Only the latest released version gets security fixes.

## What Streamscope never does

- It sends no telemetry and needs no account.
- It makes no network requests except the requests you send, and never sends one you did not ask for.
- It keeps the secrets you enter only in VS Code's secret storage and masks them wherever it describes a request. Responses are shown and saved as the server sent them, and kept in private files in its storage folder until the run leaves the history or VS Code closes.
- In a workspace you have not trusted, it does not read secrets, `.env` files or process variables, and it asks before sending.
- It never runs code from a `.http` file, an environment file or a response.
