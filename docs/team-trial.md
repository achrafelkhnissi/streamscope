# Team trial of Streamscope 0.1.0

Status: waiting for the `0.1.0` pre-release on the Marketplace and Open VSX ([roadmap](roadmap.md), M12).

## Goal

The trial checks the two success criteria from [design section 1](design.md#success-anti-goals) on the team's own streaming endpoints:

- "No more copying ids by hand"
- "Seeing events live"

M12 is accepted when the team confirms "no copied ids, events live".

## Install

- In VS Code, search for "Streamscope" in the Extensions view and install it. `0.1.0` is a pre-release.
- Or from a terminal: `code --install-extension achrafelkhnissi.streamscope --pre-release`.
- REST Client can stay installed; see [Using Streamscope with REST Client](../README.md#using-streamscope-with-rest-client).

## What to try

Use your own endpoints and `.http` files:

1. Send a streaming request and watch the Events view while it runs.
2. Capture an id from one event, with a `# @capture` line such as `first(type == "RUN_STARTED").threadId` or with **Capture This Value…**, and use it in the next request while the stream is still running.
3. Run a whole file from the Testing view, with `# @expect` lines and an `# @until` line.
4. Keep a long stream running while you type in the editor.

A stream labelled `application/json` is recognised as NDJSON when its second line arrives. Until then its first line shows as a JSON body, and a capture from it waits. Note it if your backend pauses after its first event and the delay shows.

## Questions for each tester

- Did you copy an id by hand at any point? Where?
- Did events appear as the server sent them, or did they lag behind?
- Did VS Code slow down or freeze?
- Was a request ever sent with an empty or wrong value?
- Did a token or secret ever show in clear text?

## Reporting

- Anything you can reproduce with a made-up request: open a GitHub issue with the **Bug report** form.
- Anything that needs the team's own backend: tell Achraf directly.
- Never paste tokens, real ids, real URLs or the team's `.http` files into an issue.

## Results

| Tester   | OS  | VS Code version | Copied an id by hand? | Events appeared live? | Issues |
| -------- | --- | --------------- | --------------------- | --------------------- | ------ |
| Tester 1 |     |                 |                       |                       |        |

Team confirmation of "no copied ids, events live": not yet given.
