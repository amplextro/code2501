import { useState, useRef, useEffect, useCallback, useMemo } from "react";

// ─── Constants ───
const ROWS = 16;
const SYNC_COLS = 2;
const BYTELEN_COLS = 1;
const DATA_COLS = 8;
const PARITY_COLS = 2;
const CHAR_GLYPH_WIDTH = SYNC_COLS + BYTELEN_COLS + DATA_COLS + PARITY_COLS; // 13
const FINDER_COLS = 8;
const HEADER_COLS = 16;
const START_WIDTH = SYNC_COLS + FINDER_COLS + HEADER_COLS; // 26
const STOP_WIDTH = START_WIDTH; // 26

// ─── Finder Pattern (8x16) ───
const FINDER_PATTERN = (() => {
  const p = Array.from({ length: ROWS }, () => Array(FINDER_COLS).fill(0));
  // Top half: solid border box with inner square
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (r === 0 || r === 5)
        p[r][c] = 1; // top/bottom border
      else if (r >= 1 && r <= 4) {
        if (c === 0 || c === 7) p[r][c] = 1; // side borders
        if (r >= 2 && r <= 3 && c >= 2 && c <= 5) p[r][c] = 1; // inner
      }
      if (r === 6) p[r][c] = 0; // blank
      if (r === 7) p[r][c] = c % 2 === 0 ? 1 : 0; // clock
    }
  }
  // Bottom half: inverted
  for (let r = 8; r < 16; r++) {
    for (let c = 0; c < 8; c++) {
      p[r][c] = p[15 - r][c] === 1 ? 0 : 1;
    }
  }
  return p;
})();

// ─── UTF-8 encode a single codepoint ───
function utf8Encode(char) {
  const code = char.codePointAt(0);
  if (code <= 0x7f) return [code];
  if (code <= 0x7ff) return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)];
  if (code <= 0xffff)
    return [
      0xe0 | (code >> 12),
      0x80 | ((code >> 6) & 0x3f),
      0x80 | (code & 0x3f),
    ];
  return [
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f),
  ];
}

// ─── GF(2^8) primitive helpers for per-glyph RS ECC ───
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); // primitive poly x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  GF_LOG[0] = 0; // special case, never used in multiply
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a, b) {
  if (b === 0) throw new Error("GF divide by zero");
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255];
}

function gfPolyEval(poly, x) {
  let result = 0;
  for (let i = 0; i < poly.length; i++) {
    result = gfMul(result, x) ^ poly[i];
  }
  return result;
}

// Generate RS ECC symbols for given data bytes over GF(2^8)
function rsEncode(data, nsym) {
  // Generator polynomial: product of (x - α^i) for i=0..nsym-1
  const gen = new Uint8Array(nsym + 1);
  gen[0] = 1;
  for (let i = 0; i < nsym; i++) {
    for (let j = nsym; j > 0; j--) {
      gen[j] = gen[j - 1] ^ gfMul(gen[j], GF_EXP[i]);
    }
    gen[0] = gfMul(gen[0], GF_EXP[i]);
  }
  // Polynomial division
  const ecc = new Uint8Array(nsym);
  for (const d of data) {
    const coef = d ^ ecc[0];
    ecc.copyWithin(0, 1);
    ecc[nsym - 1] = 0;
    for (let j = 0; j < nsym; j++) {
      ecc[j] ^= gfMul(gen[j], coef);
    }
  }
  return ecc;
}

