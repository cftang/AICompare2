# exam-answer-runner

Batch-pipelines exam questions through the aishell (DevStation AI Shell) terminal embedded in the AICompare2 iframe page, captures answers via the raw terminal WebSocket stream, and writes a Markdown answer sheet.

## Why the WS stream (not DOM scraping)

The aishell page is an xterm.js full-screen TUI with **no DOM scrollback** (`scrollHeight == clientHeight`; only ~28 visible rows ever exist in `.xterm-rows`). Long answers scroll off permanently, so reading `innerText` loses content and misaligns across questions. This suite instead listens to `Network.webSocketFrameReceived` over Chrome DevTools Protocol, decodes each frame, and replays the byte stream through a VT100 emulator that reconstructs the full transcript.

Frame format: base64 payload -> binary -> 20-byte header -> raw VT/ANSI stdout.
Header layout: `[0]=0x05 [1]=0x03 [2..3]=length BE [4..7]=stream id [8..19]=timestamp/flags`.
Only stream id `0x000000fd` (terminal stdout) is replayed.

## Transcript capture

A conventional emulator only preserves a row once it scrolls off the top of the screen. aishell does not always scroll: on a fast response it **repaints the pane**, redrawing every row in place, so rows that never reach the top are lost. That is how a 22 s Q39 capture silently dropped ~12 lines out of the middle of an otherwise complete answer while still ending with a valid `ANSWER:` line.

`vt.mjs` therefore keeps an append-only `transcript` instead of a scrollback list, and reconciles it against the screen after every write (`commit()`):

- The screen's rows are aligned against the transcript tail by finding the offset whose **run** of matching rows is longest. A row matches if it is identical, or if `sameLine()` considers it the same row redrawn — one string extending the other (a line growing as it streams) or sharing ≥60% of its head and tail (a spinner frame, a changed counter). Rows shorter than 12 chars must match exactly, otherwise `line1` and `line5` look 80% alike and a scrolled screen aligns against the wrong row.
- Everything above the winning offset is kept; the screen supplies everything from there on. Rows that merely moved up during a repaint are recognised by the alignment rather than appended again, so a repaint neither loses nor duplicates content.
- Only the recent tail (3 screenfuls) is searched, so a line repeated far back in a long answer cannot drag the alignment backwards.
- `commit()` also runs before each upward shift and before any erase that discards a region (`CSI J`, and `CSI 2K` on the top row), because content about to be destroyed must be captured first. A bulk scroll of several screenfuls inside one frame therefore cannot skip rows.
- Trailing blank rows are trimmed before alignment, so a half-filled screen does not pad the transcript with blanks and break the next match.
- `allLines()` returns the transcript; `visibleLines()` still returns only the 28-row viewport and is what completion detection uses to look for `esc cancel`.

`vt-test.mjs` covers the cases that broke during development: plain scrolling, a repaint that shifts content up without scrolling, a line growing in place, a spinner rewriting one row, erase-below-then-redraw, `CSI L` insertion order, and a 20-line answer delivered as a pager that repaints all 6 rows on every step.

Alongside each render the runner archives `qNN.frames.json`, the undecoded stdout frames. The render is only as good as `vt.mjs`; the frames allow any future emulator fix to be replayed offline without re-querying the model.

## Pre-submit guard

If a slash command ever reaches the input box (a question beginning with `/`, or a stray `/help`), aishell switches it into command mode: the footer changes from `enter send` to `enter execute`, `No matching items` appears, and the box **never clears again**. Subsequent pastes silently append to the stuck text and Enter never submits, so the runner used to "succeed" in ~24 s while capturing 2 lines. There is no programmatic escape — trusted `Input.dispatchKeyEvent` (ctrl+c, Escape) does not reach the TUI at all, and pasted control bytes (`\x03`, `\x7f`, `\x15`) are ignored.

So `waitReady()` classifies the footer before every submit via `promptState()`:

| State | Footer marker | Action |
|---|---|---|
| `idle` | `enter send` | submit |
| `busy` | `esc cancel` | wait, poll again |
| `stuck` | `enter execute` / `No matching items` | abort the whole run |
| `unknown` | none of the above | wait; submit anyway on timeout |

On `stuck` the runner logs `Q<N> ABORT` and stops **without writing an entry**, so the question is picked up again on the next resume. Clearing the box by hand in the browser is the only fix.

This one check reads the **DOM** (`.xterm-rows` innerText), not the WS stream. An idle prompt emits no stdout frames at all, so a quietly stuck box is indistinguishable from a healthy one in the stream; the DOM's missing scrollback is irrelevant when only the bottom rows matter.

