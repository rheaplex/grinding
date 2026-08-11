// Render package — one model, two outputs.
// mount() puts the model in the live DOM and hands back fill operations;
// toSVG() serialises the same model and state to a standalone file. Both read
// the identical primitives, so the export matches the frame exactly.
(function () {
  const grinding = window.grinding = window.grinding || {};

  const NS = "http://www.w3.org/2000/svg";
  const MONO = "ui-monospace, Menlo, Consolas, monospace";
  const HALO_STROKE = 3; // the match keyline's width; half shows as the halo
  const defaults = { ground: "#ffffff", ink: "#16161a", grid: "#d5d2cb", ruleSoft: "#ecebe6", magic: "#d0281e", magicWeight: "400", hairline: 0.75 };

  // layouts mark rule strokes with tokens; the theme supplies the colours
  const STROKE_TOKENS = { soft: "ruleSoft", gridline: "grid" };
  const themed = (attrs, t) => STROKE_TOKENS[attrs.stroke]
    ? { ...attrs, stroke: t[STROKE_TOKENS[attrs.stroke]] }
    : attrs;

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

    // circular text (rings) rides SVG paths kept in defs
    let defsNode = null;
    const circPath = s => {
      if (!defsNode) { defsNode = el("defs", {}); svg.insertBefore(defsNode, svg.firstChild); }
      defsNode.appendChild(el("path", { id: s.id, d: s.pathD, fill: "none" }));
    };

    // three layers, bottom to top: grey placeholders (empty rows and the
    // header's empty cells), the red match halos above them, and everything
    // filled on top — so a halo never crosses a filled shape, and grey
    // outlines never cross a halo or a filled shape
    const gEmpty = el("g", {});
    svg.appendChild(gEmpty);
    const gMagic = el("g", {});
    svg.appendChild(gMagic);
    const gFilled = el("g", {});
    svg.appendChild(gFilled);
    const toLayer = (node, layer) => { if (node.parentNode !== layer) layer.appendChild(node); };

    // text display: two nodes per row — the matched prefix, then the rest —
    // on a fixed character grid so rows align regardless of content
    const textRowNodes = (model.textRows || []).map(s => {
      const topNodes = [];
      if (s.paths) {
        const pathLines = s.paths.map(p => {
          circPath(p);
          const node = el("text", { "font-size": s.size, "font-family": MONO });
          const tp = el("textPath", { href: "#" + p.id });
          const head = el("tspan", { fill: t.magic, "font-weight": t.magicWeight });
          const tail = el("tspan", { fill: t.ink });
          tp.appendChild(head);
          tp.appendChild(tail);
          node.appendChild(tp);
          gEmpty.appendChild(node);
          topNodes.push(node);
          return { head, tail };
        });
        return { spec: s, pathLines, topNodes };
      }
      const mk = (y, fill, weight) => {
        const node = el("text", {
          x: s.x, y, "font-size": s.size, "font-family": MONO, fill,
          lengthAdjust: "spacingAndGlyphs", ...(weight ? { "font-weight": weight } : {})
        });
        gEmpty.appendChild(node);
        topNodes.push(node);
        return node;
      };
      return { spec: s, lines: s.baselines.map(y => ({ head: mk(y, t.magic, t.magicWeight), tail: mk(y, t.ink) })), topNodes };
    });
    const setText = (node, str, x, len) => {
      node.textContent = str;
      node.setAttribute("x", x.toFixed(2));
      if (str.length) node.setAttribute("textLength", len.toFixed(2));
      else node.removeAttribute("textLength");
    };
    // an empty row shows its placeholder dots, in the underlay layer
    const restRow = tr => {
      tr.topNodes.forEach(n => toLayer(n, gEmpty));
      if (tr.pathLines) {
        const { perLine, placeholder = "" } = tr.spec;
        tr.pathLines.forEach((ln, l) => {
          ln.head.textContent = "";
          ln.tail.textContent = placeholder.slice(l * perLine, (l + 1) * perLine);
          ln.tail.setAttribute("fill", t.grid);
        });
        return;
      }
      const { x, cw, perLine } = tr.spec;
      tr.lines.forEach((ln, l) => {
        const str = (tr.spec.placeholder || "").slice(l * perLine, (l + 1) * perLine);
        setText(ln.head, "", x, 0);
        setText(ln.tail, str, x, str.length * cw);
        ln.tail.setAttribute("fill", t.grid);
      });
    };
    textRowNodes.forEach(restRow);

    // the initial-value row, from the preimage bytes: grey like a pending row
    // until the lead-in rest ends, then filled with the base word's cells or
    // characters marked exactly as a matched prefix is on the search rows
    let headerBody = null;
    if (model.header && model.header.cells) {
      const magic = model.headerMagic || 0;
      const gF = el("g", {}), gE = el("g", {});
      const coloured = [];
      model.header.cells.forEach((p, k) => {
        const c = (model.headerColours || [])[k];
        const node = el(p.tag, { ...p.attrs, fill: "none", stroke: t.grid, "stroke-width": 1 });
        if (c) { gF.appendChild(node); coloured.push({ node, c }); }
        else gE.appendChild(node);
      });
      gEmpty.appendChild(gE);
      gEmpty.appendChild(gF);
      let halos = [];
      headerBody = on => {
        toLayer(gF, on ? gFilled : gEmpty);
        for (const { node, c } of coloured) {
          node.setAttribute("fill", on ? c : "none");
          node.setAttribute("stroke", on ? "none" : t.grid);
        }
        if (on && !halos.length) {
          for (let k = 0; k < magic && k < model.header.cells.length; k++) {
            const p = model.header.cells[k];
            const node = el(p.tag, { ...p.attrs, fill: "none", stroke: t.magic, "stroke-width": HALO_STROKE });
            gMagic.appendChild(node);
            halos.push(node);
          }
        } else if (!on) {
          for (const node of halos) node.remove();
          halos = [];
        }
      };
    } else if (model.header && model.header.text && model.headerText != null) {
      const magic = model.headerMagic || 0;
      const s = model.header.text;
      if (s.paths) {
        const lines = s.paths.map(p => {
          circPath(p);
          const node = el("text", { "font-size": s.size, "font-family": MONO });
          const tp = el("textPath", { href: "#" + p.id });
          const head = el("tspan", { fill: t.magic, "font-weight": t.magicWeight });
          const tail = el("tspan", { fill: t.grid });
          tp.appendChild(head);
          tp.appendChild(tail);
          node.appendChild(tp);
          gEmpty.appendChild(node);
          return { node, head, tail };
        });
        headerBody = on => lines.forEach((ln, l) => {
          toLayer(ln.node, on ? gFilled : gEmpty);
          const str = (on ? model.headerText : s.placeholder || "").slice(l * s.perLine, (l + 1) * s.perLine);
          const m = on ? Math.max(0, Math.min(magic - l * s.perLine, str.length)) : 0;
          ln.head.textContent = str.slice(0, m);
          ln.tail.textContent = str.slice(m);
          ln.tail.setAttribute("fill", on ? t.ink : t.grid);
        });
      } else {
        const mkHeaderText = fill => {
          const node = el("text", { "font-size": s.size, "font-family": MONO, fill, lengthAdjust: "spacingAndGlyphs" });
          gEmpty.appendChild(node);
          return node;
        };
        const dots = s.baselines.map(() => mkHeaderText(t.grid));
        // the shown text centres over the row's baselines, so it gets its
        // own nodes; the dots cover every baseline like a pending row's
        const shown = headerLines(s, model.headerText).map(([y, str]) => ({
          y, str, head: mkHeaderText(t.magic), tail: mkHeaderText(t.ink)
        }));
        shown.forEach(ln => {
          ln.head.setAttribute("y", ln.y);
          ln.head.setAttribute("font-weight", t.magicWeight);
          ln.tail.setAttribute("y", ln.y);
        });
        headerBody = on => {
          dots.forEach((node, l) => {
            const str = on ? "" : (s.placeholder || "").slice(l * s.perLine, (l + 1) * s.perLine);
            node.setAttribute("y", s.baselines[l]);
            setText(node, str, s.x, str.length * s.cw);
          });
          let off = 0;
          for (const ln of shown) {
            toLayer(ln.head, on ? gFilled : gEmpty);
            toLayer(ln.tail, on ? gFilled : gEmpty);
            const m = Math.max(0, Math.min(magic - off, ln.str.length));
            off += ln.str.length;
            setText(ln.head, on ? ln.str.slice(0, m) : "", s.x, m * s.cw);
            setText(ln.tail, on ? ln.str.slice(m) : "", s.x + m * s.cw, (ln.str.length - m) * s.cw);
          }
        };
      }
    }

    const rowGroups = [];
    const rowNodes = model.cells.map(row => {
      const g = el("g", {});
      const nodes = row.map(p => {
        const node = el(p.tag, { ...p.attrs, fill: "none", stroke: t.grid, "stroke-width": 1 });
        g.appendChild(node);
        return node;
      });
      gEmpty.appendChild(g);
      rowGroups.push(g);
      return nodes;
    });

    // callout leaders etc. draw over the cells (rings are nested, so a
    // leader line must pass over outer bands to reach its own)
    if (model.overlays && model.overlays.length) {
      const g = el("g", { fill: "none", "stroke-width": 1 });
      for (const p of model.overlays) g.appendChild(el(p.tag, themed(p.attrs, t)));
      svg.appendChild(g);
    }

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

    let headerOn = null;

    return {
      svg,
      // show or hide the initial-value row (and its static labels): hidden it
      // sits grey like every pending row, during the first lead-in rest
      setHeader(on) {
        if (on === headerOn) return;
        headerOn = on;
        if (headerBody) headerBody(on);
        for (const { node, spec } of labelNodes) {
          if (!spec.parts) continue;
          [...node.children].forEach((ts, j) =>
            ts.setAttribute("fill", on && !spec.parts[j].dim ? t.ink : t.grid));
        }
      },
      // paint one row; magic = leading cells to keyline / characters to redden
      fillRow(i, colours, magic = 0, locked = true) {
        if (textRowNodes.length) {
          const tr = textRowNodes[i];
          if (!tr) return;
          tr.topNodes.forEach(n => toLayer(n, gFilled));
          if (tr.pathLines) {
            const { perLine } = tr.spec;
            tr.pathLines.forEach((ln, l) => {
              const str = colours.slice(l * perLine, (l + 1) * perLine);
              const m = Math.max(0, Math.min(magic - l * perLine, str.length));
              ln.head.textContent = str.slice(0, m);
              ln.tail.textContent = str.slice(m);
              ln.tail.setAttribute("fill", locked ? t.ink : t.grid);
            });
            return;
          }
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
        toLayer(rowGroups[i], gFilled);
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
            const node = el(p.tag, { ...p.attrs, fill: "none", stroke: t.magic, "stroke-width": HALO_STROKE });
            gMagic.appendChild(node);
            magicNodes[i].push(node);
          }
        }
      },
      clearRow(i) {
        if (textRowNodes.length) {
          const tr = textRowNodes[i];
          if (tr) restRow(tr);
          return;
        }
        if (rowGroups[i]) toLayer(rowGroups[i], gEmpty);
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
          node.setAttribute("font-weight", active ? t.magicWeight : "400");
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
    const textNode = (x, y, size, str, len, fill, weight) => str.length
      ? '  <text ' + attr({
          x: typeof x === "number" ? x.toFixed(2) : x, y, "font-size": size, "font-family": MONO, fill,
          lengthAdjust: "spacingAndGlyphs", textLength: len.toFixed(2),
          ...(weight ? { "font-weight": weight } : {})
        }) + ">" + esc(str) + "</text>\n"
      : "";
    // text paths live in defs
    const circPaths = (model.textRows || []).flatMap(s => s.paths || []);
    if (model.header && model.header.text && model.header.text.paths) circPaths.unshift(...model.header.text.paths);
    if (circPaths.length) {
      out += "  <defs>\n";
      for (const p of circPaths) out += "    <path " + attr({ id: p.id, d: p.pathD, fill: "none" }) + "/>\n";
      out += "  </defs>\n";
    }
    // the initial value hides (grey, like a pending row) until the first
    // lead-in rest has passed
    const headerShown = state.header !== false;
    const headerMagic = model.headerMagic || 0;
    // bottom to top: grey placeholders (empty rows and the header's empty
    // cells), then the match halos, then everything filled
    if (!model.textRows) {
      model.cells.forEach((row, i) => {
        if (!state.rows[i])
          row.forEach(p =>
            out += "  <" + p.tag + " " + attr({ ...p.attrs, fill: "none", stroke: t.grid, "stroke-width": 1 }) + "/>\n");
      });
      if (model.header && model.header.cells)
        model.header.cells.forEach((p, k) => {
          if (!headerShown || !(model.headerColours || [])[k])
            out += "  <" + p.tag + " " + attr({ ...p.attrs, fill: "none", stroke: t.grid, "stroke-width": 1 }) + "/>\n";
        });
      // the base word's cells in the header take the match keyline too
      if (headerShown && model.header && model.header.cells)
        for (let k = 0; k < headerMagic && k < model.header.cells.length; k++)
          out += "  <" + model.header.cells[k].tag + " " + attr({ ...model.header.cells[k].attrs, fill: "none", stroke: t.magic, "stroke-width": HALO_STROKE }) + "/>\n";
      model.cells.forEach((row, i) => {
        if (state.rows[i] && state.magic[i])
          for (let k = 0; k < state.magic[i] && k < row.length; k++)
            out += "  <" + row[k].tag + " " + attr({ ...row[k].attrs, fill: "none", stroke: t.magic, "stroke-width": HALO_STROKE }) + "/>\n";
      });
    }
    if (model.header) {
      if (model.header.cells) {
        if (headerShown)
          model.header.cells.forEach((p, k) => {
            const c = (model.headerColours || [])[k];
            if (c) out += "  <" + p.tag + " " + attr({ ...p.attrs, fill: c, stroke: "none", "stroke-width": 1 }) + "/>\n";
          });
      } else if (model.header.text && model.headerText != null) {
        const s = model.header.text;
        if (!headerShown) {
          // placeholder dots, exactly as a pending row shows them
          if (s.paths)
            s.paths.forEach((p, l) => {
              const str = (s.placeholder || "").slice(l * s.perLine, (l + 1) * s.perLine);
              if (str)
                out += "  <text " + attr({ "font-size": s.size, "font-family": MONO, fill: t.grid }) +
                  '><textPath href="#' + p.id + '">' + esc(str) + "</textPath></text>\n";
            });
          else
            s.baselines.forEach((y, l) => {
              const str = (s.placeholder || "").slice(l * s.perLine, (l + 1) * s.perLine);
              out += textNode(s.x, y, s.size, str, str.length * s.cw, t.grid);
            });
        } else if (s.paths)
          s.paths.forEach((p, l) => {
            const str = model.headerText.slice(l * s.perLine, (l + 1) * s.perLine);
            const m = Math.max(0, Math.min(headerMagic - l * s.perLine, str.length));
            if (str)
              out += "  <text " + attr({ "font-size": s.size, "font-family": MONO }) +
                '><textPath href="#' + p.id + '">' +
                "<tspan " + attr({ fill: t.magic, "font-weight": t.magicWeight }) + ">" + esc(str.slice(0, m)) + "</tspan>" +
                "<tspan " + attr({ fill: t.ink }) + ">" + esc(str.slice(m)) + "</tspan>" +
                "</textPath></text>\n";
          });
        else {
          let off = 0;
          for (const [y, str] of headerLines(s, model.headerText)) {
            const m = Math.max(0, Math.min(headerMagic - off, str.length));
            off += str.length;
            out += textNode(s.x, y, s.size, str.slice(0, m), m * s.cw, t.magic, t.magicWeight);
            out += textNode(s.x + m * s.cw, y, s.size, str.slice(m), (str.length - m) * s.cw, t.ink);
          }
        }
      }
    }
    if (model.textRows) {
      // pending placeholder dots first: they sit under the filled rows
      state.rows.forEach((value, i) => {
        const tr = model.textRows[i];
        if (value || !tr || !tr.placeholder) return;
        if (tr.paths)
          tr.paths.forEach((p, l) => {
            const str = tr.placeholder.slice(l * tr.perLine, (l + 1) * tr.perLine);
            out += "  <text " + attr({ "font-size": tr.size, "font-family": MONO, fill: t.grid }) +
              '><textPath href="#' + p.id + '">' + esc(str) + "</textPath></text>\n";
          });
        else
          tr.baselines.forEach((y, l) => {
            const str = tr.placeholder.slice(l * tr.perLine, (l + 1) * tr.perLine);
            out += textNode(tr.x, y, tr.size, str, str.length * tr.cw, t.grid);
          });
      });
      state.rows.forEach((value, i) => {
        const tr = model.textRows[i];
        if (!value) return;
        const locked = state.activeRow !== i || state.resting;
        if (tr.paths) {
          tr.paths.forEach((p, l) => {
            const str = value.slice(l * tr.perLine, (l + 1) * tr.perLine);
            const m = Math.max(0, Math.min((state.magic[i] || 0) - l * tr.perLine, str.length));
            out += "  <text " + attr({ "font-size": tr.size, "font-family": MONO }) +
              '><textPath href="#' + p.id + '">' +
              "<tspan " + attr({ fill: t.magic, "font-weight": t.magicWeight }) + ">" + esc(str.slice(0, m)) + "</tspan>" +
              "<tspan " + attr({ fill: locked ? t.ink : t.grid }) + ">" + esc(str.slice(m)) + "</tspan>" +
              "</textPath></text>\n";
          });
          return;
        }
        tr.baselines.forEach((y, l) => {
          const str = value.slice(l * tr.perLine, (l + 1) * tr.perLine);
          const m = Math.max(0, Math.min((state.magic[i] || 0) - l * tr.perLine, str.length));
          out += textNode(tr.x, y, tr.size, str.slice(0, m), m * tr.cw, t.magic, t.magicWeight);
          out += textNode(tr.x + m * tr.cw, y, tr.size, str.slice(m), (str.length - m) * tr.cw, locked ? t.ink : t.grid);
        });
      });
    } else
      model.cells.forEach((row, i) => {
        const colours = state.rows[i];
        if (!colours) return; // placeholders already emitted in the underlay
        row.forEach((p, k) => {
          const fill = colours[k] || "none";
          out += "  <" + p.tag + " " + attr({ ...p.attrs, fill, stroke: fill === "none" ? t.grid : "none", "stroke-width": 1 }) + "/>\n";
        });
      });
    for (const p of (model.overlays || []))
      out += "  <" + p.tag + " " + attr({ fill: "none", "stroke-width": 1, ...themed(p.attrs, t) }) + "/>\n";
    for (const l of model.labels) {
      const open = (fill, weight) => '  <text ' + attr({
        x: l.x, y: l.y, "text-anchor": l.anchor || "start", "font-size": l.size || 12,
        "font-family": l.mono ? "ui-monospace, Menlo, Consolas, monospace" : "Helvetica Neue, Helvetica, sans-serif",
        ...(fill ? { fill } : {}),
        ...(weight ? { "font-weight": weight } : {})
      }) + ">";
      if (l.parts) {
        // the header's static labels grey out with it during the lead-in
        out += open(null) +
          l.parts.map(p => '<tspan fill="' + (p.dim || !headerShown ? t.grid : t.ink) + '">' + esc(p.t) + "</tspan>").join("") +
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
      out += open(painted || active ? (active ? t.magic : t.ink) : t.grid, active ? t.magicWeight : null) + text + "</text>\n";
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
