// Minimal VT100/xterm screen emulator with transcript capture.
// Handles the escape-sequence set observed on the aishell terminal stream.
//
// Capture model
// -------------
// A naive emulator only preserves a row once it scrolls off the top of the
// screen. aishell does not always scroll: on a fast response it repaints the
// pane, redrawing every row in place, so rows that never reach the top are lost.
// That is how a 22 s Q39 capture dropped ~12 lines out of the middle of an
// otherwise complete answer.
//
// Instead of a scrollback list, this emulator keeps an append-only `transcript`
// and reconciles it against the screen after every write (and before every
// scroll, so bulk scrolls inside one frame cannot skip rows). Reconciliation
// aligns the current screen against the transcript tail, scoring candidate
// offsets, then splices the screen in at the best-scoring offset. Rows that
// merely moved are recognised and reused; rows carrying new text are appended.
// This covers plain scrolling, whole-pane repaints, pager-style redraws and
// a line growing in place as it streams.

const SEARCH_SCREENFULS = 3;   // how far back to look for an alignment offset
const SIMILAR_RATIO = 0.6;     // shared head+tail fraction meaning "same line redrawn"
const MIN_RUN = 2;             // aligned rows required before trusting an offset
const MIN_SIMILAR_LEN = 12;    // shorter rows must match exactly to count as the same line

function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // combining marks
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  // East Asian Wide / Fullwidth
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