## Files

| File | Purpose |
|---|---|
| `vt.mjs` | VT100/xterm emulator: cursor moves, erase line/screen/chars, insert/delete lines, scroll regions (CSI r/S/T/L/M), backspace, tabs, OSC/DCS skip, CJK wide-char width, and repaint-safe transcript capture (see above). |
| `vt-test.mjs` | Unit tests for the transcript capture. Run with `node vt-test.mjs`; exits non-zero on failure. |
| `extract.mjs` | Shared question parsing, answer extraction (`extract` / `extractRaw`), the pre-submit prompt classifier (`promptState`), and the Markdown entry template. Imported by all three scripts below so their logic can never drift apart. |
| `extract-test.mjs` | Unit tests for `promptState`. Run with `node extract-test.mjs`; exits non-zero on failure. |
| `exam-runner.mjs` | Orchestrator. Parses the exam txt, connects to the aishell iframe target via CDP, checks the prompt is accepting input (see *Pre-submit guard*), submits each question through the extension's isolated world (`getSiteHandler` / `executeSiteHandler` with the `pasteText` handler), polls the VT-reconstructed screen until the answer is stable, extracts the `ANSWER:` line + explanation, appends to the Markdown file, and archives each render as `qNN.txt` plus its undecoded frames as `qNN.frames.json`. Resumes from already-answered questions on restart. |
| `start-exam.ps1` | Wrapper that launches the runner detached in the background (direct `Start-Process` from the tool shell silently fails to spawn; a `.ps1` file works). Paths are relative to this directory. |
| `start-exam0.ps1` | Same wrapper preset for the exam0 source/output paths. |
| `rebuild-from-raw.mjs` | Regenerates a complete answer sheet offline from the archived raw renders + progress log, without re-querying aishell. Use when extraction needs fixing after a run. Args: `<source.txt> <output.md> <progress.log> <raw-dir>`. |
| `verify-extract.mjs` | Regression gate: replays `extract()` against every archived render and fails if any entry leaks the echoed instruction, is missing an `ANSWER:` letter, or produces a raw block shorter than the cleaned one. Args: `<source.txt> <raw-dir>`. |

## Prerequisites

1. Chrome running with CDP and the extension loaded (branded Chrome 137+ ignores `--load-extension`; load via CDP instead):
   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\tmp\chrome-cdp-profile --enable-unsafe-extension-debugging --no-first-run --no-default-browser-check
   ```
   then `Extensions.loadUnpacked` on `C:\tmp\AICompare2`.
2. An open tab at the extension's `iframe.html` with the aishell iframe, logged in (ticket in URL).
3. Node.js 22+ (global `fetch` and `WebSocket`).

## Usage

```powershell
# foreground; positional args: <source.txt> <output.md> <progress.log> <raw-dir> <limit>
node exam-runner.mjs "C:\Users\thinkpad\Downloads\infer\exam2.txt" "c:\tmp\exam2answer.md" "C:\tmp\exam2-progress.log"

# only specific questions (comma-separated), into an isolated output dir
$env:ONLY_Q="39"; node exam-runner.mjs "...\exam0.txt" "C:\tmp\q39test\answer.md" "C:\tmp\q39test\progress.log" "C:\tmp\q39test"

# background (recommended for a full 52-question run, ~40-50s/question)
powershell -ExecutionPolicy Bypass -File start-exam.ps1

