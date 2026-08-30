import { Term } from './vt.mjs';

// Unit tests for the transcript capture in vt.mjs. The critical case is a
// full-pane repaint: aishell sometimes redraws every row in place instead of
// scrolling, and a scrollback-only emulator loses whatever never reached the
// top of the screen.

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
}
function checkFn(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  console.log(`FAIL ${name}${detail ? '\n  ' + detail : ''}`);
}

const CUP = (r, c = 1) => `\x1b[${r};${c}H`;
const trimmed = t => t.allLines().filter(l => l.trim());

// 1. plain scrolling still works
{
  const t = new Term(20, 4);
  for (let i = 1; i <= 8; i++) t.write(`line${i}\r\n`);
  check('scroll keeps all lines', trimmed(t), ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8']);
}

// 2. full-pane repaint that shifts content up by one row without scrolling:
//    the row pushed off the top must survive, and nothing may be duplicated
{
  const t = new Term(20, 4);
  t.write(CUP(1) + '\x1b[2J');
  const paint = ls => {
    let s = '';
    ls.forEach((l, i) => { s += CUP(i + 1) + '\x1b[2K' + l; });
    t.write(s);
  };
  paint(['A1', 'A2', 'A3', 'A4']);
  paint(['A2', 'A3', 'A4', 'A5']);
  paint(['A3', 'A4', 'A5', 'A6']);
  check('repaint shift keeps history', trimmed(t), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
}

// 3. a streaming line that grows in place must update, not duplicate
{
  const t = new Term(40, 3);
  t.write(CUP(1) + '\x1b[2K' + 'MindSpore 支持');
  t.write(CUP(1) + '\x1b[2K' + 'MindSpore 支持两种编程范式');
  t.write(CUP(1) + '\x1b[2K' + 'MindSpore 支持两种编程范式：');
  check('growing line updates in place', trimmed(t), ['MindSpore 支持两种编程范式：']);
}

// 4. spinner rewriting the same row must not append an entry per frame
{
  const t = new Term(20, 3);
  for (const f of ['|', '/', '-', '\\', '|', '/']) t.write(CUP(2) + '\x1b[2K' + '  ' + f + ' Thinking');
  checkFn('spinner does not grow transcript', t.allLines().length <= 4, 'len=' + t.allLines().length);
}

// 5. erase-in-display below cursor then rewrite: the replaced region is NOT
//    resurrected. This mirrors what the terminal displays, and matters because
//    erase-below-then-redraw is exactly how a TUI repaints a region; preserving
//    the old rows would duplicate every repainted paragraph.
{
  const t = new Term(20, 4);
  t.write('keep1\r\nkeep2\r\nold3\r\nold4');
  t.write(CUP(3) + '\x1b[J' + 'new3\r\nnew4');
  check('ED below cursor replaces region', trimmed(t), ['keep1', 'keep2', 'new3', 'new4']);
}

// 5b. a paragraph re-rendered in place (re-wrapped as more text streams in)
//     is recognised as the same lines, not appended as new ones
{
  const t = new Term(40, 4);
  t.write(CUP(1) + '\x1b[2J' + 'MindSpore 支持两种\r\n编程范式');
  t.write(CUP(1) + '\x1b[2J' + 'MindSpore 支持两种编程范式并允许\r\n融合使用：');
  check('re-wrapped paragraph updates', trimmed(t), ['MindSpore 支持两种编程范式并允许', '融合使用：']);
}

// 6. reverse index / CSI L inserting a line keeps visual order
{
  const t = new Term(20, 4);
  t.write('r1\r\nr2\r\nr3');
  t.write(CUP(2) + '\x1b[L' + 'ins');
  const v = t.visibleLines().filter(l => l.trim());
  check('insertLines visible order', v, ['r1', 'ins', 'r2', 'r3']);
}

// 7. visibleLines still reflects only the 28-row viewport
{
  const t = new Term(20, 4);
  for (let i = 1; i <= 10; i++) t.write(`v${i}\r\n`);
  checkFn('visibleLines is viewport sized', t.visibleLines().length === 4, 'len=' + t.visibleLines().length);
}

// 8. an answer longer than the screen, delivered as a repainting pager, is
//    fully recoverable — the regression that dropped ~12 lines from Q39
{
  const rows = 6;
  const t = new Term(30, rows);
  const answer = Array.from({ length: 20 }, (_, i) => `ans${String(i + 1).padStart(2, '0')}`);
  for (let end = 1; end <= answer.length; end++) {
    const win = answer.slice(Math.max(0, end - rows), end);
    let s = '';
    for (let r = 0; r < rows; r++) s += CUP(r + 1) + '\x1b[2K' + (win[r] || '');
    t.write(s);
  }
  check('paged repaint recovers full answer', trimmed(t), answer);
}

console.log(`vt tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