// RS decode: correct errors in-place, returns { corrected, errors } or null if uncorrectable
function rsDecode(message, nsym) {
  const n = message.length; // data + ecc

  // 1. Syndromes
  const synd = new Uint8Array(nsym);
  let hasError = false;
  for (let i = 0; i < nsym; i++) {
    synd[i] = gfPolyEval(message, GF_EXP[i]);
    if (synd[i] !== 0) hasError = true;
  }
  if (!hasError) return { corrected: message.slice(0, n - nsym), errors: 0 };

  // 2. Berlekamp-Massey
  let errLoc = [1];
  let oldLoc = [1];
  for (let i = 0; i < nsym; i++) {
    let delta = synd[i];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[i - j]);
    }
    oldLoc.push(0);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = oldLoc.map((v) => gfMul(v, delta));
        oldLoc = errLoc.map((v) => gfMul(v, gfDiv(1, delta)));
        errLoc = newLoc;
      }
      for (let j = 0; j < oldLoc.length; j++) {
        errLoc[errLoc.length - 1 - j] ^= gfMul(
          delta,
          oldLoc[oldLoc.length - 1 - j],
        );
      }
    }
  }

  const numErrors = errLoc.length - 1;
  if (numErrors * 2 > nsym) return null; // too many errors

  // 3. Chien search: find error positions
  const errPos = [];
  for (let i = 0; i < n; i++) {
    if (gfPolyEval(errLoc, GF_EXP[255 - i]) === 0) {
      errPos.push(n - 1 - i);
    }
  }
  if (errPos.length !== numErrors) return null; // couldn't locate all errors

  // 4. Forney algorithm: compute error magnitudes
  // Error evaluator polynomial = synd * errLoc mod x^nsym
  const syndPoly = [...synd].reverse();
  let errEval = [];
  for (let i = 0; i < nsym; i++) {
    let val = 0;
    for (let j = 0; j <= i; j++) {
      if (j < syndPoly.length && i - j < errLoc.length) {
        val ^= gfMul(syndPoly[j], errLoc[errLoc.length - 1 - (i - j)]);
      }
    }
    errEval.push(val);
  }
  // Formal derivative of error locator
  const errLocDeriv = [];
  for (let i = errLoc.length - 2; i >= 0; i -= 2) {
    errLocDeriv.push(errLoc[i]);
  }
  errLocDeriv.reverse();

  // Correct errors
  const corrected = new Uint8Array(message);
  for (const pos of errPos) {
    const xi = GF_EXP[255 - pos]; // X_i inverse
    const errEvalVal = gfPolyEval(errEval, xi);
    const errLocDerivVal = gfPolyEval(errLocDeriv, xi);
    if (errLocDerivVal === 0) return null;
    const magnitude = gfDiv(errEvalVal, errLocDerivVal);
    corrected[pos] ^= magnitude;
  }

  // Verify correction
  for (let i = 0; i < nsym; i++) {
    if (gfPolyEval(corrected, GF_EXP[i]) !== 0) return null;
  }

  return { corrected: corrected.slice(0, n - nsym), errors: numErrors };
}

// ─── Build a CHAR glyph (16 x 13) ───
function buildCharGlyph(char) {
  const grid = Array.from({ length: ROWS }, () =>
    Array(CHAR_GLYPH_WIDTH).fill(0),
  );
  const bytes = utf8Encode(char);
  const byteLen = bytes.length; // 1-4

  // Col 0-1: sync
  for (let r = 0; r < ROWS; r++) {
    grid[r][0] = 1;
    grid[r][1] = 0;
  }

  // Col 2: byte length flag (rows 0-1) + sync assist (rows 2-15)
  const lenBits = [(byteLen - 1) >> 1, (byteLen - 1) & 1];
  grid[0][2] = lenBits[0];
  grid[1][2] = lenBits[1];
  for (let r = 2; r < ROWS; r++) {
    grid[r][2] = r % 2 === 0 ? 1 : 0;
  }

  // Col 3-10: data bits (1 byte per row, MSB first)
  for (let b = 0; b < byteLen; b++) {
    for (let bit = 7; bit >= 0; bit--) {
      grid[b][3 + (7 - bit)] = (bytes[b] >> bit) & 1;
    }
  }

  // Rows byteLen..15: per-glyph RS ECC (fills the empty space)
  const eccRows = ROWS - byteLen; // 12~15 rows of ECC
  if (eccRows > 0) {
    const eccSymbols = rsEncode(bytes, eccRows);
    for (let i = 0; i < eccRows; i++) {
      const sym = eccSymbols[i];
      for (let bit = 7; bit >= 0; bit--) {
        grid[byteLen + i][3 + (7 - bit)] = (sym >> bit) & 1;
      }
    }
  }

  // Col 11-12: parity (XOR of data cols) — now covers data+ECC rows
  for (let r = 0; r < ROWS; r++) {
    let xor = 0;
    for (let c = 3; c <= 10; c++) {
      xor ^= grid[r][c];
    }
    grid[r][11] = xor;
    let xor2 = 0;
    for (let c = 3; c <= 10; c += 2) {
      xor2 ^= grid[r][c];
    }
    grid[r][12] = xor2;
  }

  return grid;
}

