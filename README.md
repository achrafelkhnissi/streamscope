# Streamscope

A VS Code extension for sending requests from `.http` files and watching streaming responses (NDJSON, Server-Sent Events, chunked and LLM streams) arrive event by event.

This version is a development skeleton. It contains the project setup and a single **Streamscope: Show Log** command; request sending and response viewing are not implemented yet.

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
