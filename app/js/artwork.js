// Artwork package — the deterministic entry point.
// build() fixes the inputs; every visual state is then a pure function of an
// integer frame, so the animation, a still, and any future edition come from
// the same code.
(function () {
  const grinding = window.grinding = window.grinding || {};

  const defaults = {
    layout: "gutter", encoding: "rgb12", easing: "inOutCubic",
    display: "squares", // squares | circles | hex | ascii
    sizing: "fit", // fit | fill | overlap — element size on the fanning layouts
    channelFloor: undefined, // raise for dark grounds so zero bytes stay visible
    timeScale: 1, holdSeconds: 60, drawSeconds: null, // null = data-driven; 0 = still
    rowPauseSeconds: 2, // rest between rows (not after the last); 0 = none
    cellGap: 0.06, decorations: true, labels: null, salt: 0
  };

  // a hash as text: its hex digits, or its bytes as ascii (unprintables as ·)
  function hashText(hex, display) {
    if (display !== "ascii") return hex;
    let out = "";
    for (let k = 0; k + 1 < hex.length; k += 2) {
      const c = parseInt(hex.slice(k, k + 2), 16);
      out += (c >= 32 && c <= 126) ? String.fromCharCode(c) : "·";
    }
    return out;
  }

  // colour cells the matched prefix occupies: the search encoding gives
  // nibbles matched in the hash, the colour encoding gives nibbles per cell
  const magicCells = (record, enc) => Math.ceil(record.matchedNibbles / enc.nibblesPerCell);

  function totals(searches) {
    return {
      searches: searches.length,
      matches: searches.reduce((a, r) => a + (r.steps ? r.steps.length : 1), 0),
      attempts: searches.reduce((a, r) => a + r.attempts, 0)
    };
  }

  // one animation step per progression match, in grind order across all rows
  function flattenSteps(searches) {
    const steps = [];
    searches.forEach((r, row) => {
      let achievedChars = 0, prevHash = null;
      for (const st of (r.steps || [r])) {
        steps.push({ ...st, row, achievedChars, prevHash });
        achievedChars = st.matchedChars;
        prevHash = st.hash;
      }
    });
    return steps;
  }

  // the live row: churn, except the matched-so-far prefix, which shows its
  // real value (from the last match's hash) under the match marking
  function liveCells(art, ph) {
    const st = art.steps[ph.stepIndex];
    const r = st && art.searches[st.row];
    // nibbles per character comes from the full encoded word, not the (possibly
    // partial) matched nibble count
    const achievedNibbles = (st && st.prevHash && st.achievedChars)
      ? st.achievedChars * (r.encodedHex.length / r.totalChars) : 0;
    if (art.textual) {
      let hex = grinding.colour.churnHex(ph.seed + art.options.salt, 64);
      if (achievedNibbles) hex = st.prevHash.slice(0, achievedNibbles) + hex.slice(achievedNibbles);
      return {
        colours: hashText(hex, art.display),
        magic: art.display === "ascii" ? achievedNibbles / 2 : achievedNibbles
      };
    }
    const colours = grinding.colour.churnCells(ph.seed + art.options.salt, art.cols, art.encoding, art.options.channelFloor);
    if (!achievedNibbles) return { colours, magic: 0 };
    const magic = Math.ceil(achievedNibbles / art.enc.nibblesPerCell);
    const real = grinding.colour.cellsFromHash(st.prevHash, art.encoding, art.options.channelFloor);
    for (let k = 0; k < magic && k < colours.length; k++) colours[k] = real[k];
    return { colours, magic };
  }

  function build(options = {}) {
    const { colour, layout, animation } = grinding;
    const o = { ...defaults, ...options };
    const searches = o.searches || grinding.series.records;
    const enc = colour.encodings[o.encoding];
    const cols = enc.cells;
    const display = o.display || "squares";
    const textual = display === "hex" || display === "ascii";
    const glyphs = display === "ascii" ? 32 : 64;
    // the initial value: base ‖ zeroed 64-bit nonce, a row in the same
    // format. The hub topologies draw no such row — there the base is the
    // concept the words are ground from, not part of the composition — and
    // a series can decline its seed row explicitly (seedRow: false)
    const base = grinding.series && grinding.series.base;
    const topology = grinding.series && grinding.series.topology;
    const hubConcept = topology === "star_from" || topology === "spiral";
    const seedRow = !grinding.series || grinding.series.seedRow !== false;
    const header = o.header !== undefined ? o.header
      : (base && !hubConcept && seedRow ? { plaintext: base, nonce: "0" } : null);
    const model = layout.build(o.layout, searches.length, cols, {
      gap: o.cellGap, decorations: o.decorations, header, display, glyphs,
      sizing: o.sizing,
      labels: o.labels === null ? true : o.labels
    });
    if (model.header && base) {
      const preimageHex = [...base].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("") + "0".repeat(16);
      // the base word is the header's match: its cells/characters take the
      // same highlight marking a matched prefix gets on the search rows
      if (model.header.text) {
        model.headerText = hashText(preimageHex, display);
        model.headerMagic = display === "ascii" ? base.length : base.length * 2;
      } else {
        model.headerColours = colour.cellsFromHash(preimageHex, o.encoding, o.channelFloor);
        model.headerMagic = Math.ceil(base.length * 2 / enc.nibblesPerCell);
      }
    }
    const steps = flattenSteps(searches);
    const sched = animation.schedule(steps, {
      timeScale: o.timeScale, holdMs: o.holdSeconds * 1000,
      drawMs: o.drawSeconds > 0 ? o.drawSeconds * 1000 : null,
      rowPauseMs: (o.rowPauseSeconds || 0) * 1000,
      header: !!header
    });
    return {
      options: o, searches, steps, encoding: o.encoding, enc, cols, model, sched,
      display, textual, glyphs,
      fps: o.fps || animation.FPS,
      frames: animation.frameCount(sched, o.fps),
      finalFrame: animation.finalFrame(sched, o.fps),
      real: searches.map(s => textual ? hashText(s.hash, display) : colour.cellsFromHash(s.hash, o.encoding, o.channelFloor)),
      magic: searches.map(s => textual
        ? (display === "ascii" ? s.matchedNibbles / 2 : s.matchedNibbles)
        : magicCells(s, enc)),
      totals: totals(searches)
    };
  }

  const phaseAtFrame = (art, frame) =>
    grinding.animation.phaseAtFrame(frame, art.steps, art.sched, { fps: art.fps, easing: art.options.easing });

  // full visual state for one frame: what every row is showing
  function stateAtFrame(art, frame) {
    const ph = phaseAtFrame(art, frame);
    const live = (!ph.done && !ph.resting && ph.current >= 0) ? liveCells(art, ph) : null;
    const rows = art.searches.map((s, i) => {
      if (ph.done || i < ph.locked) return art.real[i];
      if (live && i === ph.current) return live.colours;
      return null;
    });
    return {
      phase: ph, rows, records: art.searches,
      matched: art.searches.map((s, i) =>
        (ph.done || i < ph.locked) ? (s.matchedChars ?? s.totalChars) : (i === ph.current ? ph.achieved : 0)),
      magic: art.searches.map((s, i) =>
        (ph.done || i < ph.locked) ? art.magic[i] : (live && i === ph.current ? live.magic : 0)),
      activeRow: ph.done ? -1 : ph.current,
      resting: !!ph.resting,
      header: ph.header !== false,
      liveNonce: ph.nonce
    };
  }

  function metadata(art, frame) {
    const s = grinding.series;
    const ph = phaseAtFrame(art, frame);
    return [
      "grinding | " + s.name.toLowerCase() + " | base " + s.base + " | " + s.searchEncoding + " | " + s.hashFunction,
      art.options.layout + " | " + art.enc.label + " | frame " + ph.frame + " of " + ph.frames + " @ " + art.fps + "fps",
      "easing " + art.options.easing + " | timeScale " + art.options.timeScale + " | salt " + art.options.salt,
      ...art.searches.map(r => r.word + " | " + (r.steps ? r.steps.length : 1) + " matches | counter " + r.nonce + " | " + r.hash)
    ];
  }

  // the whole deliverable: one integer in, one SVG file out
  function svgAtFrame(art, frame, theme = {}) {
    return grinding.render.toSVG(art.model, stateAtFrame(art, frame), theme, metadata(art, frame));
  }

  grinding.artwork = { defaults, magicCells, totals, flattenSteps, liveCells, build, phaseAtFrame, stateAtFrame, metadata, svgAtFrame };
})();