// ─── Build START glyph (16 x 18) ───
function buildStartGlyph(eccLevel = 1, eccInterval = 10) {
  const grid = Array.from({ length: ROWS }, () => Array(START_WIDTH).fill(0));

  // Sync
  for (let r = 0; r < ROWS; r++) {
    grid[r][0] = 1;
    grid[r][1] = 0;
  }

  // Finder pattern (col 2-9)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < FINDER_COLS; c++) {
      grid[r][2 + c] = FINDER_PATTERN[r][c];
    }
  }

  // Header (col 10-17): version(4) + eccLevel(2) + eccInterval(6) + reserved(20) + headerECC(96)
  const headerBits = [];
  // Version = 0
  headerBits.push(0, 0, 0, 0);
  // ECC Level
  headerBits.push((eccLevel >> 1) & 1, eccLevel & 1);
  // ECC Interval
  for (let i = 5; i >= 0; i--) headerBits.push((eccInterval >> i) & 1);
  // Reserved + ECC placeholder (fill remaining with pattern)
  while (headerBits.length < ROWS * HEADER_COLS) {
    headerBits.push(headerBits.length % 3 === 0 ? 1 : 0);
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < HEADER_COLS; c++) {
      grid[r][10 + c] = headerBits[r * HEADER_COLS + c] || 0;
    }
  }

  return grid;
}

// ─── Build STOP glyph (16 x 18) ───
function buildStopGlyph() {
  const grid = Array.from({ length: ROWS }, () => Array(STOP_WIDTH).fill(0));

  for (let r = 0; r < ROWS; r++) {
    grid[r][0] = 1;
    grid[r][1] = 0;
  }

  // Mirrored finder (col 2-9)
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < FINDER_COLS; c++) {
      grid[r][2 + c] = FINDER_PATTERN[r][FINDER_COLS - 1 - c];
    }
  }

  // Checksum placeholder (col 10-17): checkerboard
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < HEADER_COLS; c++) {
      grid[r][10 + c] = (r + c) % 2;
    }
  }

  return grid;
}

// ─── Build ECC glyph (placeholder) ───
function buildEccGlyph() {
  const width = SYNC_COLS + 1 + DATA_COLS + PARITY_COLS; // 13
  const grid = Array.from({ length: ROWS }, () => Array(width).fill(0));

  for (let r = 0; r < ROWS; r++) {
    grid[r][0] = 1;
    grid[r][1] = 0;
    grid[r][2] = 1; // ECC marker: all black
  }

  // RS symbols placeholder: diagonal stripe pattern
  for (let r = 0; r < ROWS; r++) {
    for (let c = 3; c < width - 2; c++) {
      grid[r][c] = (r + c) % 3 === 0 ? 1 : 0;
    }
    // parity cols
    grid[r][width - 2] = r % 2;
    grid[r][width - 1] = (r + 1) % 2;
  }

  return grid;
}

// ─── Encode full text ───
function encodeCode2501(text, eccInterval = 10, eccLevel = 1) {
  const glyphs = [];
  glyphs.push({ type: "START", grid: buildStartGlyph(eccLevel, eccInterval) });

  const chars = [...text]; // proper unicode iteration
  let charCount = 0;

  for (const ch of chars) {
    glyphs.push({ type: "CHAR", grid: buildCharGlyph(ch), char: ch });
    charCount++;
    if (eccInterval > 0 && charCount % eccInterval === 0) {
      glyphs.push({ type: "ECC", grid: buildEccGlyph() });
    }
  }

  glyphs.push({ type: "STOP", grid: buildStopGlyph() });
  return glyphs;
}

