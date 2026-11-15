# Accessibility

Streamscope is designed to be used from the keyboard alone, with a screen reader, and in any VS Code colour theme. This page describes the keys of the response panel, what it gives screen readers, the themes and keyboard steps it was checked with and when, and the VoiceOver check that is still open.

## Keyboard

Streamscope's actions are commands under **Streamscope:** in the Command Palette (`Cmd+Shift+P`, or `Ctrl+Shift+P` on Windows and Linux), so you can run any of them without the mouse and bind them to keys in Keyboard Shortcuts.

| Where          | Keys                                                    | What happens                                                                                |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A `.http` file | `Cmd+Alt+Enter` (`Ctrl+Alt+Enter` on Windows and Linux) | Sends the request under the cursor and opens the response panel beside the editor           |
| Response panel | `Tab`, `Shift+Tab`                                      | Moves between the panel's buttons, the selected view tab and the view's content             |
| View tabs      | `Right Arrow`, `Left Arrow`, `Home`, `End`              | Selects the next, previous, first or last view: Events, Reply, Raw, Headers, Body or Checks |
| Event list     | `Down Arrow`, `Up Arrow`, `Home`, `End`                 | Selects the next, previous, first or last event                                             |
| Event list     | `Enter`                                                 | Expands or collapses the selected event                                                     |
| Expanded event | `Tab`                                                   | Moves to the event's text, which you can select, and then to **Open Event in Editor**       |
| Expanded event | `Escape`                                                | Closes the event and returns to the list                                                    |

To capture a value without the mouse, open the event or body in the editor, put the cursor on the value and run **Streamscope: Capture This Value…**. File runs use VS Code's Testing view and its own keys and commands, such as **Test: Cancel Test Run**.

## Screen readers

- The panel's views are a tab list named "Response views", with one tab per view.
- The event list is a list box named "Events". Each row holds the event's number, time, label and a preview, and its position in the list.
- An expanded event is a group named after the event, such as "Event 4".
- Captured values are a list named "Captured values", and the Checks view lists each check as passed or failed with its detail.
- Changes in the run's state, such as Receiving, Completed or Cancelled, are announced politely through a status region, at most once every 2 seconds, so a fast stream does not flood the screen reader.
- The ✓ and ✗ marks beside `# @expect` lines repeat what the Checks view and, in file runs, the Testing view already list.

## Themes

Checked on 2026-11-14 with VS Code 1.146.0 on macOS, in the four default themes. The check used a streaming request with a capture, a passing check and a failing check, and a file of four requests: one passes, one fails a check, one cannot connect, and one is skipped because it needs a value from the request that could not connect. The panel and editor were looked at on startup, while events arrived in the Events, Reply and Raw views, in the Headers view, with an event expanded, after **Stop**, in the Checks view and in the Testing view.

| Area                                                                       | Dark Modern | Light Modern | High Contrast | High Contrast Light |
| -------------------------------------------------------------------------- | ----------- | ------------ | ------------- | ------------------- |
| Panel tabs, selected tab                                                   | Readable    | Readable     | Readable      | Readable            |
| Event list, selected row, expanded event and its buttons                   | Readable    | Readable     | Readable      | Readable            |
| Status line and state pill                                                 | Readable    | Readable     | Readable      | Readable            |
| Checks view, passed and failed                                             | Readable    | Readable     | Readable      | Readable            |
| Captured values                                                            | Readable    | Readable     | Readable      | Readable            |
| ✓ / ✗ beside `# @expect` lines                                             | Readable    | Readable     | Fixed         | Fixed               |
| Testing view: passed, failed, errored and skipped, inline failure messages | Readable    | Readable     | Readable      | Readable            |

**Fixed:** in both high-contrast themes, the ✗ and its detail beside a failed `# @expect` line did not show at all, while ✓ did, because the colour the mark used has no value in those themes. Failed marks now use the theme's error colour, which all four themes define, and a second check in both high-contrast themes showed "✗ got 200".

**Known:** disabled buttons, such as **Stop** after a run ends, have low contrast in High Contrast Light. Inactive controls are exempt from contrast requirements, so they stay as VS Code draws them.

## Keyboard check

Checked on 2026-11-14 in VS Code 1.146.0 on macOS, with key presses only and no mouse, against a synthetic stream of 20 events a second.

