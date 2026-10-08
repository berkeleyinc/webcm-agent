// Terminal emulator for guest output.
//
// The guest is driven through a tty, so its output is a stream of ANSI/VT
// sequences (prompts, colours, cursor moves, and - for interactive programs -
// full-screen redraws). We keep two representations:
//
//   * `screen`  - a live 2D character grid with cursor + current SGR state,
//                 used to read the *current* screen (e.g. a TUI, or the text
//                 next to the prompt).
//   * `log`     - an append-only, ANSI-stripped transcript, used to read back
//                 what a command printed after the fact.
//
// It is deliberately small: enough CSI coverage for ash/nvim/top/htop-style
// output, no scrollback of the grid.

const ESC = 0x1b;

const DEFAULT_ATTR = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };

const COLOR_16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
const COLOR_256 = (() => {
  const table = COLOR_16.slice();
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        table.push(`rgb(${r ? r * 40 + 55 : 0},${g ? g * 40 + 55 : 0},${b ? b * 40 + 55 : 0})`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    table.push(`rgb(${v},${v},${v})`);
  }
  return table;
})();

export class Terminal {
  constructor({ cols = 120, rows = 30, maxLogChars = 512 * 1024 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.maxLogChars = maxLogChars;
    this.screen = makeGrid(rows, cols);
    this.row = 0;
    this.col = 0;
    this.attr = { ...DEFAULT_ATTR };
    this.log = '';
    this.logTruncated = 0;
    this.totalChars = 0;
    this.partial = '';
    this.osc = null;
    this.savedCursor = { row: 0, col: 0 };
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
  }

  get lastLogLine() {
    const idx = this.log.lastIndexOf('\n');
    return this.log.slice(idx + 1);
  }

  setSize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    const newScreen = makeGrid(rows, cols);
    for (let r = 0; r < Math.min(rows, this.screen.length); r++) {
      for (let c = 0; c < Math.min(cols, this.cols); c++) {
        newScreen[r][c] = this.screen[r][c];
      }
    }
    this.screen = newScreen;
    this.cols = cols;
    this.rows = rows;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, cols - 1);
  }

  /** Feed raw bytes (Uint8Array or string). */
  write(data) {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.totalChars += text.length;
    const input = this.partial + text;
    this.partial = '';
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      const code = input.charCodeAt(i);
      if (ch === '\u001b') {
        const consumed = this.consumeEscape(input, i);
        if (consumed < 0) {
          // incomplete sequence - wait for more input
          this.partial = input.slice(i);
          return;
        }
        i += consumed;
        continue;
      }
      if (code === 0x0d) {
        this.col = 0;
        // Keep the CR in the transcript: the guest turns on ONLCR, so its output
        // is CRLF, and the transcript is replayed verbatim into a fresh client's
        // terminal (which needs the CR to return to column 0).
        this.appendLog('\r');
        i++;
        continue;
      }
      if (code === 0x0a) {
        this.lineFeed();
        i++;
        continue;
      }
      if (code === 0x08) {
        if (this.col > 0) this.col--;
        i++;
        continue;
      }
      if (code === 0x09) {
        const next = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        while (this.col < next) this.putChar(' ');
        i++;
        continue;
      }
      if (code === 0x07) {
        i++;
        continue;
      }
      if (code < 0x20) {
        i++;
        continue;
      }
      // Possibly a surrogate pair
      let char = ch;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
        char = input.slice(i, i + 2);
        i += 2;
      } else {
        i++;
      }
      this.putChar(char);
    }
  }

  consumeEscape(input, start) {
    const next = input[start + 1];
    if (next === undefined) return -1;
    if (next === '[') return this.consumeCsi(input, start);
    if (next === ']') return this.consumeOsc(input, start);
    if (next === '(' || next === ')' || next === '*' || next === '+' || next === '-' || next === '.') {
      if (input[start + 2] === undefined) return -1;
      return 3;
    }
    if (next === 'M') {
      // reverse index
      this.reverseIndex();
      return 2;
    }
    if (next === 'D') {
      this.lineFeed();
      return 2;
    }
    if (next === 'E') {
      this.col = 0;
      this.lineFeed();
      return 2;
    }
    if (next === '7') {
      this.savedCursor = { row: this.row, col: this.col };
      return 2;
    }
    if (next === '8') {
      this.row = this.savedCursor.row;
      this.col = this.savedCursor.col;
      return 2;
    }
    if (next === 'c') {
      this.reset();
      return 2;
    }
    return 2;
  }

  consumeCsi(input, start) {
    // ESC [ params intermediates final
    let i = start + 2;
    let params = '';
    while (i < input.length) {
      const c = input[i];
      const code = input.charCodeAt(i);
      if (code >= 0x30 && code <= 0x3f) {
        params += c;
        i++;
        continue;
      }
      if (code >= 0x20 && code <= 0x2f) {
        i++;
        continue;
      }
      break;
    }
    if (i >= input.length) return -1;
    const final = input[i];
    this.applyCsi(params, final);
    return i - start + 1;
  }

  consumeOsc(input, start) {
    // ESC ] ... BEL   or   ESC ] ... ESC \
    for (let i = start + 2; i < input.length; i++) {
      const c = input[i];
      if (c === '\u0007') return i - start + 1;
      if (c === '\u001b' && input[i + 1] === '\\') return i - start + 2;
      if (c === '\u001b' && input[i + 1] === undefined) return -1;
    }
    return -1;
  }

  applyCsi(params, final) {
    const nums = params
      .split(';')
      .map((p) => (p === '' ? null : Number(p)))
      .filter((n) => n === null || Number.isFinite(n));
    const p = (idx, dflt = 0) => {
      const v = nums[idx];
      return v === null || v === undefined ? dflt : v;
    };
    switch (final) {
      case 'A': this.row = clamp(this.row - Math.max(1, p(0, 1)), 0, this.rows - 1); break;
      case 'B': this.row = clamp(this.row + Math.max(1, p(0, 1)), 0, this.rows - 1); break;
      case 'C': this.col = clamp(this.col + Math.max(1, p(0, 1)), 0, this.cols - 1); break;
      case 'D': this.col = clamp(this.col - Math.max(1, p(0, 1)), 0, this.cols - 1); break;
      case 'E': this.row = clamp(this.row + Math.max(1, p(0, 1)), 0, this.rows - 1); this.col = 0; break;
      case 'F': this.row = clamp(this.row - Math.max(1, p(0, 1)), 0, this.rows - 1); this.col = 0; break;
      case 'G': this.col = clamp(p(0, 1) - 1, 0, this.cols - 1); break;
      case 'H':
      case 'f':
        this.row = clamp(p(0, 1) - 1, 0, this.rows - 1);
        this.col = clamp(p(1, 1) - 1, 0, this.cols - 1);
        break;
      case 'd': this.row = clamp(p(0, 1) - 1, 0, this.rows - 1); break;
      case 'J': this.eraseDisplay(p(0, 0)); break;
      case 'K': this.eraseLine(p(0, 0)); break;
      case 'L': this.insertLines(Math.max(1, p(0, 1))); break;
      case 'M': this.deleteLines(Math.max(1, p(0, 1))); break;
      case 'P': this.deleteChars(Math.max(1, p(0, 1))); break;
      case '@': this.insertChars(Math.max(1, p(0, 1))); break;
      case 'X': this.eraseChars(Math.max(1, p(0, 1))); break;
      case 'S': for (let n = 0; n < Math.max(1, p(0, 1)); n++) this.scrollUp(); break;
      case 'T': for (let n = 0; n < Math.max(1, p(0, 1)); n++) this.scrollDown(); break;
      case 'm': this.applySgr(params, nums); break;
      case 'r':
        this.scrollTop = clamp(p(0, 1) - 1, 0, this.rows - 1);
        this.scrollBottom = clamp(p(1, this.rows) - 1, this.scrollTop, this.rows - 1);
        this.row = this.scrollTop;
        this.col = 0;
        break;
      case 's': this.savedCursor = { row: this.row, col: this.col }; break;
      case 'u': this.row = this.savedCursor.row; this.col = this.savedCursor.col; break;
      case 'h':
        break; // modes (DEC private / insert) - cosmetic for our purposes
      case 'l':
        break;
      case 'n':
        break; // device status report
      default:
        break;
    }
  }

  applySgr(params, nums) {
    if (params === '' || params === '0') {
      this.attr = { ...DEFAULT_ATTR };
      return;
    }
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      if (n === null) continue;
      switch (n) {
        case 0: this.attr = { ...DEFAULT_ATTR }; break;
        case 1: this.attr.bold = true; break;
        case 2: this.attr.dim = true; break;
        case 3: this.attr.italic = true; break;
        case 4: this.attr.underline = true; break;
        case 7: this.attr.inverse = true; break;
        case 22: this.attr.bold = false; this.attr.dim = false; break;
        case 23: this.attr.italic = false; break;
        case 24: this.attr.underline = false; break;
        case 27: this.attr.inverse = false; break;
        case 39: this.attr.fg = null; break;
        case 49: this.attr.bg = null; break;
        default:
          if (n >= 30 && n <= 37) this.attr.fg = COLOR_16[n - 30];
          else if (n >= 40 && n <= 47) this.attr.bg = COLOR_16[n - 40];
          else if (n >= 90 && n <= 97) this.attr.fg = COLOR_16[n - 90 + 8];
          else if (n >= 100 && n <= 107) this.attr.bg = COLOR_16[n - 100 + 8];
          else if (n === 38 || n === 48) {
            const target = n === 38 ? 'fg' : 'bg';
            const mode = nums[i + 1];
            if (mode === 5) {
              this.attr[target] = COLOR_256[nums[i + 2] ?? 0] || null;
              i += 2;
            } else if (mode === 2) {
              this.attr[target] = `rgb(${nums[i + 2] ?? 0},${nums[i + 3] ?? 0},${nums[i + 4] ?? 0})`;
              i += 4;
            }
          }
          break;
      }
    }
  }

  putChar(char) {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.screen[this.row][this.col] = { ch: char, attr: this.attr };
    this.col++;
    this.appendLog(char);
  }

  appendLog(char) {
    this.log += char;
    if (this.log.length > this.maxLogChars) {
      const cut = this.log.length - this.maxLogChars;
      this.log = this.log.slice(cut);
      this.logTruncated += cut;
    }
  }

  lineFeed() {
    this.appendLog('\n');
    if (this.row === this.scrollBottom) {
      this.scrollUp();
    } else {
      this.row = Math.min(this.rows - 1, this.row + 1);
    }
  }

  reverseIndex() {
    if (this.row === this.scrollTop) this.scrollDown();
    else this.row = Math.max(0, this.row - 1);
  }

  scrollUp() {
    const removed = this.screen.splice(this.scrollTop, 1)[0];
    this.screen.splice(this.scrollBottom, 0, makeRow(this.cols));
    return removed;
  }

  scrollDown() {
    const removed = this.screen.splice(this.scrollBottom, 1)[0];
    this.screen.splice(this.scrollTop, 0, makeRow(this.cols));
    return removed;
  }

  insertLines(n) {
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.row, 0, makeRow(this.cols));
      this.screen.splice(this.scrollBottom + 1, 1);
    }
  }

  deleteLines(n) {
    for (let i = 0; i < n; i++) {
      this.screen.splice(this.row, 1);
      this.screen.splice(this.scrollBottom, 0, makeRow(this.cols));
    }
  }

  insertChars(n) {
    const row = this.screen[this.row];
    for (let i = 0; i < n; i++) {
      row.splice(this.col, 0, blankCell());
      row.length = this.cols;
    }
  }

  deleteChars(n) {
    const row = this.screen[this.row];
    row.splice(this.col, n);
    while (row.length < this.cols) row.push(blankCell());
  }

  eraseChars(n) {
    const row = this.screen[this.row];
    for (let i = this.col; i < Math.min(this.cols, this.col + n); i++) row[i] = blankCell();
  }

  eraseLine(mode) {
    const row = this.screen[this.row];
    if (mode === 0) for (let c = this.col; c < this.cols; c++) row[c] = blankCell();
    else if (mode === 1) for (let c = 0; c <= this.col; c++) row[c] = blankCell();
    else if (mode === 2) for (let c = 0; c < this.cols; c++) row[c] = blankCell();
  }

  eraseDisplay(mode) {
    if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.rows; r++) this.screen[r] = makeRow(this.cols);
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let r = 0; r < this.row; r++) this.screen[r] = makeRow(this.cols);
    } else {
      for (let r = 0; r < this.rows; r++) this.screen[r] = makeRow(this.cols);
    }
  }

  reset() {
    this.screen = makeGrid(this.rows, this.cols);
    this.row = 0;
    this.col = 0;
    this.attr = { ...DEFAULT_ATTR };
  }

  /** Render the current screen grid as plain text. */
  screenText({ trimRight = true, maxRows = this.rows } = {}) {
    const lines = [];
    const last = Math.min(this.rows, maxRows);
    for (let r = 0; r < last; r++) {
      let line = '';
      for (let c = 0; c < this.cols; c++) line += this.screen[r][c].ch;
      lines.push(trimRight ? line.replace(/\s+$/, '') : line);
    }
    return lines.join('\n');
  }

  /** Last `maxChars` of the stripped transcript. */
  logText(maxChars = 8000) {
    if (this.log.length <= maxChars) return this.log;
    return this.log.slice(this.log.length - maxChars);
  }

  /** Strip ANSI again from the log (log already has sequences removed). */
  get cursor() {
    return { row: this.row, col: this.col, cols: this.cols, rows: this.rows };
  }
}

export function stripAnsi(text) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

function makeRow(cols) {
  return Array.from({ length: cols }, blankCell);
}

function makeGrid(rows, cols) {
  return Array.from({ length: rows }, () => makeRow(cols));
}

function blankCell() {
  return { ch: ' ', attr: DEFAULT_ATTR };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
