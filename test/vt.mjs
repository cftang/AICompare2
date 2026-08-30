// Minimal VT100/xterm screen emulator with scrollback capture.
// Handles the escape-sequence set observed on the aishell terminal stream.

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

export class Term {
  constructor(cols = 80, rows = 28) {
    this.cols = cols;
    this.rows = rows;
    this.x = 0;
    this.y = 0;
    this.top = 0;
    this.bot = rows - 1;
    this.saved = null;
    this.scrollback = [];
    this.screen = Array.from({ length: rows }, () => this.blankLine());
  }

  blankLine() { return new Array(this.cols).fill(' '); }

  lineToString(arr) {
    return arr.join('').replace(/\s+$/, '');
  }

  scrollUp(n = 1) {
    for (let i = 0; i < n; i++) {
      const gone = this.screen.splice(this.top, 1)[0];
      // only the true top of the screen leaves the visible area into history
      if (this.top === 0) this.scrollback.push(this.lineToString(gone));
      this.screen.splice(this.bot, 0, this.blankLine());
    }
  }

  scrollDown(n = 1) {
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.bot, 1);
      this.screen.splice(this.top, 0, this.blankLine());
    }
  }

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
    const line = this.screen[this.y];
    if (mode === 0) for (let i = this.x; i < this.cols; i++) line[i] = ' ';
    else if (mode === 1) for (let i = 0; i <= this.x && i < this.cols; i++) line[i] = ' ';
    else for (let i = 0; i < this.cols; i++) line[i] = ' ';
  }

  eraseInDisplay(mode) {
    if (mode === 0) {
      this.eraseInLine(0);
      for (let r = this.y + 1; r < this.rows; r++) this.screen[r] = this.blankLine();
    } else if (mode === 1) {
      this.eraseInLine(1);
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
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.bot, 1);
      this.screen.splice(this.y, 0, this.blankLine());
    }
  }

  deleteLines(n) {
    if (this.y < this.top || this.y > this.bot) return;
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.y, 1);
      this.screen.splice(this.bot, 0, this.blankLine());
    }
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
  }

  visibleLines() { return this.screen.map(l => this.lineToString(l)); }

  allLines() { return this.scrollback.concat(this.visibleLines()); }
}