| Step                                                                                                                          | Result                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Open `stream.http` with Quick Open (`Cmd+P`)                                                                                  | Pass                                                                                                                                        |
| Send the request with `Cmd+Alt+Enter`                                                                                         | Pass: the panel opens beside the editor and streams                                                                                         |
| Move to the panel (`Cmd+2`) and `Tab` through it                                                                              | Pass: Save Response → Stop → Events tab → event list                                                                                        |
| Switch views with `Right Arrow`, `Right Arrow` and `Home` on the tabs                                                         | Pass: Reply, then Headers, then Events are selected and focused                                                                             |
| In the list, `Home`, `Down Arrow`, `Down Arrow` and `Enter`                                                                   | Pass: row 3 is selected and expands as "Event 3"                                                                                            |
| `Tab` from the list to the event's buttons                                                                                    | Pass: the event's JSON (focusable for selecting text), then Open Event in Editor                                                            |
| `Enter` on Open Event in Editor                                                                                               | Pass: `event-3.json` opens in a new editor group with the cursor in it                                                                      |
| Put the cursor on a value and run **Streamscope: Capture This Value…** from the Command Palette, accepting the suggested name | Pass: the name box suggests `delta`; `# @capture delta = nth(2, type == "TEXT_MESSAGE_CONTENT").delta` is added to the request and selected |
| Open `run.http` and run **Streamscope: Run File** from the Command Palette                                                    | Pass: the first request passes and the second starts                                                                                        |
| Stop it with **Test: Cancel Test Run** from the Command Palette                                                               | Pass: the running request is cancelled ("Cancelled after 4.7 s") and the third never starts                                                 |

The capture step used an event opened in the editor. A body opened in the editor offers the same command.

## VoiceOver checklist

This check is still open. Run it on macOS with Streamscope installed and VoiceOver on (`Cmd+F5`). You need a server that streams NDJSON or Server-Sent Events: a `RUN_STARTED` event with `"threadId": "thread-1"`, then a few thousand `TEXT_MESSAGE_CONTENT` events, each sent while the stream runs. Send this request from an untitled `http` document, with the stream's URL in place of the example one:

```http
# @name walkthrough
# @capture threadId = first(type == "RUN_STARTED").threadId
# @expect status == 200
# @expect status == 201
GET https://stream.example.test/agent/run
```

For steps 9 to 11, use a file with four requests named `passing`, `failing`, `erroring` and `dependant`: `failing` has a check that fails, `erroring` cannot connect, and `dependant` uses a value captured by `erroring`.

Write the result of each step in the Result column: what VoiceOver said, or "as expected".

| #   | Step                                                                                                 | Expected announcement                                                                                                                                     | Result |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Send the request with `Cmd+Alt+Enter`, then move VoiceOver into the response panel                   | The panel's title, then the bar's buttons: "Open in Editor", "Save Response", "Stop" (dimmed when not available)                                          |        |
| 2   | Move to the tabs (`VO+Right` from the bar)                                                           | "Response views, tab group", then each tab by name: "Events, selected, tab, 1 of 6", "Reply, tab, 2 of 6", …                                              |        |
| 3   | Wait while the stream runs                                                                           | A polite status update when the state changes, such as "Receiving. Running · 120 events · 6.1 s · NDJSON", at most every 2 s                              |        |
| 4   | Move into the event list and press `Down Arrow` a few times                                          | "Events, list box", then the selected row: its number, time, label and preview, and its position, such as "4, 0.2 s, TEXT_MESSAGE_CONTENT, …, 4 of 2,401" |        |
| 5   | Press `Enter` on an event                                                                            | "Event 4, group", then the event's fields                                                                                                                 |        |
| 6   | Move to the captured values above the panels                                                         | "Captured values, list", then "threadId, captured: thread-1"                                                                                              |        |
| 7   | Stop the stream with the Stop button                                                                 | "Cancelled. …" in the status announcement                                                                                                                 |        |
| 8   | Open the Checks tab                                                                                  | "passed: status == 200", then "failed: status == 201, got 200"                                                                                            |        |
| 9   | Run **Streamscope: Run File** on a file with a passing, a failing, an erroring and a skipped request | The Testing view announces each result; each test reads its name and state, such as "failing, Failed"                                                     |        |
| 10  | Open the failed test's message (`Enter` on the test, or Test Results)                                | "`status == 201` got 200"                                                                                                                                 |        |
| 11  | Open the skipped test's output in Test Results                                                       | "dependant: skipped." followed by the reason, naming the request it needed                                                                                |        |

Steps 9 to 11 use VS Code's own Testing view and Test Results; Streamscope only supplies the names, states and messages.