// ─── Decoder ───

function utf8Decode(bytes) {
  const len = bytes.length;
  let code;
  if (len === 1) code = bytes[0];
  else if (len === 2) code = ((bytes[0] & 0x1f) << 6) | (bytes[1] & 0x3f);
  else if (len === 3)
    code =
      ((bytes[0] & 0x0f) << 12) | ((bytes[1] & 0x3f) << 6) | (bytes[2] & 0x3f);
  else
    code =
      ((bytes[0] & 0x07) << 18) |
      ((bytes[1] & 0x3f) << 12) |
      ((bytes[2] & 0x3f) << 6) |
      (bytes[3] & 0x3f);
  if (code < 0 || code > 0x10ffff) return "\uFFFD";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "\uFFFD";
  }
}

function isSyncBar(bitmap, col) {
  if (col + 1 >= bitmap[0].length) return false;
  for (let r = 0; r < ROWS; r++) {
    if (bitmap[r][col] !== 1 || bitmap[r][col + 1] !== 0) return false;
  }
  return true;
}

function isStartFinder(bitmap, col) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < FINDER_COLS; c++) {
      if (bitmap[r][col + 2 + c] !== FINDER_PATTERN[r][c]) return false;
    }
  }
  return true;
}

function isStopFinder(bitmap, col) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < FINDER_COLS; c++) {
      if (bitmap[r][col + 2 + c] !== FINDER_PATTERN[r][FINDER_COLS - 1 - c])
        return false;
    }
  }
  return true;
}

function isEccMarker(bitmap, col) {
  for (let r = 0; r < ROWS; r++) {
    if (bitmap[r][col + 2] !== 1) return false;
  }
  return true;
}

function decodeCharAt(bitmap, col) {
  const lenBit0 = bitmap[0][col + 2];
  const lenBit1 = bitmap[1][col + 2];
  const byteLen = Math.min(4, Math.max(1, ((lenBit0 << 1) | lenBit1) + 1));

  // Read all 16 rows as a message: data bytes + ECC bytes
  const message = new Uint8Array(ROWS);
  for (let r = 0; r < ROWS; r++) {
    let byte = 0;
    for (let bit = 7; bit >= 0; bit--) {
      byte |= bitmap[r][col + 3 + (7 - bit)] << bit;
    }
    message[r] = byte;
  }

  const nsym = ROWS - byteLen;
  try {
    const result = rsDecode(message, nsym);
    if (result) {
      return {
        char: utf8Decode([...result.corrected]),
        eccValid: true,
        corrected: result.errors,
      };
    }
  } catch {
    // RS decode threw — fall through to raw read
  }

  // Uncorrectable: return raw data without correction
  try {
    const rawBytes = [...message.slice(0, byteLen)];
    return { char: utf8Decode(rawBytes), eccValid: false, corrected: 0 };
  } catch {
    return { char: "\uFFFD", eccValid: false, corrected: 0 };
  }
}

function decodeBitmap(bitmap, totalCols) {
  const chars = [];
  let eccErrors = 0;
  let eccCorrected = 0;
  let col = 0;

  while (col < totalCols) {
    if (!isSyncBar(bitmap, col)) {
      col++;
      continue;
    }

    if (col + START_WIDTH <= totalCols && isStartFinder(bitmap, col)) {
      col += START_WIDTH;
    } else if (col + STOP_WIDTH <= totalCols && isStopFinder(bitmap, col)) {
      break;
    } else if (
      col + CHAR_GLYPH_WIDTH <= totalCols &&
      isEccMarker(bitmap, col)
    ) {
      col += CHAR_GLYPH_WIDTH;
    } else if (col + CHAR_GLYPH_WIDTH <= totalCols) {
      try {
        const { char, eccValid, corrected } = decodeCharAt(bitmap, col);
        chars.push(char);
        if (!eccValid) eccErrors++;
        eccCorrected += corrected;
      } catch {
        eccErrors++;
        chars.push("\uFFFD"); // replacement character
      }
      col += CHAR_GLYPH_WIDTH;
    } else {
      col++;
    }
  }

  return { text: chars.join(""), eccErrors, eccCorrected };
}