# monitor
Get-Content C:\tmp\exam2-progress.log -Tail 20
```

With no args, defaults to exam1 paths (`exam1.txt` -> `c:\tmp\exam1answer.md`) and raw dir `C:\tmp\exam-raw`. `<limit>` caps how many pending questions run in one pass. `ONLY_Q` overrides resume logic and runs exactly the listed question numbers.

Note the raw dir is keyed by question number only, so different exams sharing one raw dir will overwrite each other's renders for overlapping numbers. Use a per-exam raw dir if you need all renders retained.

## Exam input format

Two layouts are supported. With an explicit index marker:

```
单选题 / 多选题
第N/52题
<question stem>
<option lines, may contain multi-line code blocks>
```

Or with the number carried by the stem itself (exam0 style, after answers are stripped):

```
多选题
26、<question stem>
A.<option>
B.<option>
```

Blocks are split on standalone `单选题`/`多选题` lines. De-duplication is by **normalized body text**, not by number, because exam0 repeats numbers across blocks with different content; colliding numbers are reassigned upward so every question gets a unique heading.

## Answer extraction

- Prompt prepends an instruction asking for a detailed explanation then a final `ANSWER: X` line.
- The echoed question's final option line is located in the scrollback to mark where the answer begins. Matching strips xterm box-drawing prefixes (`┃`, `│`) and tests a sliding window of up to 4 joined lines, because the terminal hard-wraps long options across rows.
- Anchor candidates are restricted to lines that **carry** a box-drawing prefix. The echo box always has one and the model's answer never does; without this restriction, an answer that quotes the option text verbatim while analysing it becomes its own anchor and the explanation gets truncated to its tail. If no boxed anchor exists the search falls back to unrestricted matching.
- Anchors are tried newest-first; a slice is accepted once it contains an `ANSWER:` line and is free of the echoed instruction. Any residual leading echo (instruction, type header, stem, option lines) is trimmed.
- Noise lines are stripped: `ASK glm-*`, `huawei-inner-provider`, `Thinking...`, `Thinking Done`, `Tab to accept`, `enter send`, `esc cancel`, `ctrl+c quit`, spinner frames, box-drawing borders.
- `ANSWER:` letter(s) go to the `**答案：**` field; the cleaned explanation goes into a collapsible `<details>` block. The marker regex tolerates the model's occasional `ANSER:` typo.
- A second `<details>` block, **aishell 原始输出**, holds the verbatim render of the same region from `extractRaw()`: no noise filtering and no re-indentation, so the model's original indentation, `•` bullets, `✅` marks and blank lines survive. Only the leading echo/spinner noise and the trailing terminal chrome are cut. It is omitted when empty.
- Completion = answer text stable across consecutive polls while `esc cancel` is absent (Q1 capture time dropped from a 302 s timeout to ~14 s vs the old DOM approach).

## Recovering a bad run

Raw VT renders are archived per question, so a botched extraction never requires re-querying aishell:

```powershell
node rebuild-from-raw.mjs "C:\Users\thinkpad\Downloads\infer\exam0.txt" "c:\tmp\exam0answer.md" "C:\tmp\exam0-progress.log" "C:\tmp\exam-raw"
node verify-extract.mjs "C:\Users\thinkpad\Downloads\infer\exam0.txt" "C:\tmp\exam-raw"
```

`rebuild-from-raw.mjs` cross-fills answer letters from the progress log when a render is ambiguous. Do **not** write a cleanup script that reads the answer sheet and overwrites it in place — an earlier attempt truncated `exam0answer.md` to 0 bytes that way.

Note that the gate checks extraction, not capture completeness: a render with a hole punched out of the middle still passes if it ends in a valid `ANSWER:` line. When a captured answer looks abridged, compare the render against what the terminal displayed rather than trusting the gate.

## Results so far

| Exam | File | Questions | Errors | Notes |
|---|---|---|---|---|
| exam1 (昇腾推理) | `c:\tmp\exam1answer.md` | 52/52 | 0 | 41 single + 11 multi |
| exam2 (算子开发认证) | `c:\tmp\exam2answer.md` | 52/52 | 0 | handles multi-line ` ```cpp ` options |
| exam0 (MindSpore) | `c:\tmp\exam0answer.md` | 42/42 | 0 | all multi-select; rebuilt from raw renders, includes raw output blocks |

Q39 in exam0 was re-captured after the transcript fix, so its text is a later generation than the rest of the sheet. The model is non-deterministic; re-running a question yields different prose (the answer letters have matched every time).

## Gotchas

- Site handler config is cached in `chrome.storage.local.remoteSiteHandlers`; after editing `siteHandlers.json`, clear that key and reload the extension or stale steps keep running.
- `executeSiteHandler` must run in the extension **isolated world** (context origin `chrome-extension://...`, usually contextId 2), not the page's main world.
- xterm ignores synthetic `input` events / `.value` writes; the extension's `pasteText` action (ClipboardEvent with a DataTransfer) is what works, including multiline text.
- The Markdown in an answer is styled with SGR escapes, which the emulator drops: headings arrive as plain text and bold/inline-code markers vanish. aishell's soft wraps also become real newlines, since the capture is a 73-column character grid. Neither is recoverable from the stream.
- The 73-column wrap is fixed server-side. Widening the browser window (`Browser.setWindowBounds`) or forcing a wider `.xterm` / `.terminal` / `.web-terminal-container` chain leaves the PTY at 73 columns, so hard wraps cannot be avoided.
- There is no raw-text side channel. Besides stdout (`0x000000fd`) the socket carries only 8-byte binary keepalives on `0x00070000` and zero-length frames on `0x000006fc`; the VT-rendered TUI output is the only content available.
