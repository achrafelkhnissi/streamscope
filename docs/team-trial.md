# Team trial of Streamscope 0.1.0

Status: not started. It begins when the `0.1.0` pre-release is on the Marketplace and Open VSX.

Trial period: to be announced.

## Goal

The trial checks two things on the team's own streaming endpoints:

- "No more copying ids by hand"
- "Seeing events live"

The result is the team's confirmation of "no copied ids, events live". Along the way, look for four things that must not happen: events lagging behind the network, VS Code freezing or slowing down, a request sent with an empty or wrong value, and a token or secret shown or stored in clear text.

When the trial period ends, the team tells Achraf whether it gives that confirmation.

## Install

- In VS Code, search for "Streamscope" in the Extensions view and check that the publisher is achrafelkhnissi before you install it. `0.1.0` is a pre-release.
- Or from a terminal: `code --install-extension achrafelkhnissi.streamscope --pre-release`.
- REST Client can stay installed; see [Using Streamscope with REST Client](../README.md#using-streamscope-with-rest-client).

The [README](../README.md) describes every feature used below.

## Before you start

- Use your own endpoints and `.http` files. The examples here use made-up values.
- Trust the workspace first. In a restricted workspace Streamscope reads no secrets or `.env` files and does not run files from the Testing view.
- Use a token you can rotate, and pass it as `{{$secret apiToken}}`: Streamscope asks for the value once and keeps it in VS Code's secret storage. Never write the real token in a `.http` file you commit.
- A stream labelled `application/json` is recognised as NDJSON when its second line arrives. Until then its first line shows as a JSON body, and a capture from it waits. Put `# @stream ndjson` on the request to read such a stream as NDJSON from its first line, and note it if your backend pauses after its first event.

## Tasks

Do each task on a real endpoint. Answer each one `yes` if it passed and `no` if it did not. For a `no`, say where: the task, the step and the Streamscope view or command.

### 1. Events appear live

Put the cursor in a streaming request and press `Cmd+Alt+Enter` (`Ctrl+Alt+Enter` on Windows and Linux). Watch the Events view while the stream runs.

- Pass: rows appear one by one while the server is still sending, and the event count keeps rising until the stream ends.
- Fail: rows arrive in a burst, or more than about a second after the server sent them. If you can, compare with the same call in `curl -N` or with your backend's log.

### 2. No id copied by hand

Add the capture line to the request that starts a run, and use it in the next request:

```http
@baseUrl = https://agent.example.test

### Start run
# @name startRun
# @capture threadId = first(type == "RUN_STARTED").threadId
POST {{baseUrl}}/agent/run
Content-Type: application/json

{"message": "hello"}

### Continue
POST {{baseUrl}}/agent/continue
Content-Type: application/json

{"threadId": "{{startRun.threadId}}"}
```

Replace the URL, the event type and the field with your own. Send the first request, then send the second while the first stream is still running. You can also click a value in an expanded event and press **Capture This Value…** instead of typing the line.

Then add `# @expect status == 200` and `# @until type == "RUN_FINISHED"` to the first request and run the whole file with **Streamscope: Run File**.

- Pass: the second request ran with the id from the event, the id shows after the `# @capture` line, and the file run did not skip the second request. You copied no id.
- Fail: you copied, typed or pasted an id at any step.

### 3. No empty or wrong value is sent

Use the two requests from task 2.

1. Hover over `{{startRun.threadId}}` in the second request. It shows the id from the event and where it comes from.
2. Run the first request again and let it finish. Send the second. It must use the new id, not the old one. Check the hover, and the **Request** section of the Headers view if the id is in a header or the URL.
3. Write `{{notDefined}}` in the body of a request and send it. The request must not be sent, and the message must name `notDefined` and its line.
4. Run **Developer: Reload Window**, then send the second request first. It must not be sent, and the message must offer to run `startRun`.

- Pass: every step behaved as described.
- Fail: any request left with an empty, old or wrong value.

### 4. VS Code stays responsive

Start the longest stream your backend offers. While it runs, type in a `.http` file, scroll the Events view and switch between its views. Keep going for at least five minutes, or until the stream ends if that comes first. Then press **Stop** on a stream that is still running, starting another one if the first has ended.

- Pass: typing and scrolling keep pace the whole time, and **Stop** ends the stream within about a second.
- Fail: any pause in typing or scrolling that you notice, or a view that stops updating.

### 5. No token or secret in clear text

Send a request that uses your token as `{{$secret apiToken}}`, for example in `Authorization: Bearer {{$secret apiToken}}`. Then look for the token in:

- the **Request** section of the Headers view;
- the hover over `{{$secret apiToken}}`;
- **Streamscope: Show Log** and **Streamscope: Show History**;
- the Testing view output, after **Streamscope: Run File**;
- the value after a `# @capture` line that captures a credential.

If a token sits in a file variable such as `@apiToken = …`, use the **Move to Secret Storage** quick fix, then look at `git diff` for the `.http` file.

- Pass: in every place above the token either does not show or shows only as `••••••`, and `git diff` shows no token.
- Fail: the token shows in clear text in any place above, or in a `.http` file in `git diff`.
- Not a fail: response bodies, events and response headers, which show what the server sent, and a token in a URL query string, which is not masked. Keep tokens out of URLs.

## Reporting

- Anything you can reproduce with a made-up request: open a GitHub issue with the **Bug report** form.
- Anything that needs the team's own backend: tell Achraf directly.
- Never paste tokens, real ids, real URLs or the team's `.http` files into an issue.
- If a token or secret showed in clear text, say where it showed, never the value, and attach no screenshot of it; then rotate the token. Report it privately, not in a public issue: use **Report a vulnerability** on the repository's Security tab (see [SECURITY.md](../SECURITY.md)) or tell Achraf directly.
- Response bodies, events and response headers show tokens exactly as the server sent them, which is expected.
- Share logs or `.http` excerpts only after replacing hosts, ids and values, and never share environment files. Check screenshots and recordings the same way.
- This file is public: the Issues column holds only public issue numbers or neutral summaries, with no hosts, event names or ids from the team's backend. Every other cell holds only `yes` or `no`, and a secret that showed is recorded as `no` with "reported privately" in the Issues column.

## Results

One row per tester, named Tester 1, Tester 2 and so on, never by name. The columns follow the tasks.

| Tester   | OS  | VS Code version | 1 Events live | 2 No copied id | 3 No wrong value sent | 4 Responsive | 5 No secret shown | Issues |
| -------- | --- | --------------- | ------------- | -------------- | --------------------- | ------------ | ----------------- | ------ |
| Tester 1 |     |                 |               |                |                       |              |                   |        |

Team confirmation of "no copied ids, events live": not yet given.