// ─── Apply random bit flips to bitmap (data area only, skip sync bars) ───
function applyNoise(bitmap, totalCols, flipRate) {
  if (flipRate <= 0) return bitmap;
  const noisy = bitmap.map((row) => [...row]);
  // Walk through glyphs by detecting sync bars
  let col = 0;
  while (col < totalCols) {
    // Check for sync bar
    let isSync = col + 1 < totalCols;
    if (isSync) {
      for (let r = 0; r < ROWS; r++) {
        if (bitmap[r][col] !== 1 || bitmap[r][col + 1] !== 0) {
          isSync = false;
          break;
        }
      }
    }
    if (!isSync) {
      col++;
      continue;
    }

    // Determine glyph width
    let w = CHAR_GLYPH_WIDTH; // default
    if (col + START_WIDTH <= totalCols && isStartFinder(bitmap, col)) {
      w = START_WIDTH;
    } else if (col + STOP_WIDTH <= totalCols && isStopFinder(bitmap, col)) {
      w = STOP_WIDTH;
    }

    // Flip bits only in data area (skip sync cols 0-1)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 2; c < w && col + c < totalCols; c++) {
        if (Math.random() < flipRate) {
          noisy[r][col + c] ^= 1;
        }
      }
    }
    col += w;
  }
  return noisy;
}

// ─── Compose a single line of glyphs into bitmap ───
function composeLine(glyphs) {
  const totalCols = glyphs.reduce((sum, g) => sum + g.grid[0].length, 0);
  const bitmap = Array.from({ length: ROWS }, () => Array(totalCols).fill(0));
  let offset = 0;
  const glyphBoundaries = [];

  for (const g of glyphs) {
    const w = g.grid[0].length;
    glyphBoundaries.push({
      type: g.type,
      start: offset,
      width: w,
      char: g.char,
    });
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < w; c++) {
        bitmap[r][offset + c] = g.grid[r][c];
      }
    }
    offset += w;
  }

  return { bitmap, totalCols, glyphBoundaries };
}

// ─── Split glyphs into visual lines ───
// Hard break: \n CHAR glyph (encoded in stream, decoder sees it)
// Soft break: width overflow (visual only, decoder ignores)
const LINE_GAP = 4; // separator: clock(1) + blank(2) + clock(1)

function composeLines(glyphs, maxCols) {
  const lines = [];
  let currentGlyphs = [];
  let currentWidth = 0;

  for (const g of glyphs) {
    const w = g.grid[0].length;
    const isNewline = g.type === "CHAR" && g.char === "\n";

    // Soft break: would exceed maxCols
    if (maxCols > 0 && currentWidth + w > maxCols && currentGlyphs.length > 0) {
      lines.push(composeLine(currentGlyphs));
      currentGlyphs = [];
      currentWidth = 0;
    }

    currentGlyphs.push(g);
    currentWidth += w;

    // Hard break: \n glyph is included in the line, then break
    if (isNewline) {
      lines.push(composeLine(currentGlyphs));
      currentGlyphs = [];
      currentWidth = 0;
    }
  }

  if (currentGlyphs.length > 0) {
    lines.push(composeLine(currentGlyphs));
  }

  return lines;
}

