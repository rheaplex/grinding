// Layout package — arrangement only. Every layout returns the same model:
//   { width, height, cells: [row][cell] -> primitive, furniture: [primitive], labels: [label] }
// A primitive is { tag, attrs } ready for SVG. Nothing here knows about colour,
// data or time: it is handed a row count and a cell count and returns geometry.
(function () {
  const grinding = window.grinding = window.grinding || {};

  const P = (tag, attrs) => ({ tag, attrs });
  const fx = n => Number(n.toFixed(2));

  // ---- tuning constants ---------------------------------------------------

  // every layout composes into the same 16:9 frame
  const FRAME = { width: 1600, height: 900 };

  // type metrics shared by every layout
  const TYPE = {
    word: 24,        // word label size
    nonce: 18,       // nonce label size
    baseline: 0.32,  // baseline offset as a fraction of font size
    advance: 0.62,   // monospace glyph advance as a fraction of font size
    linePitch: 1.15  // line spacing as a fraction of font size
  };

  // text-display rows
  const TEXTROW = {
    perLine: 32,     // glyphs per wrapped line (64 hex digits -> two lines)
    pad: 16          // vertical padding inside a row
  };

  // the label columns of the row layouts (plate, honeycomb)
  const COLUMNS = {
    margin: 20,      // frame margin
    wordW: 250,      // word column width
    nonceW: 230,     // fits the longest formatted nonce at TYPE.nonce
    gap: 24          // clearance between a label and the hash field
  };

  // callout labels (ring family, spiral)
  const CALLOUT = {
    x: 246,          // words end here; nonces start mirrored from the right
    yTop: 70,        // first label y; the last mirrors it from the bottom
    leadGap: 12,     // leader clearance from the label
    fanDegrees: 55   // tap fan: degrees above horizontal at the outermost band
  };

  // ring family (rings, hexRing)
  const RINGS = {
    inner: 62,          // innermost band radius
    outerInset: 30,     // outermost radius = frame half-height minus this
    bandGapOuter: 1,    // radial breathing at a band's outer edge...
    bandGapInner: 2,    // ...and its inner edge
    beadGap: 1.5,       // bead clearance within and between bands
    textInset: 6,       // band text size cap = band thickness minus this
    textBaseline: 0.35  // baseline radius inset as a fraction of text size
  };

  // arm family (radial, rosette)
  const ARMS = {
    inner: 50,          // arm root radius
    outerInset: 85,     // tip radius = frame half-height minus this (label room)
    widthShare: 0.72,   // arm angular width as a share of its slot
    beadGap: 1,         // fitted bead clearance
    cellGapIn: 1,       // radial breathing inside a fitted wedge...
    cellGapOut: 2,      // ...top and bottom
    minHalf: 1.5,       // smallest half-extent any element may shrink to
    textSizeCap: 18,    // arm text size cap
    samples: 28,        // path samples for a swept arm's text line
    normalEps: 0.01,    // finite-difference step for the path normal
    tipGap: 18,         // label distance beyond the tip
    anchorCos: 0.35,    // |cos| beyond which tip labels anchor start/end
    anchorSin: 0.2,     // |sin| beyond which tip labels lift or drop
    wordLift: 26,       // tip label stacking offsets...
    wordDrop: 18,
    wordMid: 4,
    nonceDrop: 24,
    rosetteSweep: 1.26, // radians accumulated along a rosette arm
    frameMargin: 10,    // fill mode: cell clearance from the frame edge
    minFillScale: 0.05
  };

  // spiral
  const SPIRAL = {
    r0: 60,          // coil start radius
    outerInset: 60,  // coil end radius = frame half-height minus this
    loose: 2.2,      // winding: turn pitch = loose x cell/glyph size
    runSpacing: 1.15,// cell spacing along the run, in cell sizes
    gapChars: 2,     // breathing room between runs, in glyphs...
    runGap: 1.2,     // ...and in cell sizes for the block modes
    textSizeCap: 40,
    walkStep: 9,     // arc-length step when walking the coil
    minSide: 2.5     // smallest square side on the coil
  };

  // element sizing modes on the fanning layouts
  const SIZING = {
    taper: 0.7,           // shrink: fraction lost by the tip
    overlapBead: 0.85,    // overlap: bead radius as a fraction of the step
    overlapReach: 0.35,   // overlap: wedge radial overshoot
    shrinkStart: 2.2,     // shrink: root bead radius as a fraction of the step
    shrinkFloorPad: 0.5,  // shrink: overlap-guarantee padding
    spiralShrinkFloor: 0.6, // shrink floor on the coil, in cell sizes
    beadFit: 0.48,        // spiral cell factors, in cell sizes
    beadFillShare: 0.46,  // (of the winding pitch)
    sideFit: 0.78,
    sideFill: 1.25,
    sideOverlap: 1.5
  };

  // gutter
  const GUTTER = {
    x: 380,           // the gutter line: labels end left of it, field right
    topWithHeader: 44,
    top: 64,
    bottom: 64,
    fieldGap: 20,     // hash field starts this far right of the line
    wordInset: 260,   // word labels end this far left of the line
    nonceInset: 24,   // nonce labels end this far left of the line
    cellGap: 2,
    cellPad: 16,      // square side cap = row height minus this
    ruleLift: 12      // top rule sits this far above the first row
  };

  // honeycomb
  const COMB = {
    vPad: 48,        // vertical bound for the comb's own sizing
    insetScale: 6,   // hex inset = gap fraction x this
    maxStretch: 2.2  // how far hexes may elongate vertically to use the height
  };

  // -------------------------------------------------------------------------

  function polygonPoints(pts) {
    return pts.map(p => fx(p[0]) + "," + fx(p[1])).join(" ");
  }

  // text-display rows: characters on a fixed grid across `region`, wrapping
  // 64 hex digits into two lines of 32 on the same grid the ascii view uses
  function textRowSpec(x0, region, glyphs, rowHeight, mid, display) {
    const perLine = Math.min(glyphs, TEXTROW.perLine);
    const lines = Math.ceil(glyphs / perLine);
    const cw = region / perLine;
    const size = Math.min(Math.round((rowHeight - TEXTROW.pad) / (lines * TYPE.linePitch)), Math.round(cw / TYPE.advance));
    const pitch = size * TYPE.linePitch;
    return {
      x: fx(x0), size, cw, perLine,
      // text rows show grey dots before the glyphs appear
      placeholder: "·".repeat(glyphs),
      baselines: Array.from({ length: lines }, (_, l) =>
        fx(mid - pitch * (lines - 1) / 2 + l * pitch + size * TYPE.baseline))
    };
  }

  // ---------------------------------------------------------------- plate
  // a full-height mosaic row per search: word on the left, nonce on the
  // right, the initial-value row first; animated exactly as the gutter is
  function plate(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, gap = 0.06, header = null } = o;
    const display = o.display || "squares"; // squares | circles | hex | ascii
    const textual = display === "hex" || display === "ascii";
    const glyphs = o.glyphs || 64; // characters per text row (64 hex, 32 ascii)
    const wordSize = o.wordSize || TYPE.word, nonceSize = o.nonceSize || TYPE.nonce;
    const x0 = COLUMNS.margin + COLUMNS.wordW, x1 = width - COLUMNS.margin - COLUMNS.nonceW;
    const region = x1 - x0;
    const slots = rows + (header ? 1 : 0);
    const rowH = height / slots;
    const w = region / cols, g = gap * w;
    const cells = [], labels = [], furniture = [];
    const textRows = textual ? [] : null;
    const rowCells = top => {
      const row = [];
      for (let k = 0; k < cols; k++) {
        if (display === "circles") {
          const r = Math.min(w - 2 * g, rowH - 2 * g) / 2;
          row.push(P("circle", { cx: fx(x0 + k * w + w / 2), cy: fx(top + rowH / 2), r: fx(r) }));
        } else
          row.push(P("rect", { x: fx(x0 + k * w + g), y: fx(top + g), width: fx(w - 2 * g), height: fx(rowH - 2 * g) }));
      }
      return row;
    };
    const rowLabels = (mid, spec) => {
      const y = fx(mid + wordSize * TYPE.baseline);
      // words right-aligned against the field, nonces left-aligned after it
      labels.push({ ...spec.text, x: fx(x0 - COLUMNS.gap), y, anchor: "end", size: wordSize });
      labels.push({ ...spec.nonce, x: fx(x1 + COLUMNS.gap), y, anchor: "start", size: nonceSize, mono: true });
    };
    let headerModel = null;
    if (header) {
      headerModel = textual ? { text: textRowSpec(x0, region, glyphs, rowH, rowH / 2, display) } : { cells: rowCells(0) };
      rowLabels(rowH / 2, { text: { parts: [{ t: header.plaintext }] }, nonce: { parts: [{ t: header.nonce }] } });
    }
    for (let i = 0; i < rows; i++) {
      const top = (i + (header ? 1 : 0)) * rowH;
      if (textual) { cells.push([]); textRows.push(textRowSpec(x0, region, glyphs, rowH, top + rowH / 2, display)); }
      else cells.push(rowCells(top));
      rowLabels(top + rowH / 2, { text: { row: i, field: "plaintext" }, nonce: { row: i, field: "nonce" } });
    }
    return { width, height, cells, textRows, furniture, labels, header: headerModel, display };
  }

  // ------------------------------------------------- rings & hexRing
  // one family: concentric bands with the initial value as the outermost,
  // words called out left and nonces right with leader lines to their band.
  // "squares" shows the native band segments; circles string beads along
  // each band; hex/ascii run around the band on its path (with grey dot
  // placeholders). A shape supplies the geometry:
  //   point(cx, cy, r, t)  boundary point at parameter t (0 = top, clockwise)
  //   perimeter(r)         boundary length at radius r
  //   pathD(cx, cy, r)     the closed boundary path for text to ride
  //   bandCells(...)       the native segment primitives for one band
  function ringFamily(rows, cols, o, shape) {
    const { width = FRAME.width, height = FRAME.height, inner = RINGS.inner, header = null } = o;
    const display = o.display || "squares";
    const textual = display === "hex" || display === "ascii";
    const glyphs = o.glyphs || 64;
    const outer = o.outer || height / 2 - RINGS.outerInset;
    const wordSize = o.wordSize || TYPE.word, nonceSize = o.nonceSize || TYPE.nonce;
    const cx = width / 2, cy = height / 2;
    const bands = rows + (header ? 1 : 0);
    const tr = (outer - inner) / bands;
    const point = (r, t) => shape.point(cx, cy, r, t);
    const bandCells = b => {
      const ro = outer - b * tr - RINGS.bandGapOuter, ri = ro - tr + RINGS.bandGapInner;
      const rm = outer - b * tr - tr / 2;
      if (display === "circles") {
        const bead = Math.min(tr / 2 - RINGS.beadGap, shape.perimeter(rm) / (2 * cols) - RINGS.beadGap);
        const row = [];
        for (let k = 0; k < cols; k++) {
          const [bx, by] = point(rm, (k + 0.5) / cols);
          row.push(P("circle", { cx: fx(bx), cy: fx(by), r: fx(bead) }));
        }
        return row;
      }
      return shape.bandCells(cx, cy, ro, ri, cols);
    };
    // text sized to the band's boundary so it shrinks inward, as beads do
    const bandText = b => {
      const rm = outer - b * tr - tr / 2;
      const size = Math.min(Math.round(tr) - RINGS.textInset, Math.round(shape.perimeter(rm) / glyphs / TYPE.advance));
      const br = rm - size * RINGS.textBaseline; // baseline sits inward: glyphs extend outward
      return {
        paths: [{ pathD: shape.pathD(cx, cy, br), id: shape.idPrefix + b }],
        size, perLine: glyphs,
        // text bands show grey dots before the glyphs appear
        placeholder: "·".repeat(glyphs)
      };
    };
    const cells = [], labels = [], overlays = [], furniture = [];
    const textRows = textual ? [] : null;
    // callouts: labels equally spaced down the available height, each band
    // tapped at its mid radius, taps fanning from the upper boundary
    // (outermost) to the horizontal (innermost)
    const wordX = CALLOUT.x, nonceX = width - CALLOUT.x;
    const yTop = CALLOUT.yTop, yStep = bands > 1 ? (height - 2 * CALLOUT.yTop) / (bands - 1) : 0;
    const callout = (b, spec) => {
      const rm = outer - b * tr - tr / 2;
      const phi = bands > 1 ? CALLOUT.fanDegrees * (1 - b / (bands - 1)) : 0; // degrees above horizontal
      const [lx, ly] = point(rm, 0.75 + phi / 360);
      const [rx, ry] = point(rm, 0.25 - phi / 360);
      const mid = yTop + b * yStep;
      const y = fx(mid + wordSize * TYPE.baseline);
      overlays.push(P("line", { x1: fx(wordX + CALLOUT.leadGap), y1: fx(mid), x2: fx(lx), y2: fx(ly), stroke: "gridline" }));
      overlays.push(P("line", { x1: fx(nonceX - CALLOUT.leadGap), y1: fx(mid), x2: fx(rx), y2: fx(ry), stroke: "gridline" }));
      labels.push({ ...spec.text, x: wordX, y, anchor: "end", size: wordSize });
      labels.push({ ...spec.nonce, x: nonceX, y, anchor: "start", size: nonceSize, mono: true });
    };
    let headerModel = null;
    const offset = header ? 1 : 0;
    if (header) {
      headerModel = textual ? { text: bandText(0) } : { cells: bandCells(0) };
      callout(0, { text: { parts: [{ t: header.plaintext }] }, nonce: { parts: [{ t: header.nonce }] } });
    }
    for (let i = 0; i < rows; i++) {
      if (textual) { cells.push([]); textRows.push(bandText(i + offset)); }
      else cells.push(bandCells(i + offset));
      callout(i + offset, { text: { row: i, field: "plaintext" }, nonce: { row: i, field: "nonce" } });
    }
    return { width, height, cells, textRows, furniture, overlays, labels, header: headerModel, display };
  }

  const circleShape = {
    idPrefix: "ring-text-",
    point: (cx, cy, r, t) => {
      const a = -Math.PI / 2 + t * Math.PI * 2;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    },
    perimeter: r => 2 * Math.PI * r,
    pathD: (cx, cy, r) =>
      "M " + fx(cx) + " " + fx(cy - r) +
      " A " + fx(r) + " " + fx(r) + " 0 1 1 " + fx(cx) + " " + fx(cy + r) +
      " A " + fx(r) + " " + fx(r) + " 0 1 1 " + fx(cx) + " " + fx(cy - r),
    bandCells: (cx, cy, ro, ri, cols) => {
      const pt = (r, a) => fx(cx + Math.cos(a) * r) + " " + fx(cy + Math.sin(a) * r);
      const row = [];
      for (let k = 0; k < cols; k++) {
        const a0 = -Math.PI / 2 + (k / cols) * Math.PI * 2;
        const a1 = -Math.PI / 2 + ((k + 1) / cols) * Math.PI * 2;
        row.push(P("path", {
          d: "M " + pt(ro, a0) + " A " + fx(ro) + " " + fx(ro) + " 0 0 1 " + pt(ro, a1) +
             " L " + pt(ri, a1) + " A " + fx(ri) + " " + fx(ri) + " 0 0 0 " + pt(ri, a0) + " Z"
        }));
      }
      return row;
    }
  };

  function hexBoundaryPoint(cx, cy, r, t) {
    t = ((t % 1) + 1) % 1;
    const seg = t * 6, n = Math.floor(seg) % 6, f = seg - Math.floor(seg);
    const a0 = -Math.PI / 2 + n * Math.PI / 3, a1 = a0 + Math.PI / 3;
    const x0 = Math.cos(a0) * r, y0 = Math.sin(a0) * r;
    const x1 = Math.cos(a1) * r, y1 = Math.sin(a1) * r;
    return [cx + x0 + (x1 - x0) * f, cy + y0 + (y1 - y0) * f];
  }

  function hexSpan(cx, cy, r, t0, t1) {
    const pts = [hexBoundaryPoint(cx, cy, r, t0)];
    for (let c = Math.ceil(t0 * 6); c < t1 * 6 - 1e-9; c++) pts.push(hexBoundaryPoint(cx, cy, r, c / 6));
    pts.push(hexBoundaryPoint(cx, cy, r, t1));
    return pts;
  }

  const hexShape = {
    idPrefix: "hexring-text-",
    point: hexBoundaryPoint,
    perimeter: r => 6 * r,
    pathD: (cx, cy, r) =>
      "M " + polygonPoints(Array.from({ length: 6 }, (_, k) => hexBoundaryPoint(cx, cy, r, k / 6))).replace(/ /g, " L ") + " Z",
    bandCells: (cx, cy, ro, ri, cols) => {
      const row = [];
      for (let k = 0; k < cols; k++)
        row.push(P("polygon", {
          points: polygonPoints(hexSpan(cx, cy, ro, k / cols, (k + 1) / cols)
            .concat(hexSpan(cx, cy, ri, k / cols, (k + 1) / cols).reverse()))
        }));
      return row;
    }
  };

  const rings = (rows, cols, o) => ringFamily(rows, cols, o, circleShape);
  const hexRing = (rows, cols, o) => ringFamily(rows, cols, o, hexShape);

  // ---------------------------------------------------------------- honeycomb
  // a comb row per search between a word column left and a nonce column
  // right, the initial-value row first; animated exactly as the plate is
  function honeycomb(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, header = null } = o;
    // "squares" shows the native hex mosaic (honeycomb's block form);
    // circles pack at the hex centres; hex/ascii are the shared text rows
    const display = o.display || "squares";
    const textual = display === "hex" || display === "ascii";
    const glyphs = o.glyphs || 64;
    const wordSize = o.wordSize || TYPE.word, nonceSize = o.nonceSize || TYPE.nonce;
    const x0 = COLUMNS.margin + COLUMNS.wordW, x1 = width - COLUMNS.margin - COLUMNS.nonceW;
    const region = x1 - x0;
    const slots = rows + (header ? 1 : 0);
    const cells = [], labels = [], furniture = [];
    const textRows = textual ? [] : null;
    const rowLabels = (cyRow, spec) => {
      const y = fx(cyRow + wordSize * TYPE.baseline);
      // words right-aligned against the comb, nonces left-aligned after it
      labels.push({ ...spec.text, x: fx(x0 - COLUMNS.gap), y, anchor: "end", size: wordSize });
      labels.push({ ...spec.nonce, x: fx(x1 + COLUMNS.gap), y, anchor: "start", size: nonceSize, mono: true });
    };
    let headerModel = null;
    const offset = header ? 1 : 0;
    if (textual) {
      // text has no cell shape: rows take even slots the full height
      const rowH = height / slots;
      const mid = s => s * rowH + rowH / 2;
      if (header) {
        headerModel = { text: textRowSpec(x0, region, glyphs, rowH, mid(0), display) };
        rowLabels(mid(0), { text: { parts: [{ t: header.plaintext }] }, nonce: { parts: [{ t: header.nonce }] } });
      }
      for (let i = 0; i < rows; i++) {
        cells.push([]);
        textRows.push(textRowSpec(x0, region, glyphs, rowH, mid(i + offset), display));
        rowLabels(mid(i + offset), { text: { row: i, field: "plaintext" }, nonce: { row: i, field: "nonce" } });
      }
      return { width, height, cells, textRows, furniture, labels, header: headerModel, display };
    }
    // the comb sizes itself to the width, then the hexes stretch vertically
    // (up to COMB.maxStretch) so the mesh uses the available height
    const rFromW = region / (cols + 0.5) / Math.sqrt(3);
    const rFromH = (height - COMB.vPad) / ((slots - 1) * 1.5 + 2);
    const rh = Math.min(rFromW, rFromH);
    const stretch = Math.max(1, Math.min(COMB.maxStretch, rFromH / rh));
    const rv = rh * stretch;
    const w = rh * Math.sqrt(3), pitch = 1.5 * rv;
    const xLeft = x0 + (region - w * (cols + 0.5)) / 2;
    const yTop = (height - ((slots - 1) * pitch + 2 * rv)) / 2 + rv;
    const inset = (o.gap ?? 0.06) * COMB.insetScale;
    const rowY = s => yTop + s * pitch;
    const hexRow = s => {
      const row = [];
      for (let k = 0; k < cols; k++) {
        const hx = xLeft + w / 2 + k * w + (s % 2 ? w / 2 : 0), hy = rowY(s);
        if (display === "circles") {
          row.push(P("circle", { cx: fx(hx), cy: fx(hy), r: fx(rh - inset) }));
          continue;
        }
        const pts = Array.from({ length: 6 }, (_, n) => {
          const a = -Math.PI / 2 + n * Math.PI / 3;
          return [hx + Math.cos(a) * (rh - inset), hy + Math.sin(a) * (rv - inset * stretch)];
        });
        row.push(P("polygon", { points: polygonPoints(pts) }));
      }
      return row;
    };
    if (header) {
      headerModel = { cells: hexRow(0) };
      rowLabels(rowY(0), { text: { parts: [{ t: header.plaintext }] }, nonce: { parts: [{ t: header.nonce }] } });
    }
    for (let i = 0; i < rows; i++) {
      cells.push(hexRow(i + offset));
      rowLabels(rowY(i + offset), { text: { row: i, field: "plaintext" }, nonce: { row: i, field: "nonce" } });
    }
    return { width, height, cells, furniture, labels, header: headerModel, display };
  }

  // ------------------------------------------------- radial & rosette
  // one figure: each search a single arm out from the centre, cells running
  // root to tip; the initial value's arm starts at 12 o'clock and the words
  // follow clockwise. Labels sit just beyond each arm's tip. `sweep` is the
  // rotation accumulated along an arm: 0 gives straight asterisk arms
  // (radial); a nonzero sweep turns each successive element slightly further
  // around the centre, curling the arms into a rosette.
  // "squares" shows wedge segments; circles string beads up the arm;
  // hex/ascii run along the arm's path (hex as two parallel lines of 32).
  function armFamily(rows, cols, o, sweep, idPrefix) {
    const { width = FRAME.width, height = FRAME.height, inner = ARMS.inner, header = null } = o;
    const display = o.display || "squares";
    const textual = display === "hex" || display === "ascii";
    const glyphs = o.glyphs || 64;
    const wordSize = o.wordSize || TYPE.word, nonceSize = o.nonceSize || TYPE.nonce;
    const cx = width / 2, cy = height / 2;
    const arms = rows + (header ? 1 : 0);
    const cells = [], labels = [], furniture = [];
    let headerModel = null;
    const offset = header ? 1 : 0;
    const outer = o.outer || height / 2 - ARMS.outerInset;
    const step = (outer - inner) / cols;
    const hw = (Math.PI / arms) * ARMS.widthShare; // arm angular halfwidth
    const pt = (r, a) => fx(cx + Math.cos(a) * r) + " " + fx(cy + Math.sin(a) * r);
    const armAngle = a => -Math.PI / 2 + (a / arms) * Math.PI * 2;
    // the arm's centreline: t in 0..1 from root to tip, angle turning with t
    const along = (a, t) => {
      const th = armAngle(a) + t * sweep;
      const r = inner + t * (outer - inner);
      return [cx + Math.cos(th) * r, cy + Math.sin(th) * r, th, r];
    };
    // text along the arm, root to tip, so matched prefixes radiate from the
    // centre exactly as the matched cells do
    const textRows = textual ? [] : null;
    const armText = a => {
      const perLine = Math.min(glyphs, TEXTROW.perLine);
      const linesN = Math.ceil(glyphs / perLine);
      const size = Math.min(ARMS.textSizeCap, Math.round((outer - inner) / perLine / TYPE.advance));
      const pitch = size * TYPE.linePitch;
      const SAMPLES = sweep ? ARMS.samples : 1;
      const paths = Array.from({ length: linesN }, (_, l) => {
        const off = (l - (linesN - 1) / 2) * pitch;
        const pts = [];
        for (let n = 0; n <= SAMPLES; n++) {
          const t = n / SAMPLES;
          const [x, y] = along(a, t);
          // offset along the local normal so lines stay parallel
          const [x1, y1] = along(a, Math.min(1, t + ARMS.normalEps));
          const [x0, y0] = along(a, Math.max(0, t - ARMS.normalEps));
          const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
          pts.push([x - dy / len * off, y + dx / len * off]);
        }
        return {
          pathD: "M " + pts.map(p => fx(p[0]) + " " + fx(p[1])).join(" L "),
          id: idPrefix + a + "-" + l
        };
      });
      return { paths, size, perLine, placeholder: "·".repeat(glyphs) };
    };
    // sizing: "fit" keeps elements inside their slot; "fill" grows them into
    // the room that opens as the arms fan out; "overlap" starts them large so
    // they shingle along the arm, as the original rosettes' petals did;
    // "shrink" starts them larger still and tapers them towards the tip
    const sizing = o.sizing || "fit";
    const taper = t => 1 - SIZING.taper * t;
    const armCells = a => {
      const row = [];
      // fill: grow with the fan, scaled uniformly per arm so the tip stays
      // inside the frame while remaining the arm's largest element
      let fillScale = 1;
      if (sizing === "fill" && display === "circles")
        for (let k = 0; k < cols; k++) {
          const rm = inner + (k + 0.5) * step;
          const th = armAngle(a) + ((k + 0.5) / cols) * sweep;
          const x = cx + Math.cos(th) * rm, y = cy + Math.sin(th) * rm;
          const room = rm * Math.sin(hw) - ARMS.beadGap;
          const limit = Math.min(x, width - x, y, height - y) - ARMS.frameMargin;
          if (room > 0 && limit < room) fillScale = Math.min(fillScale, Math.max(ARMS.minFillScale, limit / room));
        }
      for (let k = 0; k < cols; k++) {
        const t = (k + 0.5) / cols;
        const rm = inner + (k + 0.5) * step;
        const th = armAngle(a) + t * sweep;
        if (display === "circles") {
          const room = rm * Math.sin(hw) - ARMS.beadGap; // tangential room to the next arm
          const bead = sizing === "fill" ? room * fillScale
            : sizing === "overlap" ? step * SIZING.overlapBead
            // shrink: big at the root, tapering out, but never so small that
            // neighbouring beads on the arm stop overlapping — the floor is
            // half the true centre distance, sweep included
            : sizing === "shrink" ? Math.max(Math.hypot(step, (sweep / cols) * rm) / 2 + SIZING.shrinkFloorPad, step * SIZING.shrinkStart * taper(t))
            : Math.min(step / 2 - ARMS.beadGap, room);
          row.push(P("circle", { cx: fx(cx + Math.cos(th) * rm), cy: fx(cy + Math.sin(th) * rm), r: fx(bead) }));
          continue;
        }
        if (sizing === "shrink") {
          const he = Math.max(ARMS.minHalf, (step / 2 - ARMS.beadGap) * taper(t));
          const hwK = hw * taper(t);
          row.push(P("path", {
            d: "M " + pt(rm + he, th - hwK) + " A " + fx(rm + he) + " " + fx(rm + he) + " 0 0 1 " + pt(rm + he, th + hwK) +
               " L " + pt(rm - he, th + hwK) + " A " + fx(rm - he) + " " + fx(rm - he) + " 0 0 0 " + pt(rm - he, th - hwK) + " Z"
          }));
          continue;
        }
        const reach = sizing === "overlap" ? step * SIZING.overlapReach : 0;
        const ri = inner + k * step + (sizing === "fit" ? ARMS.cellGapIn : 0) - reach;
        const ro = inner + (k + 1) * step - (sizing === "fit" ? ARMS.cellGapOut : 0) + reach;
        row.push(P("path", {
          d: "M " + pt(ro, th - hw) + " A " + fx(ro) + " " + fx(ro) + " 0 0 1 " + pt(ro, th + hw) +
             " L " + pt(ri, th + hw) + " A " + fx(ri) + " " + fx(ri) + " 0 0 0 " + pt(ri, th - hw) + " Z"
        }));
      }
      return row;
    };
    // tip labels: word over nonce, anchored away from the figure, at the
    // angle the arm has swept to by its tip
    const armLabels = (a, spec) => {
      const th = armAngle(a) + sweep;
      const c = Math.cos(th), s = Math.sin(th);
      const bx = fx(cx + c * (outer + ARMS.tipGap)), by = cy + s * (outer + ARMS.tipGap);
      const anchor = c > ARMS.anchorCos ? "start" : c < -ARMS.anchorCos ? "end" : "middle";
      const wordY = s < -ARMS.anchorSin ? by - ARMS.wordLift : s > ARMS.anchorSin ? by + ARMS.wordDrop : by - ARMS.wordMid;
      labels.push({ ...spec.text, x: bx, y: fx(wordY), anchor, size: wordSize });
      labels.push({ ...spec.nonce, x: bx, y: fx(wordY + ARMS.nonceDrop), anchor, size: nonceSize, mono: true });
    };
    if (header) {
      headerModel = textual ? { text: armText(0) } : { cells: armCells(0) };
      armLabels(0, { text: { parts: [{ t: header.plaintext }] }, nonce: { parts: [{ t: header.nonce }] } });
    }
    for (let i = 0; i < rows; i++) {
      if (textual) { cells.push([]); textRows.push(armText(i + offset)); }
      else cells.push(armCells(i + offset));
      armLabels(i + offset, { text: { row: i, field: "plaintext" }, nonce: { row: i, field: "nonce" } });
    }
    return { width, height, cells, textRows, furniture, labels, header: headerModel, display };
  }

  const radial = (rows, cols, o) => armFamily(rows, cols, o, 0, "radial-text-");
  // the sketch's rosette twist, accumulated along the whole arm; the curl
  // runs counterclockwise so no arm count reads as a swastika
  const rosette = (rows, cols, o) => armFamily(rows, cols, o, -(o.sweep ?? ARMS.rosetteSweep), "rosette-text-");

  // ---------------------------------------------------------------- spiral
  // one spiral: every cell of every search sits on a single archimedean
  // coil, the initial value innermost, each word a consecutive run growing
  // outward. hex/ascii flow the text along the same coil, one run per
  // search. Words are called out left (leader to the run's first cell) and
  // nonces right (to its last).
  function spiral(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, header = null } = o;
    const display = o.display || "squares";
    const textual = display === "hex" || display === "ascii";
    const glyphs = o.glyphs || 64;
    const wordSize = o.wordSize || TYPE.word, nonceSize = o.nonceSize || TYPE.nonce;
    const cx = width / 2, cy = height / 2;
    const bands = rows + (header ? 1 : 0);
    const R = o.outer || height / 2 - SPIRAL.outerInset;
    const cells = [], labels = [], overlays = [], furniture = [];
    const textRows = textual ? [] : null;
    const wordX = CALLOUT.x, nonceX = width - CALLOUT.x;
    const yTop = CALLOUT.yTop, yStep = bands > 1 ? (height - 2 * CALLOUT.yTop) / (bands - 1) : 0;
    const callout = (b, spec, from, to) => {
      const mid = yTop + b * yStep;
      const y = fx(mid + wordSize * TYPE.baseline);
      overlays.push(P("line", { x1: fx(wordX + CALLOUT.leadGap), y1: fx(mid), x2: fx(from[0]), y2: fx(from[1]), stroke: "gridline" }));
      overlays.push(P("line", { x1: fx(nonceX - CALLOUT.leadGap), y1: fx(mid), x2: fx(to[0]), y2: fx(to[1]), stroke: "gridline" }));
      labels.push({ ...spec.text, x: wordX, y, anchor: "end", size: wordSize });
      labels.push({ ...spec.nonce, x: nonceX, y, anchor: "start", size: nonceSize, mono: true });
    };
    const bandSpec = b => (header && b === 0)
      ? { text: { parts: [{ t: header.plaintext }] }, nonce: { parts: [{ t: header.nonce }] } }
      : { text: { row: b - (header ? 1 : 0), field: "plaintext" }, nonce: { row: b - (header ? 1 : 0), field: "nonce" } };
    let headerModel = null;
    // one archimedean coil for everything. SPIRAL.loose sets the winding:
    // turn pitch = loose x the cell/glyph size, so runs sweep outward as
    // open arms instead of closing into rings.
    const r0 = SPIRAL.r0;
    const mkWalker = pitch => {
      const bc = pitch / (2 * Math.PI);
      let theta = r0 / bc;
      const phase = -Math.PI / 2 - theta; // the spiral starts at 12 o'clock
      const at = () => [cx + Math.cos(theta + phase) * bc * theta, cy + Math.sin(theta + phase) * bc * theta];
      const advance = dist => {
        const pts = [];
        let remaining = dist;
        while (remaining > 0) {
          const step = Math.min(remaining, SPIRAL.walkStep);
          theta += step / (bc * theta);
          remaining -= step;
          pts.push(at());
        }
        return pts;
      };
      return { at, advance };
    };
    if (textual) {
      // glyph size solved so all runs just fill the loose spiral
      const totalChars = bands * (glyphs + SPIRAL.gapChars);
      const size = Math.min(SPIRAL.textSizeCap, Math.round(Math.sqrt(Math.PI * (R * R - r0 * r0) / (SPIRAL.loose * TYPE.advance * totalChars))));
      const charW = size * TYPE.advance;
      const walk = mkWalker(size * SPIRAL.loose);
      for (let b = 0; b < bands; b++) {
        const start = walk.at();
        const pts = [start, ...walk.advance(glyphs * charW)];
        const spec = {
          paths: [{ pathD: "M " + pts.map(p => fx(p[0]) + " " + fx(p[1])).join(" L "), id: "spiral-text-" + b }],
          size, perLine: glyphs, placeholder: "·".repeat(glyphs)
        };
        if (header && b === 0) headerModel = { text: spec };
        else { cells.push([]); textRows.push(spec); }
        callout(b, bandSpec(b), start, pts[pts.length - 1]);
        walk.advance(SPIRAL.gapChars * charW); // breathing room before the next run
      }
    } else {
      // cell size solved the same way: N cells at their run spacing fill it
      const N = bands * cols;
      const d = Math.sqrt(Math.PI * (R * R - r0 * r0) / (SPIRAL.loose * SPIRAL.runSpacing * N));
      const space = d * SPIRAL.runSpacing;
      // sizing: "fill" plumps cells into the inter-winding gap; "overlap"
      // shingles them along the run, as the original rosettes' petals did;
      // "shrink" starts large and tapers as the coil winds out
      const sizing = o.sizing || "fit";
      const beadR = sizing === "fill" ? d * SPIRAL.loose * SIZING.beadFillShare
        : sizing === "overlap" ? d * SIZING.overlapBead
        : sizing === "shrink" ? d * SIZING.shrinkStart
        : d * SIZING.beadFit;
      const side = sizing === "fill" ? d * SIZING.sideFill : sizing === "overlap" ? d * SIZING.sideOverlap : d * SIZING.sideFit;
      const taper = t => 1 - SIZING.taper * t;
      const tOf = (sx, sy) => Math.min(1, Math.max(0, (Math.hypot(sx - cx, sy - cy) - r0) / (R - r0)));
      const walk = mkWalker(d * SPIRAL.loose);
      for (let b = 0; b < bands; b++) {
        const row = [], run = [];
        for (let k = 0; k < cols; k++) {
          walk.advance(space / 2);
          const [sx, sy] = walk.at();
          walk.advance(space / 2);
          run.push([sx, sy]);
          const s = sizing === "shrink" ? taper(tOf(sx, sy)) : 1;
          // shrink keeps neighbouring cells on the run overlapping
          const floor = sizing === "shrink" ? d * SIZING.spiralShrinkFloor : ARMS.minHalf;
          if (display === "circles") row.push(P("circle", { cx: fx(sx), cy: fx(sy), r: fx(Math.max(floor, beadR * s)) }));
          else {
            const sd = Math.max(SPIRAL.minSide, side * s);
            row.push(P("rect", { x: fx(sx - sd / 2), y: fx(sy - sd / 2), width: fx(sd), height: fx(sd) }));
          }
        }
        if (header && b === 0) headerModel = { cells: row };
        else cells.push(row);
        callout(b, bandSpec(b), run[0], run[run.length - 1]);
        walk.advance(d * SPIRAL.runGap); // breathing room before the next run
      }
    }
    return { width, height, cells, textRows, furniture, overlays, labels, header: headerModel, display };
  }

  // ---------------------------------------------------------------- gutter
  // text on the left of a centre gutter, colour on the right
  function gutter(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, cellGap = GUTTER.cellGap, header = null } = o;
    const display = o.display || "squares"; // squares | circles | hex | ascii
    const textual = display === "hex" || display === "ascii";
    const glyphs = o.glyphs || 64; // characters per text row (64 hex, 32 ascii)
    // the header row (the initial value) uses the top band, not left empty
    const top = o.top ?? (header ? GUTTER.topWithHeader : GUTTER.top);
    const wordSize = o.wordSize || TYPE.word, nonceSize = o.nonceSize || TYPE.nonce;
    const slots = rows + (header ? 1 : 0);
    const rowHeight = (height - top - GUTTER.bottom) / slots;
    // words and nonces left of the gutter; the hash field takes all the
    // width to the right of it.
    // GUTTER.x is the x of the gutter line: the label column ends just left
    // of it and the hash field starts GUTTER.fieldGap right of it. Widen it
    // for a series with longer words or bigger label type; the hash field
    // gives up exactly what the labels gain.
    const gutterX = o.gutterX || GUTTER.x;
    const x0 = gutterX + GUTTER.fieldGap;
    const region = width - COLUMNS.margin - x0;
    const side = Math.min((region - cellGap * (cols - 1)) / cols, rowHeight - GUTTER.cellPad); // square cells
    // the word|nonce divider mirrors the nonce|hash gutter line: each label
    // column ends GUTTER.nonceInset left of its bar
    const wordBarX = gutterX - GUTTER.wordInset + GUTTER.nonceInset;
    const cells = [], labels = [], furniture = [
      P("line", { x1: fx(gutterX), y1: fx(top - GUTTER.ruleLift), x2: fx(gutterX), y2: fx(top + slots * rowHeight), stroke: "soft" }),
      P("line", { x1: fx(wordBarX), y1: fx(top - GUTTER.ruleLift), x2: fx(wordBarX), y2: fx(top + slots * rowHeight), stroke: "soft" })
    ];
    const rowCells = mid => {
      const row = [];
      for (let k = 0; k < cols; k++) {
        const x = x0 + k * (side + cellGap);
        row.push(display === "circles"
          ? P("circle", { cx: fx(x + side / 2), cy: fx(mid), r: fx(side / 2) })
          : P("rect", { x: fx(x), y: fx(mid - side / 2), width: fx(side), height: fx(side) }));
      }
      return row;
    };
    const textRow = mid => textRowSpec(x0, region, glyphs, rowHeight, mid, display);
    const textRows = textual ? [] : null;
    const rowLabels = (mid, spec) => {
      const y = fx(mid + wordSize * TYPE.baseline);
      labels.push({ ...spec.text, x: gutterX - GUTTER.wordInset, y, anchor: "end", size: wordSize });
      labels.push({ ...spec.nonce, x: gutterX - GUTTER.nonceInset, y, anchor: "end", size: nonceSize, mono: true });
    };
    let headerModel = null;
    if (header) {
      const mid = top + rowHeight / 2;
      furniture.push(P("line", { x1: COLUMNS.margin, y1: fx(mid + rowHeight / 2), x2: fx(width - COLUMNS.margin), y2: fx(mid + rowHeight / 2), stroke: "soft" }));
      headerModel = textual ? { text: textRow(mid) } : { cells: rowCells(mid) };
      rowLabels(mid, { text: { parts: [{ t: header.plaintext }] }, nonce: { parts: [{ t: header.nonce }] } });
    }
    for (let i = 0; i < rows; i++) {
      const mid = top + (i + (header ? 1 : 0)) * rowHeight + rowHeight / 2;
      if (i < rows - 1) // interior separators only: no bottom rule
        furniture.push(P("line", { x1: COLUMNS.margin, y1: fx(mid + rowHeight / 2), x2: fx(width - COLUMNS.margin), y2: fx(mid + rowHeight / 2), stroke: "soft" }));
      if (textual) { cells.push([]); textRows.push(textRow(mid)); }
      else cells.push(rowCells(mid));
      rowLabels(mid, { text: { row: i, field: "plaintext" }, nonce: { row: i, field: "nonce" } });
    }
    return { width, height, cells, textRows, furniture, labels, header: headerModel, topRuleY: top - GUTTER.ruleLift, display };
  }

  const layouts = { plate, rings, hexRing, honeycomb, radial, rosette, spiral, gutter };

  // build(name, rows, cols, options) -> model
  function build(name, rows, cols, options = {}) {
    const fn = layouts[name];
    if (!fn) throw new Error("unknown layout " + name);
    const model = fn(rows, cols, options);
    model.name = name;
    model.rows = rows;
    model.cols = cols;
    if (options.decorations === false) model.furniture = [];
    if (options.labels === false) { model.labels = []; model.overlays = []; }
    return model;
  }

  grinding.layout = { layouts, layoutNames: Object.keys(layouts), build };
})();
