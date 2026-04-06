import { useState, useRef, useEffect, useCallback } from "react";

// ─── Constants ───
const ROWS = 16;
const SYNC_COLS = 2;
const BYTELEN_COLS = 1;
const DATA_COLS = 8;
const PARITY_COLS = 2;
const CHAR_GLYPH_WIDTH = SYNC_COLS + BYTELEN_COLS + DATA_COLS + PARITY_COLS; // 13
const FINDER_COLS = 8;
const HEADER_COLS = 8;
const START_WIDTH = SYNC_COLS + FINDER_COLS + HEADER_COLS; // 18
const STOP_WIDTH = START_WIDTH; // 18

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
const LINE_GAP = 2; // gap between lines in cells

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
  const maxCols = containerWidth > 0 ? Math.floor(containerWidth / cellSize) : 0;
  const lines = composeLines(glyphs, maxCols);
  const totalGlyphs = glyphs.length;
  const totalCols = glyphs.reduce((sum, g) => sum + g.grid[0].length, 0);

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
            v0.2 prototype
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
    </div>
  );
}
