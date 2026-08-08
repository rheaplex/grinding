// Render package — one model, two outputs.
// mount() puts the model in the live DOM and hands back fill operations;
// toSVG() serialises the same model and state to a standalone file. Both read
// the identical primitives, so the export matches the frame exactly.
(function () {
  const grinding = window.grinding = window.grinding || {};

  const NS = "http://www.w3.org/2000/svg";
  const MONO = "ui-monospace, Menlo, Consolas, monospace";
  const defaults = { ground: "#ffffff", ink: "#16161a", grid: "#d5d2cb", ruleSoft: "#ecebe6", magic: "#d0281e", hairline: 0.75 };

  // layouts mark soft rules with stroke: "soft"; the theme supplies the colour
  const themed = (attrs, t) => attrs.stroke === "soft" ? { ...attrs, stroke: t.ruleSoft } : attrs;

  function el(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  // wrap a static text over a row's baselines, centring when it needs fewer
  // lines than the row provides (e.g. the short initial value on a hex row)
  function headerLines(spec, text) {
    const used = Math.max(1, Math.ceil(text.length / spec.perLine));
    if (used >= spec.baselines.length)
      return spec.baselines.map((y, l) => [y, text.slice(l * spec.perLine, (l + 1) * spec.perLine)])
        .filter(([, str]) => str);
    const mid = spec.baselines.reduce((a, y) => a + y, 0) / spec.baselines.length;
    return [[Number(mid.toFixed(2)), text]];
  }

  function mount(host, model, theme = {}) {
    const t = { ...defaults, ...theme };
    host.textContent = "";
    // the viewBox carries the 16:9 frame; the host's CSS sizes the element and
    // preserveAspectRatio letterboxes it, so the drawing scales with the window
    const svg = el("svg", { viewBox: "0 0 " + model.width + " " + model.height, preserveAspectRatio: "xMidYMid meet" });
    svg.style.display = "block";
    svg.appendChild(el("rect", { width: model.width, height: model.height, fill: t.ground }));

    const gFurniture = el("g", { fill: "none", stroke: t.ink, "stroke-width": 1 });
    for (const p of model.furniture) gFurniture.appendChild(el(p.tag, themed(p.attrs, t)));
    svg.appendChild(gFurniture);

    // the initial-value row: static, from the preimage bytes
    if (model.header) {
      if (model.header.cells) {
        const g = el("g", {});
        model.header.cells.forEach((p, k) => {
          const c = (model.headerColours || [])[k];
          g.appendChild(el(p.tag, { ...p.attrs, fill: c || "none", stroke: c ? "none" : t.grid, "stroke-width": 1 }));
        });
        svg.appendChild(g);
      } else if (model.header.text && model.headerText != null) {
        const s = model.header.text;
        for (const [y, str] of headerLines(s, model.headerText)) {
          const node = el("text", {
            x: s.x, y, "font-size": s.size, "font-family": MONO, fill: t.ink,
            lengthAdjust: "spacingAndGlyphs", textLength: (str.length * s.cw).toFixed(2)
          });
          node.textContent = str;
          svg.appendChild(node);
        }
      }
    }

    // text display: two nodes per row — the matched prefix, then the rest —
    // on a fixed character grid so rows align regardless of content
    const textRowNodes = (model.textRows || []).map(s => {
      const mk = (y, fill) => {
        const node = el("text", {
          x: s.x, y, "font-size": s.size, "font-family": MONO, fill,
          lengthAdjust: "spacingAndGlyphs"
        });
        svg.appendChild(node);
        return node;
      };
      return { spec: s, lines: s.baselines.map(y => ({ head: mk(y, t.magic), tail: mk(y, t.ink) })) };
    });
    const setText = (node, str, x, len) => {
      node.textContent = str;
      node.setAttribute("x", x.toFixed(2));
      if (str.length) node.setAttribute("textLength", len.toFixed(2));
      else node.removeAttribute("textLength");
    };

    const rowNodes = model.cells.map(row => {
      const g = el("g", {});
      const nodes = row.map(p => {
        const node = el(p.tag, { ...p.attrs, fill: "none", stroke: t.grid, "stroke-width": 1 });
        g.appendChild(node);
        return node;
      });
      svg.appendChild(g);
      return nodes;
    });

    const magicNodes = model.cells.map(() => []);
    const labelNodes = model.labels.map(l => {
      const node = el("text", {
        x: l.x, y: l.y, "text-anchor": l.anchor || "start", "font-size": l.size || 12,
        "font-family": l.mono ? "ui-monospace, Menlo, Consolas, monospace" : "Helvetica Neue, Helvetica, sans-serif",
        fill: t.grid
      });
      if (l.parts) {
        // static label, e.g. the initial value: fixed parts, never repainted
        node.removeAttribute("fill");
        for (const p of l.parts) {
          const ts = el("tspan", { fill: p.dim ? t.grid : t.ink });
          ts.textContent = p.t;
          node.appendChild(ts);
        }
      }
      svg.appendChild(node);
      return { node, spec: l };
    });

    host.appendChild(svg);

    return {
      svg,
      // paint one row; magic = leading cells to keyline / characters to redden
      fillRow(i, colours, magic = 0, locked = true) {
        if (textRowNodes.length) {
          const tr = textRowNodes[i];
          if (!tr) return;
          const { x, cw, perLine } = tr.spec;
          tr.lines.forEach((ln, l) => {
            const str = colours.slice(l * perLine, (l + 1) * perLine);
            const m = Math.max(0, Math.min(magic - l * perLine, str.length));
            setText(ln.head, str.slice(0, m), x, m * cw);
            setText(ln.tail, str.slice(m), x + m * cw, (str.length - m) * cw);
            ln.tail.setAttribute("fill", locked ? t.ink : t.grid);
          });
          return;
        }
        const nodes = rowNodes[i];
        if (!nodes) return;
        for (let k = 0; k < nodes.length; k++) {
          nodes[k].setAttribute("fill", colours[k] || "none");
          nodes[k].setAttribute("stroke", colours[k] ? "none" : t.grid);
          nodes[k].setAttribute("stroke-width", 1);
        }
        if (magicNodes[i].length !== magic) {
          for (const node of magicNodes[i]) node.remove();
          magicNodes[i] = [];
          for (let k = 0; k < magic && k < nodes.length; k++) {
            const p = model.cells[i][k];
            const node = el(p.tag, { ...p.attrs, fill: "none", stroke: t.magic, "stroke-width": 2 });
            this.svg.appendChild(node);
            magicNodes[i].push(node);
          }
        }
      },
      clearRow(i) {
        if (textRowNodes.length) {
          const tr = textRowNodes[i];
          if (tr) for (const ln of tr.lines) { setText(ln.head, "", tr.spec.x, 0); setText(ln.tail, "", tr.spec.x, 0); }
          return;
        }
        for (const node of rowNodes[i] || []) {
          node.setAttribute("fill", "none");
          node.setAttribute("stroke", t.grid);
          node.setAttribute("stroke-width", 1);
        }
        for (const node of magicNodes[i]) node.remove();
        magicNodes[i] = [];
      },
      setLabels(records, activeRow, extras = {}) {
        for (const { node, spec } of labelNodes) {
          if (spec.parts) continue;
          const rec = records[spec.row];
          if (!rec) continue;
          // activeRow -1 = done (nothing pending); below -1 = lead-in (all pending)
          const pending = activeRow !== -1 && spec.row > activeRow;
          const active = spec.row === activeRow;
          if (spec.field === "plaintext") {
            // letters that have matched in black; the rest stay grid-grey
            const m = extras.matched ? extras.matched[spec.row] : (rec.matchedChars ?? rec.totalChars ?? rec.plaintext.length);
            node.textContent = "";
            const head = el("tspan", { fill: t.ink });
            head.textContent = rec.plaintext.slice(0, m);
            const tail = el("tspan", { fill: t.grid });
            tail.textContent = rec.plaintext.slice(m);
            node.appendChild(head);
            node.appendChild(tail);
            node.removeAttribute("fill");
            continue;
          }
          const value = spec.field === "nonce"
            ? (pending ? "—" : (active ? extras.liveNonce : rec.nonce).toLocaleString("en-US"))
            : rec[spec.field];
          node.textContent = value;
          node.setAttribute("fill", pending ? t.grid : (active ? t.magic : t.ink));
        }
      },
      showGrid(on) {
        for (const nodes of rowNodes)
          for (const node of nodes)
            if (node.getAttribute("fill") === "none") node.setAttribute("stroke", on ? t.grid : "none");
      }
    };
  }

  // state: { rows: [colours|null], magic: [n], records }
  function toSVG(model, state, theme = {}, meta = []) {
    const t = { ...defaults, ...theme };
    const attr = a => Object.entries(a).map(([k, v]) => k + '="' + v + '"').join(" ");
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const scale = theme.exportScale || 2;
    let out = '<svg xmlns="' + NS + '" width="' + model.width * scale + '" height="' + model.height * scale +
      '" viewBox="0 0 ' + model.width + " " + model.height + '">\n';
    if (meta.length) out += "  <metadata>\n" + meta.map(m => "    " + m).join("\n") + "\n  </metadata>\n";
    out += '  <rect width="' + model.width + '" height="' + model.height + '" fill="' + t.ground + '"/>\n';
    for (const p of model.furniture)
      out += "  <" + p.tag + " " + attr({ fill: "none", stroke: t.ink, "stroke-width": 1, ...themed(p.attrs, t) }) + "/>\n";
    const textNode = (x, y, size, str, len, fill) => str.length
      ? '  <text ' + attr({
          x: typeof x === "number" ? x.toFixed(2) : x, y, "font-size": size, "font-family": MONO, fill,
          lengthAdjust: "spacingAndGlyphs", textLength: len.toFixed(2)
        }) + ">" + esc(str) + "</text>\n"
      : "";
    if (model.header) {
      if (model.header.cells)
        model.header.cells.forEach((p, k) => {
          const c = (model.headerColours || [])[k];
          out += "  <" + p.tag + " " + attr({ ...p.attrs, fill: c || "none", stroke: c ? "none" : t.grid, "stroke-width": 1 }) + "/>\n";
        });
      else if (model.header.text && model.headerText != null) {
        const s = model.header.text;
        for (const [y, str] of headerLines(s, model.headerText))
          out += textNode(s.x, y, s.size, str, str.length * s.cw, t.ink);
      }
    }
    if (model.textRows) {
      state.rows.forEach((value, i) => {
        if (!value) return;
        const tr = model.textRows[i];
        const locked = state.activeRow !== i;
        tr.baselines.forEach((y, l) => {
          const str = value.slice(l * tr.perLine, (l + 1) * tr.perLine);
          const m = Math.max(0, Math.min((state.magic[i] || 0) - l * tr.perLine, str.length));
          out += textNode(tr.x, y, tr.size, str.slice(0, m), m * tr.cw, t.magic);
          out += textNode(tr.x + m * tr.cw, y, tr.size, str.slice(m), (str.length - m) * tr.cw, locked ? t.ink : t.grid);
        });
      });
    } else
      model.cells.forEach((row, i) => {
        const colours = state.rows[i];
        row.forEach((p, k) => {
          const fill = colours ? colours[k] : "none";
          out += "  <" + p.tag + " " + attr({ ...p.attrs, fill, stroke: fill === "none" ? t.grid : "none", "stroke-width": 1 }) + "/>\n";
        });
        if (colours && state.magic[i])
          for (let k = 0; k < state.magic[i] && k < row.length; k++)
            out += "  <" + row[k].tag + " " + attr({ ...row[k].attrs, fill: "none", stroke: t.magic, "stroke-width": 2 }) + "/>\n";
      });
    for (const l of model.labels) {
      const open = fill => '  <text ' + attr({
        x: l.x, y: l.y, "text-anchor": l.anchor || "start", "font-size": l.size || 12,
        "font-family": l.mono ? "ui-monospace, Menlo, Consolas, monospace" : "Helvetica Neue, Helvetica, sans-serif",
        ...(fill ? { fill } : {})
      }) + ">";
      if (l.parts) {
        out += open(null) +
          l.parts.map(p => '<tspan fill="' + (p.dim ? t.grid : t.ink) + '">' + esc(p.t) + "</tspan>").join("") +
          "</text>\n";
        continue;
      }
      const rec = state.records && state.records[l.row];
      if (!rec) continue;
      const painted = !!state.rows[l.row];
      const active = state.activeRow === l.row;
      if (l.field === "plaintext") {
        const m = state.matched ? state.matched[l.row] : (rec.matchedChars ?? rec.totalChars ?? rec.plaintext.length);
        out += open(null) +
          '<tspan fill="' + t.ink + '">' + esc(rec.plaintext.slice(0, m)) + "</tspan>" +
          '<tspan fill="' + t.grid + '">' + esc(rec.plaintext.slice(m)) + "</tspan>" +
          "</text>\n";
        continue;
      }
      const text = l.field === "nonce"
        ? (painted || active ? (active ? state.liveNonce : rec.nonce).toLocaleString("en-US") : "—")
        : rec[l.field];
      out += open(painted || active ? (active ? t.magic : t.ink) : t.grid) + text + "</text>\n";
    }
    return out + "</svg>\n";
  }

  function download(name, svgText) {
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  grinding.render = { defaults, mount, toSVG, download };
})();