// Same logical line redrawn: one side extended the other (a line growing as it
// streams), or they share most of their head and tail (a spinner frame, a
// changed counter). The length guard matters — without it "line1" and "line5"
// look 80% identical and a scrolled screen would align against the wrong row.
function sameLine(a, b) {
  if (!a || !b) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (Math.max(a.length, b.length) < MIN_SIMILAR_LEN) return false;
  const n = Math.min(a.length, b.length);
  let head = 0;
  while (head < n && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return (head + tail) / Math.max(a.length, b.length) >= SIMILAR_RATIO;
}

export class Term {
  constructor(cols = 80, rows = 28) {
    this.cols = cols;
    this.rows = rows;
    this.x = 0;
    this.y = 0;
    this.top = 0;
    this.bot = rows - 1;
    this.saved = null;
    this.screen = Array.from({ length: rows }, () => this.blankLine());
    this.transcript = [];
  }

  blankLine() { return new Array(this.cols).fill(' '); }

  lineToString(arr) { return arr.join('').replace(/\s+$/, ''); }

  // ---- transcript reconciliation ----

  // Screen rows with trailing blank rows dropped: a half-filled screen must not
  // pad the transcript with blanks, or the next alignment cannot match.
  screenLines() {
    const v = this.screen.map(l => this.lineToString(l));
    while (v.length && !v[v.length - 1].trim()) v.pop();
    return v;
  }

  scoreAt(off, v) {
    // Length of the run of rows that line up starting at `off`. A run is what
    // identifies "the screen still shows this part of the transcript"; the first
    // mismatch ends it, and everything from there on is the screen's own text.
    const overlap = Math.min(v.length, this.transcript.length - off);
    let run = 0, exact = 0, headGrew = false;
    for (let i = 0; i < overlap; i++) {
      const a = this.transcript[off + i], b = v[i];
      if (a === b) exact++;
      else if (sameLine(a, b)) { if (i === 0 && b.startsWith(a) && a.trim()) headGrew = true; }
      else break;
      run++;
    }
    return { run, exact, overlap, headGrew };
  }

  // Reconcile the screen into the transcript: find where the screen's top row
  // sits in the transcript tail, keep everything above it, and let the screen
  // supply everything from there on. Rows that merely moved up during a repaint
  // are recognised by the alignment instead of being appended again, which is
  // what stops an in-place repaint from either losing or duplicating content.
  commit() {
    const v = this.screenLines();
    if (!v.length) return;
    const L = this.transcript.length;
    if (!L) { this.transcript = v; return; }

    // Candidate offsets: where the screen's first row sits in the transcript.
    // Only the recent tail is searched, so a repeated line far back in a long
    // answer cannot drag the alignment backwards.
    const from = Math.max(0, L - SEARCH_SCREENFULS * this.rows);
    let bestOff = -1, bestRun = 0, bestExact = -1;
    for (let off = L - 1; off >= from; off--) {
      const { run, exact, overlap, headGrew } = this.scoreAt(off, v);
      if (run === 0) continue;
      // A short run is only trustworthy when it covers everything available (the
      // whole screen, or the whole remaining transcript tail), or when the
      // screen's top row is visibly a longer rendering of the transcript row —
      // a paragraph being re-wrapped as more text streams in.
      if (run < MIN_RUN && run < v.length && run < overlap && !headGrew) continue;
      if (run > bestRun || (run === bestRun && exact > bestExact)) {
        bestRun = run; bestExact = exact; bestOff = off;
      }
    }

    // No alignment: the screen shows something new, so append it wholesale.
    if (bestOff < 0) { this.transcript = this.transcript.concat(v); return; }
    this.transcript = this.transcript.slice(0, bestOff).concat(v);
  }

  // ---- screen operations ----

  // Rows leaving at `top` disappear for good, so the screen is committed before
  // every upward shift; a burst that scrolls more than one screenful inside a
  // single frame therefore cannot skip content.
  shiftUp(top, bot, n) {
    for (let i = 0; i < n; i++) {
      if (top === 0) this.commit();
      this.screen.splice(top, 1);
      this.screen.splice(bot, 0, this.blankLine());
    }
  }

  shiftDown(top, bot, n) {
    for (let i = 0; i < n; i++) {
      this.screen.splice(bot, 1);
      this.screen.splice(top, 0, this.blankLine());
    }
  }

  scrollUp(n = 1) { this.shiftUp(this.top, this.bot, n); }
  scrollDown(n = 1) { this.shiftDown(this.top, this.bot, n); }

  lineFeed() {
    if (this.y === this.bot) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
  }

  reverseIndex() {
    if (this.y === this.top) this.scrollDown(1);
    else if (this.y > 0) this.y--;
  }

  put(ch, w) {
    if (this.x >= this.cols) { this.x = 0; this.lineFeed(); }
    const line = this.screen[this.y];
    line[this.x] = ch;
    for (let i = 1; i < w; i++) if (this.x + i < this.cols) line[this.x + i] = '';
    this.x += w;
  }

  eraseInLine(mode) {
    // Clearing the top row starts a fresh repaint pass, so the screen still
    // holds the completed previous frame: snapshot it now, otherwise a single
    // WS frame containing several repaint passes would only yield its last one.
    // Mid-pane clears must NOT commit — the screen is half-updated there and
    // aligning against it would truncate the transcript.
    if (mode === 2 && this.y === 0) this.commit();
    const line = this.screen[this.y];
    if (mode === 0) for (let i = this.x; i < this.cols; i++) line[i] = ' ';
    else if (mode === 1) for (let i = 0; i <= this.x && i < this.cols; i++) line[i] = ' ';
    else for (let i = 0; i < this.cols; i++) line[i] = ' ';
  }

  eraseInDisplay(mode) {
    // Whole regions are about to be discarded without scrolling.
    this.commit();
    if (mode === 0) {
      for (let i = this.x; i < this.cols; i++) this.screen[this.y][i] = ' ';
      for (let r = this.y + 1; r < this.rows; r++) this.screen[r] = this.blankLine();
    } else if (mode === 1) {
      for (let i = 0; i <= this.x && i < this.cols; i++) this.screen[this.y][i] = ' ';
      for (let r = 0; r < this.y; r++) this.screen[r] = this.blankLine();
    } else {
      for (let r = 0; r < this.rows; r++) this.screen[r] = this.blankLine();
    }
  }

  eraseChars(n) {
    const line = this.screen[this.y];
    for (let i = 0; i < n && this.x + i < this.cols; i++) line[this.x + i] = ' ';
  }

  insertLines(n) {
    if (this.y < this.top || this.y > this.bot) return;
    this.shiftDown(this.y, this.bot, n);
  }

  deleteLines(n) {
    if (this.y < this.top || this.y > this.bot) return;
    this.shiftUp(this.y, this.bot, n);
  }

  write(str) {
    const s = str;
    let i = 0;
    const N = s.length;
    while (i < N) {
      const c = s[i];
      if (c === '\x1b') {
        const next = s[i + 1];
        if (next === '[') {
          // CSI
          let j = i + 2;
          let priv = '';
          if ('?<>!'.includes(s[j])) { priv = s[j]; j++; }
          let params = '';
          while (j < N && /[0-9;]/.test(s[j])) { params += s[j]; j++; }
          if (j >= N) break;
          const fin = s[j];
          const nums = params.split(';').map(p => (p === '' ? NaN : parseInt(p, 10)));
          const p0 = Number.isNaN(nums[0]) ? undefined : nums[0];
          if (!priv) {
            switch (fin) {
              case 'A': this.y = Math.max(this.top, this.y - (p0 || 1)); break;
              case 'B': this.y = Math.min(this.bot, this.y + (p0 || 1)); break;
              case 'C': this.x = Math.min(this.cols - 1, this.x + (p0 || 1)); break;
              case 'D': this.x = Math.max(0, this.x - (p0 || 1)); break;
              case 'E': this.y = Math.min(this.bot, this.y + (p0 || 1)); this.x = 0; break;
              case 'F': this.y = Math.max(this.top, this.y - (p0 || 1)); this.x = 0; break;
              case 'G': case '`': this.x = Math.max(0, Math.min(this.cols - 1, (p0 || 1) - 1)); break;
              case 'd': this.y = Math.max(0, Math.min(this.rows - 1, (p0 || 1) - 1)); break;
              case 'H': case 'f': {
                const r = (Number.isNaN(nums[0]) ? 1 : nums[0]) || 1;
                const cc = (Number.isNaN(nums[1]) ? 1 : nums[1]) || 1;
                this.y = Math.max(0, Math.min(this.rows - 1, r - 1));
                this.x = Math.max(0, Math.min(this.cols - 1, cc - 1));
                break;
              }
              case 'J': this.eraseInDisplay(p0 || 0); break;
              case 'K': this.eraseInLine(p0 || 0); break;
              case 'X': this.eraseChars(p0 || 1); break;
              case 'L': this.insertLines(p0 || 1); break;
              case 'M': this.deleteLines(p0 || 1); break;
              case 'S': this.scrollUp(p0 || 1); break;
              case 'T': this.scrollDown(p0 || 1); break;
              case 'P': {
                const n = p0 || 1;
                const line = this.screen[this.y];
                line.splice(this.x, n);
                while (line.length < this.cols) line.push(' ');
                break;
              }
              case '@': {
                const n = p0 || 1;
                const line = this.screen[this.y];
                for (let k = 0; k < n; k++) line.splice(this.x, 0, ' ');
                line.length = this.cols;
                break;
              }
              case 'r': {
                const t = (Number.isNaN(nums[0]) ? 1 : nums[0]) || 1;
                const b = Number.isNaN(nums[1]) ? this.rows : nums[1];
                this.top = Math.max(0, t - 1);
                this.bot = Math.min(this.rows - 1, b - 1);
                this.x = 0; this.y = this.top;
                break;
              }
              case 's': this.saved = { x: this.x, y: this.y }; break;
              case 'u': if (this.saved) { this.x = this.saved.x; this.y = this.saved.y; } break;
              default: break; // m, h, l, n, t, etc. -> ignore
            }
          }
          i = j + 1;
          continue;
        }
        if (next === ']' || next === 'P' || next === '^' || next === '_') {
          // OSC / DCS / PM / APC -> consume to BEL or ST
          let j = i + 2;
          while (j < N) {
            if (s[j] === '\x07') { j++; break; }
            if (s[j] === '\x1b' && s[j + 1] === '\\') { j += 2; break; }
            j++;
          }
          i = j;
          continue;
        }
        if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#' || next === '%') { i += 3; continue; }
        if (next === 'M') { this.reverseIndex(); i += 2; continue; }
        if (next === 'D') { this.lineFeed(); i += 2; continue; }
        if (next === 'E') { this.lineFeed(); this.x = 0; i += 2; continue; }
        if (next === '7') { this.saved = { x: this.x, y: this.y }; i += 2; continue; }
        if (next === '8') { if (this.saved) { this.x = this.saved.x; this.y = this.saved.y; } i += 2; continue; }
        if (next === 'c') { i += 2; continue; }
        i += 2;
        continue;
      }
      if (c === '\r') { this.x = 0; i++; continue; }
      if (c === '\n' || c === '\x0b' || c === '\x0c') { this.lineFeed(); i++; continue; }
      if (c === '\b') { this.x = Math.max(0, this.x - 1); i++; continue; }
      if (c === '\t') { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); i++; continue; }
      if (c === '\x07') { i++; continue; }
      if (c < ' ') { i++; continue; }

      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      this.put(ch, charWidth(cp));
    }
    this.commit();
  }

  visibleLines() { return this.screen.map(l => this.lineToString(l)); }

  allLines() { return this.transcript.slice(); }
}
