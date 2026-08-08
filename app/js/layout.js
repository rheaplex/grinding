// Layout package — arrangement only. Every layout returns the same model:
//   { width, height, cells: [row][cell] -> primitive, furniture: [primitive], labels: [label] }
// A primitive is { tag, attrs } ready for SVG. Nothing here knows about colour,
// data or time: it is handed a row count and a cell count and returns geometry.
(function () {
  const grinding = window.grinding = window.grinding || {};

  const P = (tag, attrs) => ({ tag, attrs });
  const fx = n => Number(n.toFixed(2));

  // every layout composes into the same 16:9 frame
  const FRAME = { width: 1600, height: 900 };

  function polygonPoints(pts) {
    return pts.map(p => fx(p[0]) + "," + fx(p[1])).join(" ");
  }

  // ---------------------------------------------------------------- plate
  function plate(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, gap = 0.06 } = o;
    const w = width / cols, h = height / rows, g = gap * w;
    const cells = [];
    for (let i = 0; i < rows; i++) {
      const row = [];
      for (let k = 0; k < cols; k++)
        row.push(P("rect", { x: fx(k * w + g), y: fx(i * h + g), width: fx(w - 2 * g), height: fx(h - 2 * g) }));
      cells.push(row);
    }
    return { width, height, cells, furniture: [], labels: [] };
  }

  // ---------------------------------------------------------------- rings
  function rings(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, inner = 62, outer = height / 2 - 30 } = o;
    const cx = width / 2, cy = height / 2, tr = (outer - inner) / rows;
    const pt = (r, a) => fx(cx + Math.cos(a) * r) + " " + fx(cy + Math.sin(a) * r);
    const cells = [];
    for (let i = 0; i < rows; i++) {
      const ro = outer - i * tr - 1, ri = ro - tr + 2, row = [];
      for (let k = 0; k < cols; k++) {
        const a0 = -Math.PI / 2 + (k / cols) * Math.PI * 2;
        const a1 = -Math.PI / 2 + ((k + 1) / cols) * Math.PI * 2;
        row.push(P("path", {
          d: "M " + pt(ro, a0) + " A " + fx(ro) + " " + fx(ro) + " 0 0 1 " + pt(ro, a1) +
             " L " + pt(ri, a1) + " A " + fx(ri) + " " + fx(ri) + " 0 0 0 " + pt(ri, a0) + " Z"
        }));
      }
      cells.push(row);
    }
    return {
      width, height, cells,
      furniture: [P("circle", { cx: fx(cx), cy: fx(cy), r: fx(inner - 10), fill: "none" })],
      labels: []
    };
  }

  // ---------------------------------------------------------------- hexRing
  function hexRing(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, inner = 62, outer = height / 2 - 30 } = o;
    const cx = width / 2, cy = height / 2, tr = (outer - inner) / rows;
    const point = (r, t) => {
      const seg = t * 6, n = Math.floor(seg) % 6, f = seg - Math.floor(seg);
      const a0 = -Math.PI / 2 + n * Math.PI / 3, a1 = a0 + Math.PI / 3;
      const x0 = Math.cos(a0) * r, y0 = Math.sin(a0) * r;
      const x1 = Math.cos(a1) * r, y1 = Math.sin(a1) * r;
      return [cx + x0 + (x1 - x0) * f, cy + y0 + (y1 - y0) * f];
    };
    const span = (r, t0, t1) => {
      const pts = [point(r, t0)];
      for (let c = Math.ceil(t0 * 6); c < t1 * 6 - 1e-9; c++) pts.push(point(r, c / 6));
      pts.push(point(r, t1));
      return pts;
    };
    const cells = [];
    for (let i = 0; i < rows; i++) {
      const ro = outer - i * tr - 1, ri = ro - tr + 2, row = [];
      for (let k = 0; k < cols; k++)
        row.push(P("polygon", { points: polygonPoints(span(ro, k / cols, (k + 1) / cols).concat(span(ri, k / cols, (k + 1) / cols).reverse())) }));
      cells.push(row);
    }
    const core = outer - rows * tr + 2 - 14;
    return { width, height, cells, furniture: [P("polygon", { points: polygonPoints(span(core, 0, 1)), fill: "none" })], labels: [] };
  }

  // ---------------------------------------------------------------- honeycomb
  function honeycomb(rows, cols, o) {
    const width = o.width || FRAME.width, height = o.height || FRAME.height, margin = 24;
    // the comb sizes itself to whichever frame edge binds, and centres
    const rFromW = (width - 2 * margin) / (cols + 0.5) / Math.sqrt(3);
    const rFromH = (height - 2 * margin) / ((rows - 1) * 1.5 + 2);
    const r = Math.min(rFromW, rFromH), w = r * Math.sqrt(3), pitch = 1.5 * r;
    const xLeft = (width - w * (cols + 0.5)) / 2;
    const yTop = (height - ((rows - 1) * pitch + 2 * r)) / 2 + r;
    const inset = (o.gap ?? 0.06) * 6;
    const cells = [];
    for (let i = 0; i < rows; i++) {
      const row = [];
      for (let k = 0; k < cols; k++) {
        const cx = xLeft + w / 2 + k * w + (i % 2 ? w / 2 : 0), cy = yTop + i * pitch;
        const pts = Array.from({ length: 6 }, (_, n) => {
          const a = -Math.PI / 2 + n * Math.PI / 3;
          return [cx + Math.cos(a) * (r - inset), cy + Math.sin(a) * (r - inset)];
        });
        row.push(P("polygon", { points: polygonPoints(pts) }));
      }
      cells.push(row);
    }
    return { width, height, cells, furniture: [], labels: [] };
  }

  // ---------------------------------------------------------------- rosettes
  function rosettes(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, petals = 7 } = o;
    const columns = o.columns || Math.ceil(Math.sqrt(rows * width / height));
    const gridRows = Math.ceil(rows / columns);
    const dx = width / columns, dy = height / gridRows;
    const rad = Math.min(dx, dy) * 0.44;
    const bands = Math.max(1, Math.round(cols / petals));
    const cells = [];
    for (let i = 0; i < rows; i++) {
      const gr = Math.floor(i / columns), gc = i % columns;
      const px = dx * (gc + 0.5) + (gr % 2 ? dx * 0.12 : -dx * 0.12), py = dy * (gr + 0.5);
      const row = [];
      for (let k = 0; k < cols; k++) {
        const band = Math.floor(k / petals), j = k % petals;
        const rr = rad * (0.32 + 0.64 * (band + 1) / bands);
        const a = -Math.PI / 2 + (j / petals) * Math.PI * 2 + band * 0.28;
        row.push(P("circle", {
          cx: fx(px + Math.cos(a) * rr), cy: fx(py + Math.sin(a) * rr),
          r: fx(rad * 0.17 - band * rad * 0.012)
        }));
      }
      cells.push(row);
    }
    return { width, height, cells, furniture: [], labels: [] };
  }

  // ---------------------------------------------------------------- gutter
  // text on the left of a centre gutter, colour on the right
  function gutter(rows, cols, o) {
    const { width = FRAME.width, height = FRAME.height, cellGap = 2, header = null } = o;
    const display = o.display || "squares"; // squares | circles | hex | ascii
    const textual = display === "hex" || display === "ascii";
    const glyphs = o.glyphs || 64; // characters per text row (64 hex, 32 ascii)
    // the header row (the initial value) uses the top band, not left empty
    const top = o.top ?? (header ? 44 : 64);
    const wordSize = o.wordSize || 24, nonceSize = o.nonceSize || 18;
    const slots = rows + (header ? 1 : 0);
    const rowHeight = (height - top - 64) / slots;
    // words and nonces left of the gutter; the hash field takes all the
    // width to the right of it.
    // gutterX is the x of the gutter line: the label column ends just left
    // of it (nonce at gutterX-24, word at gutterX-260, both right-aligned)
    // and the hash field starts 20px right of it. Widen it for a series
    // with longer words or bigger label type; the hash field gives up
    // exactly what the labels gain.
    const gutterX = o.gutterX || 380;
    const x0 = gutterX + 20;
    const region = width - 20 - x0;
    // long text wraps: 64 hex digits become two lines of 32, doubling the
    // glyph size to the same character grid the ascii view uses
    const perLine = Math.min(glyphs, 32);
    const textLines = Math.ceil(glyphs / perLine);
    const glyphW = region / perLine;
    const glyphSize = Math.min(Math.round((rowHeight - 16) / (textLines * 1.15)), Math.round(glyphW / 0.62));
    const side = Math.min((region - cellGap * (cols - 1)) / cols, rowHeight - 16); // square cells
    const cells = [], labels = [], furniture = [
      P("line", { x1: fx(gutterX), y1: fx(top - 12), x2: fx(gutterX), y2: fx(top + slots * rowHeight), stroke: "soft" })
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
    const textRow = mid => {
      const pitch = glyphSize * 1.15;
      return {
        x: fx(x0), size: glyphSize, cw: glyphW, perLine,
        baselines: Array.from({ length: textLines }, (_, l) =>
          fx(mid - pitch * (textLines - 1) / 2 + l * pitch + glyphSize * 0.32))
      };
    };
    const textRows = textual ? [] : null;
    const rowLabels = (mid, spec) => {
      const y = fx(mid + wordSize * 0.32);
      labels.push({ ...spec.text, x: gutterX - 260, y, anchor: "end", size: wordSize });
      labels.push({ ...spec.nonce, x: gutterX - 24, y, anchor: "end", size: nonceSize, mono: true });
    };
    let headerModel = null;
    if (header) {
      const mid = top + rowHeight / 2;
      furniture.push(P("line", { x1: 20, y1: fx(mid + rowHeight / 2), x2: fx(width - 20), y2: fx(mid + rowHeight / 2), stroke: "soft" }));
      headerModel = textual ? { text: textRow(mid) } : { cells: rowCells(mid) };
      rowLabels(mid, { text: { parts: [{ t: header.plaintext }] }, nonce: { parts: [{ t: header.nonce }] } });
    }
    for (let i = 0; i < rows; i++) {
      const mid = top + (i + (header ? 1 : 0)) * rowHeight + rowHeight / 2;
      if (i < rows - 1) // interior separators only: no bottom rule
        furniture.push(P("line", { x1: 20, y1: fx(mid + rowHeight / 2), x2: fx(width - 20), y2: fx(mid + rowHeight / 2), stroke: "soft" }));
      if (textual) { cells.push([]); textRows.push(textRow(mid)); }
      else cells.push(rowCells(mid));
      rowLabels(mid, { text: { row: i, field: "plaintext" }, nonce: { row: i, field: "nonce" } });
    }
    return { width, height, cells, textRows, furniture, labels, header: headerModel, topRuleY: top - 12, display };
  }

  const layouts = { plate, rings, hexRing, honeycomb, rosettes, gutter };

  // build(name, rows, cols, options) -> model
  function build(name, rows, cols, options = {}) {
    const fn = layouts[name];
    if (!fn) throw new Error("unknown layout " + name);
    const model = fn(rows, cols, options);
    model.name = name;
    model.rows = rows;
    model.cols = cols;
    if (options.decorations === false) model.furniture = [];
    if (options.labels === false) model.labels = [];
    return model;
  }

  grinding.layout = { layouts, layoutNames: Object.keys(layouts), build };
})();
