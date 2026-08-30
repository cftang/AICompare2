# exam-answer-runner

Batch-pipelines exam questions through the aishell (DevStation AI Shell) terminal embedded in the AICompare2 iframe page, captures answers via the raw terminal WebSocket stream, and writes a Markdown answer sheet.

## Why the WS stream (not DOM scraping)

The aishell page is an xterm.js full-screen TUI with **no DOM scrollback** (`scrollHeight == clientHeight`; only ~28 visible rows ever exist in `.xterm-rows`). Long answers scroll off permanently, so reading `innerText` loses content and misaligns across questions. This suite instead listens to `Network.webSocketFrameReceived` over Chrome DevTools Protocol, decodes each frame, and replays the byte stream through a VT100 emulator with its own unbounded scrollback.

Frame format: base64 payload -> binary -> 20-byte header -> raw VT/ANSI stdout.
Header layout: `[0]=0x05 [1]=0x03 [2..3]=length BE [4..7]=stream id [8..19]=timestamp/flags`.
Only stream id `0x000000fd` (terminal stdout) is replayed.

## Files

| File | Purpose |
|---|---|
| `vt.mjs` | Minimal VT100/xterm emulator: cursor moves, erase line/screen/chars, insert/delete lines, scroll regions (CSI r/S/T/L/M), backspace, tabs, OSC/DCS skip, CJK wide-char width, unbounded scrollback. |
| `exam-runner.mjs` | Orchestrator. Parses the exam txt, connects to the aishell iframe target via CDP, submits each question through the extension's isolated world (`getSiteHandler` / `executeSiteHandler` with the `pasteText` handler), polls the VT-reconstructed screen until the answer is stable, extracts the `ANSWER:` line + explanation, appends to the Markdown file, and archives raw renders to `C:\tmp\exam-raw\qNN.txt`. Resumes from already-answered questions on restart. |
| `start-exam.ps1` | Wrapper that launches the runner detached in the background (direct `Start-Process` from the tool shell silently fails to spawn; a `.ps1` file works). Paths are relative to this directory. |

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
# foreground, positional args: <source.txt> <output.md> <progress.log>
node exam-runner.mjs "C:\Users\thinkpad\Downloads\infer\exam2.txt" "c:\tmp\exam2answer.md" "C:\tmp\exam2-progress.log"

# background (recommended for a full 52-question run, ~40-50s/question)
powershell -ExecutionPolicy Bypass -File start-exam.ps1

# monitor
Get-Content C:\tmp\exam2-progress.log -Tail 20
```

With no args, defaults to exam1 paths (`exam1.txt` -> `c:\tmp\exam1answer.md`).

## Exam input format

```
单选题 / 多选题
第N/52题
<question stem>
<option lines, may contain multi-line code blocks>
```

Blocks are split on lines starting with `单选题`/`多选题`; duplicate question numbers are de-duplicated (exam1 has a duplicated Q10).

## Answer extraction

- Prompt prepends an instruction asking for a brief explanation then a final `ANSWER: X` line.
- The echoed question's final option line is located in the scrollback (exact full-line match preferred, then substring fallback); everything after it is the answer body.
- Noise lines are stripped: `ASK glm-*`, `huawei-inner-provider`, `Thinking...`, `Tab to accept`, `enter send`, `esc cancel`, `ctrl+c quit`, spinner frames, box-drawing borders.
- `ANSWER:` letter(s) go to the `**答案：**` field; the cleaned explanation goes into a collapsible `<details>` block.
- Completion = answer text stable across consecutive polls while `esc cancel` is absent (Q1 capture time dropped from a 302 s timeout to ~14 s vs the old DOM approach).

## Results so far

| Exam | File | Questions | Errors | Notes |
|---|---|---|---|---|
| exam1 (昇腾推理) | `c:\tmp\exam1answer.md` | 52/52 | 0 | 41 single + 11 multi |
| exam2 (算子开发认证) | `c:\tmp\exam2answer.md` | in progress | – | handles multi-line ` ```cpp ` options |

## Gotchas

- Site handler config is cached in `chrome.storage.local.remoteSiteHandlers`; after editing `siteHandlers.json`, clear that key and reload the extension or stale steps keep running.
- `executeSiteHandler` must run in the extension **isolated world** (context origin `chrome-extension://...`, usually contextId 2), not the page's main world.
- xterm ignores synthetic `input` events / `.value` writes; the extension's `pasteText` action (ClipboardEvent with a DataTransfer) is what works, including multiline text.