// ─── Main Component ───
export default function Code2501Prototype() {
  const [text, setText] = useState(
    "童の時は、語ることも童の如く、思うことも童の如く、論ずることも童の如くなりしが、人となりては、童のことを棄てたり。",
  );
  const [eccInterval, setEccInterval] = useState(10);
  const [cellSize, setCellSize] = useState(4);
  const [noiseRate, setNoiseRate] = useState(0);
  const [noiseSeed, setNoiseSeed] = useState(0); // bump to regenerate noise
  const [hoveredGlyph, setHoveredGlyph] = useState(null); // { lineIdx, glyphIdx }
  const [containerWidth, setContainerWidth] = useState(0);
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // Measure container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // subtract padding (12px * 2)
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const glyphs = encodeCode2501(text, eccInterval);
  const maxCols =
    containerWidth > 0 ? Math.floor(containerWidth / cellSize) : 0;
  const lines = composeLines(glyphs, maxCols);
  const totalGlyphs = glyphs.length;
  const totalCols = glyphs.reduce((sum, g) => sum + g.grid[0].length, 0);

  // Round-trip: decode from flat bitmap (with optional noise)
  const decoded = useMemo(() => {
    void noiseSeed; // dependency to allow re-roll
    const flat = composeLine(glyphs);
    const bitmap =
      noiseRate > 0
        ? applyNoise(flat.bitmap, flat.totalCols, noiseRate)
        : flat.bitmap;
    return decodeBitmap(bitmap, flat.totalCols);
  }, [glyphs, noiseRate, noiseSeed]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const widestLine = Math.max(...lines.map((l) => l.totalCols));
    const w = widestLine * cellSize;
    const h = lines.length * (ROWS + LINE_GAP) * cellSize - LINE_GAP * cellSize;
    canvas.width = w;
    canvas.height = h;

    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, w, h);

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const yOff = li * (ROWS + LINE_GAP) * cellSize;

      // Draw cells
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < line.totalCols; c++) {
          if (line.bitmap[r][c]) {
            ctx.fillStyle = "#e0e0e0";
            ctx.fillRect(c * cellSize, yOff + r * cellSize, cellSize, cellSize);
          }
        }
      }

      // Glyph boundary lines
      if (cellSize >= 3) {
        ctx.strokeStyle = "rgba(0, 255, 180, 0.15)";
        ctx.lineWidth = 1;
        for (const b of line.glyphBoundaries) {
          ctx.beginPath();
          ctx.moveTo(b.start * cellSize, yOff);
          ctx.lineTo(b.start * cellSize, yOff + ROWS * cellSize);
          ctx.stroke();
        }
      }

      // Separator pattern between lines (clock + blank + blank + clock)
      if (li < lines.length - 1) {
        const sepY = yOff + ROWS * cellSize;
        ctx.fillStyle = "#e0e0e0";
        for (let c = 0; c < widestLine; c++) {
          if (c % 2 === 0) {
            // Row 0: clock pattern
            ctx.fillRect(c * cellSize, sepY, cellSize, cellSize);
            // Row 3: clock pattern
            ctx.fillRect(c * cellSize, sepY + 3 * cellSize, cellSize, cellSize);
          }
        }
        // Rows 1-2 stay blank (background)
      }

      // Highlight hovered glyph
      if (hoveredGlyph !== null && hoveredGlyph.lineIdx === li) {
        const b = line.glyphBoundaries[hoveredGlyph.glyphIdx];
        if (b) {
          ctx.strokeStyle = "rgba(0, 255, 180, 0.6)";
          ctx.lineWidth = 2;
          ctx.strokeRect(
            b.start * cellSize,
            yOff,
            b.width * cellSize,
            ROWS * cellSize,
          );
        }
      }
    }
  }, [lines, cellSize, hoveredGlyph]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleCanvasMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const lineHeight = (ROWS + LINE_GAP) * cellSize;
    const li = Math.floor(y / lineHeight);
    const rowInLine = y - li * lineHeight;

    // Ignore if in gap area or out of bounds
    if (li < 0 || li >= lines.length || rowInLine > ROWS * cellSize) {
      setHoveredGlyph(null);
      return;
    }

    const col = Math.floor(x / cellSize);
    const line = lines[li];
    for (let i = 0; i < line.glyphBoundaries.length; i++) {
      const b = line.glyphBoundaries[i];
      if (col >= b.start && col < b.start + b.width) {
        setHoveredGlyph({ lineIdx: li, glyphIdx: i });
        return;
      }
    }
    setHoveredGlyph(null);
  };

  const stats = {
    chars: [...text].length,
    glyphs: totalGlyphs,
    totalCols,
    lines: lines.length,
    dataBytes: [...text].reduce((s, ch) => s + utf8Encode(ch).length, 0),
  };

  const hovered =
    hoveredGlyph !== null
      ? lines[hoveredGlyph.lineIdx]?.glyphBoundaries[hoveredGlyph.glyphIdx]
      : null;

  return (
    <div
      style={{
        background: "#0a0a0a",
        color: "#c8c8c8",
        minHeight: "100vh",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <link
        href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600&display=swap"
        rel="stylesheet"
      />

      {/* Header */}
      <div
        style={{
          marginBottom: 24,
          borderBottom: "1px solid #1a3a2a",
          paddingBottom: 16,
        }}
      >
        <h1
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: "#00ffb4",
            margin: 0,
            letterSpacing: "0.1em",
          }}
        >
          CODE 2501
          <span style={{ color: "#444", fontWeight: 300, marginLeft: 8 }}>
            v0.3 prototype
          </span>
        </h1>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 16,
          marginBottom: 20,
        }}
      >
        <div>
          <label
            style={{
              fontSize: 11,
              color: "#666",
              display: "block",
              marginBottom: 4,
              letterSpacing: "0.08em",
            }}
          >
            INPUT TEXT
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            style={{
              width: "100%",
              background: "#111",
              border: "1px solid #222",
              color: "#e0e0e0",
              padding: "10px 12px",
              fontSize: 14,
              fontFamily: "inherit",
              borderRadius: 4,
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
            }}
            onFocus={(e) => (e.target.style.borderColor = "#00ffb4")}
            onBlur={(e) => (e.target.style.borderColor = "#222")}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <label
              style={{
                fontSize: 11,
                color: "#666",
                display: "block",
                marginBottom: 4,
                letterSpacing: "0.08em",
              }}
            >
              ECC INTERVAL
            </label>
            <input
              type="number"
              min={1}
              max={63}
              value={eccInterval}
              onChange={(e) =>
                setEccInterval(Math.max(1, Math.min(63, +e.target.value)))
              }
              style={{
                width: 80,
                background: "#111",
                border: "1px solid #222",
                color: "#e0e0e0",
                padding: "8px 10px",
                fontSize: 14,
                fontFamily: "inherit",
                borderRadius: 4,
                outline: "none",
              }}
            />
          </div>
          <div>
            <label
              style={{
                fontSize: 11,
                color: "#666",
                display: "block",
                marginBottom: 4,
                letterSpacing: "0.08em",
              }}
            >
              CELL SIZE
            </label>
            <input
              type="range"
              min={1}
              max={12}
              value={cellSize}
              onChange={(e) => setCellSize(+e.target.value)}
              style={{ width: 80, accentColor: "#00ffb4" }}
            />
            <span style={{ fontSize: 11, color: "#555", marginLeft: 6 }}>
              {cellSize}px
            </span>
          </div>
          <div>
            <label
              style={{
                fontSize: 11,
                color: noiseRate > 0 ? "#ff8800" : "#666",
                display: "block",
                marginBottom: 4,
                letterSpacing: "0.08em",
              }}
            >
              NOISE {(noiseRate * 100).toFixed(1)}%
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="range"
                min={0}
                max={0.3}
                step={0.005}
                value={noiseRate}
                onChange={(e) => setNoiseRate(+e.target.value)}
                style={{ width: 80, accentColor: "#ff8800" }}
              />
              {noiseRate > 0 && (
                <button
                  onClick={() => setNoiseSeed((s) => s + 1)}
                  style={{
                    background: "#222",
                    border: "1px solid #444",
                    color: "#aaa",
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 3,
                    cursor: "pointer",
                  }}
                >
                  re-roll
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div
        style={{
          display: "flex",
          gap: 24,
          marginBottom: 12,
          fontSize: 11,
          color: "#555",
          letterSpacing: "0.05em",
        }}
      >
        <span>
          CHARS <span style={{ color: "#00ffb4" }}>{stats.chars}</span>
        </span>
        <span>
          UTF-8 BYTES{" "}
          <span style={{ color: "#00ffb4" }}>{stats.dataBytes}</span>
        </span>
        <span>
          GLYPHS <span style={{ color: "#00ffb4" }}>{stats.glyphs}</span>
        </span>
        <span>
          TOTAL COLS <span style={{ color: "#00ffb4" }}>{stats.totalCols}</span>
        </span>
        <span>
          LINES <span style={{ color: "#00ffb4" }}>{stats.lines}</span>
        </span>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        style={{
          overflowX: "auto",
          border: "1px solid #1a1a1a",
          borderRadius: 4,
          padding: 12,
          background: "#050505",
          marginBottom: 16,
        }}
      >
        <canvas
          ref={canvasRef}
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={() => setHoveredGlyph(null)}
          style={{ display: "block", imageRendering: "pixelated" }}
        />
      </div>

      {/* Hover info */}
      <div
        style={{
          height: 48,
          fontSize: 12,
          color: "#666",
          borderTop: "1px solid #1a1a1a",
          paddingTop: 12,
        }}
      >
        {hovered ? (
          <span>
            <span style={{ color: "#00ffb4" }}>{hovered.type}</span>
            {hovered.char && (
              <>
                {" "}
                → <span style={{ color: "#e0e0e0" }}>
                  '{hovered.char}'
                </span>{" "}
                <span style={{ color: "#444" }}>
                  (U+
                  {hovered.char
                    .codePointAt(0)
                    .toString(16)
                    .toUpperCase()
                    .padStart(4, "0")}
                  )
                </span>{" "}
                <span style={{ color: "#444" }}>
                  UTF-8: [
                  {utf8Encode(hovered.char)
                    .map(
                      (b) =>
                        "0x" + b.toString(16).toUpperCase().padStart(2, "0"),
                    )
                    .join(", ")}
                  ]
                </span>{" "}
                <span style={{ color: "#555" }}>
                  data:{utf8Encode(hovered.char).length}rows ecc:
                  {ROWS - utf8Encode(hovered.char).length}rows
                </span>
              </>
            )}{" "}
            <span style={{ color: "#333" }}>
              col {hovered.start}–{hovered.start + hovered.width - 1} (
              {hovered.width}w)
            </span>
          </span>
        ) : (
          <span style={{ color: "#333" }}>
            hover over barcode to inspect glyphs
          </span>
        )}
      </div>
      {/* Round-trip verification */}
      <div
        style={{
          marginTop: 16,
          borderTop: "1px solid #1a3a2a",
          paddingTop: 16,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "#666",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          ROUND-TRIP VERIFICATION
          <span
            style={{
              marginLeft: 12,
              color: decoded.text === text ? "#00ffb4" : "#ff4444",
              fontWeight: 600,
            }}
          >
            {decoded.text === text ? "MATCH" : "MISMATCH"}
          </span>
          {decoded.eccCorrected > 0 && (
            <span style={{ marginLeft: 12, color: "#ffcc00" }}>
              CORRECTED: {decoded.eccCorrected} glyphs
            </span>
          )}
          {decoded.eccErrors > 0 && (
            <span style={{ marginLeft: 12, color: "#ff4444" }}>
              UNCORRECTABLE: {decoded.eccErrors} glyphs
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#555",
            fontFamily: "inherit",
            display: "flex",
            gap: 24,
          }}
        >
          <span>input: {[...text].length} chars</span>
          <span>decoded: {[...decoded.text].length} chars</span>
        </div>
        {decoded.text !== text && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 12px",
              background: "#1a0000",
              border: "1px solid #331111",
              borderRadius: 4,
              fontSize: 12,
              color: "#ff6666",
              wordBreak: "break-all",
            }}
          >
            decoded: {decoded.text}
          </div>
        )}
      </div>
    </div>
  );
}
