# Accessibility and theme pass

Milestone M11 checks that the response panel, the editor decorations and the Testing view work in VS Code's four default themes, from the keyboard alone, and with VoiceOver. Design section 3 sets the requirement: "Every action is reachable from the keyboard and command palette; views work with screen readers". Section 18 makes it a manual check.

## Theme pass

Run on 2026-11-14 on this branch with `npm run bench -- view --walkthrough --surface m11-<theme> --theme "<theme>"`, VS Code 1.146.0, macOS. The walkthrough request now has a capture, a passing check and a failing check, and a last step runs a four-request file (passed, failed, errored by a refused connection, skipped as the dependant of the refused request) and shows the Testing view. Screenshots: `out/benchmark/screenshots/m11-<theme>-<step>.jpeg` (not committed), for the steps startup, events-live, reply-live, raw-live, headers, detail, stopped, checks and testing.

| Area                                                                       | Dark Modern | Light Modern | High Contrast | High Contrast Light |
| -------------------------------------------------------------------------- | ----------- | ------------ | ------------- | ------------------- |
| Panel tabs, selected tab                                                   | Readable    | Readable     | Readable      | Readable            |
| Event list, selected row, expanded event and its buttons                   | Readable    | Readable     | Readable      | Readable            |
| Status line and state pill                                                 | Readable    | Readable     | Readable      | Readable            |
| Checks tab, passed and failed                                              | Readable    | Readable     | Readable      | Readable            |
| Capture strip                                                              | Readable    | Readable     | Readable      | Readable            |
| ✓ / ✗ beside `# @expect` lines                                             | Readable    | Readable     | Fixed         | Fixed               |
| Testing view: passed, failed, errored and skipped, inline failure messages | Readable    | Readable     | Readable      | Readable            |

**Finding, fixed:** in both high-contrast themes the ✗ and its detail beside a failed `# @expect` line did not show at all, while ✓ did. VS Code 1.146 defines `testing.iconFailed` as `list.errorForeground`, which has no value in the high-contrast themes, so the decoration had no colour. Failed marks now use `errorForeground`, which all four themes define, and a unit test pins the choice. The rerun of both high-contrast walkthroughs shows "✗ got 200" in each.

Disabled buttons, such as Stop after a run ends, have low contrast in High Contrast Light. Inactive controls are exempt from the contrast requirement, so this stays as VS Code draws it.

## Keyboard-only pass

Run on 2026-11-14 in a real VS Code 1.146.0 window driven only by key events sent over the DevTools protocol (no clicks), with a synthetic 20 events/s stream. The driver is a throwaway script, not part of the repository; its screenshots were checked by hand.

| Step                                                                                                                          | Result                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Open `stream.http` with Quick Open (Cmd+P)                                                                                    | Pass                                                                                                                                        |
| Send the request with Cmd+Alt+Enter                                                                                           | Pass: the panel opens beside the editor and streams                                                                                         |
| Move to the panel (Cmd+2) and Tab through it                                                                                  | Pass: Save Response → Stop → Events tab → event list                                                                                        |
| Switch views with Right Arrow, Right Arrow and Home on the tabs                                                               | Pass: Reply, then Headers, then Events are selected and focused                                                                             |
| In the list, Home, Down, Down and Enter                                                                                       | Pass: row 3 is selected and expands as "Event 3"                                                                                            |
| Tab from the list to the event's buttons                                                                                      | Pass: the event's JSON (focusable for selecting text), then Open Event in Editor                                                            |
| Enter on Open Event in Editor                                                                                                 | Pass: `event-3.json` opens in a new editor group with the cursor in it                                                                      |
| Put the cursor on a value and run **Streamscope: Capture This Value…** from the Command Palette, accepting the suggested name | Pass: the name box suggests `delta`; `# @capture delta = nth(2, type == "TEXT_MESSAGE_CONTENT").delta` is added to the request and selected |
| Open `run.http` and run **Streamscope: Run File** from the Command Palette                                                    | Pass: the first request passes and the second starts                                                                                        |
| Stop it with **Test: Cancel Test Run** from the Command Palette                                                               | Pass: the running request is cancelled ("Cancelled after 4.7 s") and the third never starts                                                 |

The plan asked to capture from the Body document. A stream's values come from events, so the pass used the event document, which offers the same command.

## VoiceOver checklist

Run this on macOS with VoiceOver on (Cmd+F5), on a build of this branch (`npm run build`, then F5 or the installed VSIX). Use a synthetic stream: run `npm run bench -- serve` and send this request from an untitled `http` document, with the printed URL:

```http
# @name walkthrough
# @capture threadId = first(type == "RUN_STARTED").threadId
# @expect status == 200
# @expect status == 201
GET <the serve URL>
```

Write the result of each step in the Result column: what VoiceOver said, or "as expected".

| #   | Step                                                                                                 | Expected announcement                                                                                                                                     | Result |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Send the request with Cmd+Alt+Enter, then move VoiceOver into the response panel                     | The panel's title, then the bar's buttons: "Open in Editor", "Save Response", "Stop" (dimmed when not available)                                          |        |
| 2   | Move to the tabs (VO+Right from the bar)                                                             | "Response views, tab group", then each tab by name: "Events, selected, tab, 1 of 6", "Reply, tab, 2 of 6", …                                              |        |
| 3   | Wait while the stream runs                                                                           | A polite status update when the state changes, such as "Receiving. Running · 120 events · 6.1 s · NDJSON", at most every 2 s                              |        |
| 4   | Move into the event list and press Down Arrow a few times                                            | "Events, list box", then the selected row: its number, time, label and preview, and its position, such as "4, 0.2 s, TEXT_MESSAGE_CONTENT, …, 4 of 2,401" |        |
| 5   | Press Enter on an event                                                                              | "Event 4, group", then the event's fields                                                                                                                 |        |
| 6   | Move to the captured values above the panels                                                         | "Captured values, list", then "threadId, captured: thread-1"                                                                                              |        |
| 7   | Stop the stream with the Stop button                                                                 | "Cancelled. …" in the status announcement                                                                                                                 |        |
| 8   | Open the Checks tab                                                                                  | "passed: status == 200", then "failed: status == 201, got 200"                                                                                            |        |
| 9   | Run **Streamscope: Run File** on a file with a passing, a failing, an erroring and a skipped request | The Testing view announces each result; each test reads its name and state, such as "failing, Failed"                                                     |        |
| 10  | Open the failed test's message (Enter on the test, or Test Results)                                  | "`status == 201` got 200"                                                                                                                                 |        |
| 11  | Open the skipped test's output in Test Results                                                       | "dependant: skipped." followed by the reason, naming the request it needed                                                                                |        |

Steps 9 to 11 use VS Code's own Testing view and Test Results; Streamscope only supplies the names, states and messages.
