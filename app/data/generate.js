// Node script (not loaded by the pages): regenerate every series data file
// and work page from results.csv. One WORKS entry per token: which task's
// rows to use (task + topology + case pick the variant), the edge order its
// topology draws, and the page's prose. For each edge every successively
// longer prefix match is kept (first nonce per match length — reruns are
// deterministic, so this is minimum nonce), and every hash is re-verified as
// SHA-256(base ‖ nonce as u64 LE) spelling the target before writing. The
// spiral works also count every full hit and the deepest nonce scanned.
//
//   node app/data/generate.js            # all works
//   node app/data/generate.js value icjbag ...   # just those slugs
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const ROOT = path.join(__dirname, "..", "..");
const APP = path.join(__dirname, "..");

// ---- the twelve works ------------------------------------------------------

const nameSpan = w => `<span class="name">${w}</span>`;
const chainBase = seed =>
  `Each candidate hashes the word before it with a 64-bit little-endian counter appended: ` +
  `sha256(&thinsp;word&thinsp;&#8214;&thinsp;counter&thinsp;). ${nameSpan(seed)} seeds the chain.`;
const ringBase = seed =>
  `Each candidate hashes the word before it with a 64-bit little-endian counter appended: ` +
  `sha256(&thinsp;word&thinsp;&#8214;&thinsp;counter&thinsp;). ${nameSpan(seed)} opens the ring and is ground for again at its close.`;
const hubBase = hub =>
  `Every candidate hashes ${nameSpan(hub)} with a 64-bit little-endian counter appended: ` +
  `sha256(&thinsp;${hub}&thinsp;&#8214;&thinsp;counter&thinsp;).`;

const WORKS = [
  {
    name: "Number", slug: "number", task: "number", topology: "chain", budgetBits: 48,
    words: ["zero", "one", "two", "three", "four", "five", "six", "seven",
            "eight", "nine", "ten", "eleven", "twelve"],
    baseNote: chainBase("zero"),
    targetsNote: "one through twelve — each word ground from the one before it, " +
      "each successively longer prefix match kept on the way to the full word.",
  },
  {
    name: "Shape", slug: "shape", task: "shape", topology: "ring",
    caseMode: "insensitive", budgetBits: 48,
    words: ["dot", "arc", "line", "curve", "plane", "circle", "square", "star", "spiral"],
    baseNote: ringBase("dot"),
    targetsNote: "dot to arc to line to curve to plane to circle to square to star " +
      "to spiral, and spiral ground back to dot — a ring, each shape found from the last.",
  },
  {
    name: "Colour", slug: "colour", task: "hue", topology: "ring", budgetBits: 48,
    words: ["red", "blue", "pink", "grey", "black", "white", "green", "brown",
            "yellow", "purple", "orange"],
    baseNote: ringBase("red"),
    targetsNote: "red to blue to pink to grey to black to white to green to brown " +
      "to yellow to purple to orange, and orange ground back to red — brown's search " +
      "for yellow rested at yello when the budget ran out.",
  },
  {
    name: "Pattern", slug: "pattern", task: "pattern", topology: "star_from",
    hub: "pattern", budgetBits: 48,
    words: ["plain", "grid", "checks", "dots", "stripes", "hexes", "repeat",
            "glitch", "floral"],
    baseNote: hubBase("pattern"),
    targetsNote: "plain, grid, checks, dots, stripes, hexes, repeat, glitch, floral " +
      "— each ground from pattern; stripes rested at strip and floral at flora " +
      "when the budget ran out.",
  },
  {
    name: "Direction", slug: "direction", task: "direction", topology: "star_from",
    hub: "center", budgetBits: 48,
    words: ["up", "in", "out", "down", "left", "over", "under", "right"],
    baseNote: hubBase("center"),
    targetsNote: "up, in, out, down, left, over, under, right — every direction " +
      "ground from center, each successively longer prefix match kept.",
  },
  {
    name: "Time", slug: "time", task: "time", topology: "ring", budgetBits: 48,
    words: ["night", "dawn", "morn", "noon", "dusk", "eve"],
    baseNote: ringBase("night"),
    targetsNote: "night to dawn to morn to noon to dusk to eve, and eve ground " +
      "back to night — the day as a ring, each hour found from the last.",
  },
  {
    name: "Genre", slug: "genre", task: "genre", topology: "chain", budgetBits: 48,
    words: ["myth", "face", "scene", "land", "beast", "thing"],
    baseNote: chainBase("myth"),
    targetsNote: "myth to face to scene to land to beast to thing — the genres of " +
      "painting in rank order, each ground from the one above it.",
  },
  {
    name: "Value", slug: "value", task: "value", topology: "star_to",
    hub: "art", budgetBits: 48,
    words: ["use", "utility", "aura", "price", "worth"],
    baseNote: "Each search hashes its own base — use, utility, aura, price, worth — " +
      "with a 64-bit little-endian counter appended: sha256(&thinsp;base&thinsp;&#8214;&thinsp;counter&thinsp;). " +
      `Every search seeks ${nameSpan("art")}.`,
    targetsNote: "art, five times over — one search per theory of value, each " +
      "successively longer prefix match kept on the way to the full word.",
  },
  {
    name: "Passions", slug: "passions", task: "passions", topology: "star_from",
    hub: "passions", caseMode: "insensitive", budgetBits: 48,
    words: ["joy", "love", "wonder", "hatred", "desire", "sorrow"],
    baseNote: hubBase("passions"),
    targetsNote: "joy, love, wonder, hatred, desire, sorrow — each passion ground " +
      "from passions, each successively longer prefix match kept.",
  },
  {
    name: "Gender", slug: "gender", task: "gender", topology: "star_from",
    hub: "gender", budgetBits: 48,
    words: ["she", "her", "they", "girl", "woman", "femme", "butch", "demi",
            "trans", "queer"],
    baseNote: hubBase("gender"),
    targetsNote: "she, her, they, girl, woman, femme, butch, demi, trans, queer — " +
      "each ground from gender, each successively longer prefix match kept.",
  },
  {
    name: "But I can't just be a girl!", slug: "icjbag",
    task: "But I can't just be a girl!", topology: "chain", budgetBits: 48,
    // the first edge was ground under this task's earlier spiral variant
    // (every-hit); the chain rerun skipped it as already matched, so its
    // rows are accepted from either topology
    rowTopologies: ["chain", "spiral"],
    words: ["But I can't be a girl!", "yes", "you", "can"],
    // the exclamation stays in the prose alone; the drawing opens on yes
    seedRow: false,
    baseNote: chainBase("But I can't be a girl!"),
    targetsNote: "yes, you, can — the answer ground word by word from the " +
      "exclamation, each successively longer prefix match kept.",
  },
  {
    name: "Attribution", slug: "attribution", task: "attribution",
    topology: "spiral", hub: "artist", budgetBits: 48,
    words: ["rhea", "myers"],
    baseNote: hubBase("artist"),
    targetsNote: "rhea and myers, ground from artist — every hit collected, " +
      "not the first alone. The grind continues.",
  },
];

// ---- edges (mirrors src/topology.rs) --------------------------------------

function edges(work) {
  const w = work.words;
  switch (work.topology) {
    case "chain": return w.slice(1).map((x, i) => [w[i], x]);
    case "ring": return w.map((x, i) => [x, w[(i + 1) % w.length]]);
    case "star_to": return w.map(x => [x, work.hub]);
    case "star_from":
    case "spiral": return w.map(x => [work.hub, x]);
    default: throw new Error("unhandled topology " + work.topology);
  }
}

// rows whose base differs per row carry it into the label; spiral rows share
// their hub base, already shown by the header row
const labelled = w => w.topology === "star_to";

// ---- collect from results.csv ---------------------------------------------

const only = process.argv.slice(2);
const works = only.length ? WORKS.filter(w => only.includes(w.slug)) : WORKS;
if (only.length && works.length !== only.length) {
  throw new Error("unknown slug among: " + only.join(" "));
}

// Each work reads one or two (task, topology, case) row groups from the csv:
// its main grind, and optionally the return grind toward its own base — the
// base being ground for in turn (e.g. she -> gender, rhea -> artist). The
// return group is optional: absent rows mean that grind has not run yet, and
// the work is emitted without it.
// Per edge: matchedChars -> first {nonce, hash}; plus hit counting.
const byTask = new Map();
for (const w of works) {
  w.caseMode = w.caseMode || "sensitive";
  const mkEdge = (from, to, caseMode) =>
    ({ from, to, caseMode, steps: new Map(), hits: 0, lastNonce: 0 });
  w.mainEdges = edges(w).map(([from, to]) => mkEdge(from, to, w.caseMode));
  w.returnEdges = w.baseGrind
    ? (w.baseGrind.from || w.words).map(f =>
        mkEdge(f, headerBase(w), w.baseGrind.caseMode || w.caseMode))
    : [];
  const groups = [
    { task: w.task, topologies: w.rowTopologies || [w.topology], caseMode: w.caseMode, edges: w.mainEdges },
  ];
  if (w.baseGrind) {
    groups.push({
      task: w.baseGrind.task,
      topologies: [w.baseGrind.topology],
      caseMode: w.baseGrind.caseMode || w.caseMode,
      edges: w.returnEdges,
    });
  }
  for (const g of groups) {
    g.edgeIndex = new Map(g.edges.map(e => [e.from + "\u0000" + e.to, e]));
    if (!byTask.has(g.task)) byTask.set(g.task, []);
    byTask.get(g.task).push(g);
  }
}

async function collect() {
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(ROOT, "results.csv")),
    crlfDelay: Infinity,
  });
  let head = null, col = {};
  for await (const line of rl) {
    if (!head) {
      head = line.split(",");
      head.forEach((n, i) => { col[n] = i; });
      continue;
    }
    // the task label sits before the first comma; skip foreign rows cheaply
    const f = line.split(",");
    const candidates = byTask.get(f[col.task]);
    if (!candidates) continue;
    for (const g of candidates) {
      if (!g.topologies.includes(f[col.topology]) || f[col.case] !== g.caseMode) continue;
      if (f[col.encoding] !== "ascii8" || f[col.position_mode] !== "prefix") continue;
      const edge = g.edgeIndex.get(f[col.base] + "\u0000" + f[col.target]);
      if (!edge) continue;
      const chars = Number(f[col.matched_chars]);
      const nonce = Number(f[col.nonce]);
      const prior = edge.steps.get(chars);
      if (!prior || nonce < prior.nonce) edge.steps.set(chars, { nonce, hash: f[col.digest] });
      if (chars === edge.to.length) {
        edge.hits += 1;
        if (nonce > edge.lastNonce) edge.lastNonce = nonce;
      }
    }
  }
}

// Return searches that have not been ground yet drop out (with a note); the
// work's rows are its own searches first, then the returns.
function prune(work) {
  const missing = work.returnEdges.filter(e => !e.steps.size);
  if (missing.length) {
    console.log(`${work.name}: return grind not yet run for ` +
      missing.map(e => `${e.from}->${e.to}`).join(", "));
  }
  work.returnEdges = work.returnEdges.filter(e => e.steps.size);
  work.edges = [...work.mainEdges, ...work.returnEdges];
}

// ---- verify ----------------------------------------------------------------

function verify(work) {
  for (const e of work.edges) {
    if (!e.steps.size) throw new Error(`${work.slug}: no rows for ${e.from}->${e.to}`);
    for (const [chars, st] of e.steps) {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(BigInt(st.nonce));
      const h = crypto.createHash("sha256")
        .update(Buffer.concat([Buffer.from(e.from), le])).digest("hex");
      if (h !== st.hash) {
        throw new Error(`${work.slug}: hash mismatch ${e.from}->${e.to} @ ${st.nonce}`);
      }
      for (let i = 0; i < chars; i++) {
        const b = String.fromCharCode(parseInt(st.hash.slice(i * 2, i * 2 + 2), 16));
        const want = e.to[i];
        const ok = e.caseMode === "insensitive"
          ? b.toLowerCase() === want.toLowerCase() : b === want;
        if (!ok) {
          throw new Error(`${work.slug}: ${e.from}->${e.to} @ ${st.nonce} does not spell ` +
            `${e.to.slice(0, chars)} (hash ${st.hash.slice(0, chars * 2)})`);
        }
      }
    }
  }
}

// ---- emit the data file ----------------------------------------------------

function headerBase(work) {
  switch (work.topology) {
    case "chain":
    case "ring": return work.words[0];
    case "star_from":
    case "spiral": return work.hub;
    case "star_to": return ""; // no single preimage; the page draws no header row
  }
}

function dataFile(work) {
  const spiral = work.topology === "spiral";
  const hb = headerBase(work);
  const rows = [];
  for (const e of work.edges) {
    const ordered = [...e.steps.entries()].sort((a, b) => a[0] - b[0]);
    for (const [chars, st] of ordered) {
      rows.push(`    ["${e.from}", "${e.to}", ${chars}, ${st.nonce}, "${st.hash}"],`);
    }
  }
  const hitsLines = spiral
    ? work.mainEdges.map(e => `    "${e.to}": [${e.hits}, ${e.lastNonce}],`).join("\n")
    : null;
  const displayWords = work.topology === "star_to"
    ? work.words : work.mainEdges.map(e => e.to);

  return `// Series data — ${work.name}.
// Generated by generate.js from results.csv: task "${work.task}"
// (${work.topology}, ascii8, ${work.caseMode}), budget 2^${work.budgetBits} per search. One record
// per edge; its steps are every successively longer prefix match (first
// counter value per match length) of the one continuing grind. Every
// candidate message is base ‖ counter (64-bit little-endian; the counter is
// the "nonce" column in results.csv); every hash below was re-verified as
// SHA-256(base ‖ counter) at generation time.
(function () {
  const grinding = window.grinding = window.grinding || {};

  // base, word, matched chars, counter (the csv\u2019s nonce), hash
  const rows = [
${rows.join("\n")}
  ];
${spiral ? `
  // every-hit collection: word -> [full hits kept, deepest winning counter]
  const hits = {
${hitsLines}
  };
` : ""}
  const ascii8hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const edges = [];
  for (const [base, word] of rows)
    if (!edges.some(e => e[0] === base && e[1] === word)) edges.push([base, word]);

  grinding.series = {
    name: "${work.name.replace(/"/g, '\\"')}",
    slug: "${work.slug}",
    base: "${headerBase(work)}",${work.seedRow === false ? `
    seedRow: false, // the base stays in the prose; no initial-value row` : ""}
    topology: "${work.topology}",
    searchEncoding: "ascii8",
    caseMode: "${work.caseMode}",
    hashFunction: "SHA-256",
    budgetBits: ${work.budgetBits},
    tokenId: ${WORKS.indexOf(work) + 1}, // position in the fixed edition; scripts/tokens.js agrees
    records: edges.map(([base, word], index) => {
      let prevNonce = 0;
      const steps = rows.filter(r => r[0] === base && r[1] === word)
        .map(([, , matchedChars, nonce, hash]) => {
          const st = { matchedChars, nonce, prevNonce, deltaAttempts: nonce - prevNonce, hash };
          prevNonce = nonce;
          return st;
        });
      const final = steps[steps.length - 1];
      return {
        index,
        word,
        base,${labelled(work) ? `
        labelPrefix: base + " \\u2192\\u00a0", // nbsp: a plain trailing space collapses in SVG` : work.returnEdges.length ? `
        // the return searches grind for the base itself from their own words
        labelPrefix: word === "${hb}" ? base + " \\u2192\\u00a0" : undefined,` : ""}
        plaintext: word, // as it appears in the csv
        totalChars: word.length,
        matchedChars: final.matchedChars, // < totalChars if the budget ran out
        full: final.matchedChars === word.length,
        encodedHex: ascii8hex(word),
        matchedNibbles: final.matchedChars * 2,
        nonce: final.nonce,
        attempts: final.nonce + 1,
        hash: final.hash,
        steps${spiral ? `,
        hits: (hits[word] || [])[0], // undefined on the return searches
        lastNonce: (hits[word] || [])[1]` : ""}
      };
    }),
    words: ${JSON.stringify(displayWords)}
  };
})();
`;
}

// ---- emit the page ---------------------------------------------------------

function human(n) {
  const unit = (v, u) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + " " + u;
  if (n >= 1e12) return unit(n / 1e12, "trillion");
  if (n >= 1e9) return unit(n / 1e9, "billion");
  if (n >= 1e6) return unit(n / 1e6, "million");
  return n.toLocaleString("en-US");
}

function noncesNote(work) {
  if (work.topology === "spiral") {
    const hits = work.mainEdges.reduce((a, e) => a + e.hits, 0);
    const deepest = Math.max(...work.mainEdges.map(e => e.lastNonce));
    return `${hits.toLocaleString("en-US")} winning counter values kept, the deepest at ` +
      `${human(deepest)}, within a 2<sup>${work.budgetBits}</sup> budget per search.`;
  }
  const finals = work.edges.map(e => Math.max(...[...e.steps.values()].map(s => s.nonce)));
  return `Winning counter values from ${human(Math.min(...finals))} to ${human(Math.max(...finals))}, ` +
    `within a 2<sup>${work.budgetBits}</sup> budget per search.`;
}

function encodingNote(work) {
  return "One byte per character. A match means the SHA-256 hash prefix spells the word in ASCII hex." +
    (work.caseMode === "insensitive" ? " Matching is case-insensitive." : "");
}

// Marketplace embeds (SuperRare et al.) cache the animation HTML without its
// sibling files, so every page is fully self-contained: the stylesheet and
// all scripts are inlined at generation time. Interpolated file contents are
// runtime strings, so backticks inside them are safe.
const inlineCss = () => fs.readFileSync(path.join(APP, "css", "styles.css"), "utf8");
const inlineJs = rel => fs.readFileSync(path.join(APP, rel), "utf8");

function page(work) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${work.name} — Grinding</title>
<style>
${inlineCss()}</style>
</head>
<body>

<main class="plate-page">

  <section class="titleblock">
    <div class="micro kicker"><em class="worktitle">Grinding</em><br>2026<br>Rhea Myers</div>
    <h1 id="series-name">${work.name}</h1>
    <div class="titleblock-actions micro">
      <button type="button" id="config-open" class="link">Config</button>
    </div>
  </section>

  <section class="stage">
    <div id="host" class="host"></div>
  </section>

  <footer class="colophon">
    <div class="packages">
      <div class="package"><span class="name">base</span><br>
        <span class="note">${work.baseNote}${work.returnEdges.length
          ? " The searches grinding for " + headerBase(work) +
            " in turn each hash their own base word the same way."
          : ""}</span></div>
      <div class="package"><span class="name">ascii8</span><br>
        <span class="note">${encodingNote(work)}</span></div>
      <div class="package"><span class="name">targets</span><br>
        <span class="note">${work.targetsNote}${work.returnEdges.length
          ? " " + work.baseGrindNote : ""}</span></div>
      <div class="package"><span class="name">counters</span><br>
        <span class="note">${noncesNote(work)}</span></div>
    </div>
  </footer>

</main>

<dialog id="config">
  <div class="config-box">
    <div class="config-title">
      <span class="micro">Config</span>
      <button type="button" id="config-close" class="micro link">Close</button>
    </div>
    <div class="config-section">
      <div class="micro dim">Duration</div>
      <div class="config-row">
        <input id="duration" type="number" min="0" step="1" value="120">
        <span class="note">seconds the drawing should take &mdash; 0 renders the final state instantly</span>
      </div>
      <div class="config-row">
        <input id="pause" type="number" min="0" step="1" value="60">
        <span class="note">seconds to pause on the final state after each cycle &mdash; 0 runs once and stops</span>
      </div>
      <div class="config-row">
        <input id="row-pause" type="number" min="0" step="1" value="2">
        <span class="note">seconds of rest after each row locks &mdash; not after the last; 0 is none</span>
      </div>
    </div>
    <div class="config-section">
      <div class="micro dim">Layout</div>
      <div class="opt-buttons" id="layout-buttons"></div>
    </div>
    <div class="config-section">
      <div class="micro dim">Hash display</div>
      <div class="opt-buttons" id="display-buttons"></div>
    </div>
    <div class="config-section">
      <div class="micro dim">Element size</div>
      <div class="opt-buttons" id="sizing-buttons"></div>
      <div class="note">radial, rosette, and spiral only</div>
    </div>
    <div class="config-section">
      <div class="micro dim">Scheme</div>
      <div class="opt-buttons" id="scheme-buttons"></div>
    </div>
    <div class="config-section">
      <div class="micro dim">Encoding</div>
      <div class="opt-buttons" id="encoding-buttons"></div>
      <div class="note">Cells <span class="mono" id="cell-count">&mdash;</span></div>
    </div>
    <div class="config-section">
      <div class="micro dim">Export</div>
      <div class="config-row">
        <button type="button" id="save-frame" class="micro link">Save SVG &mdash; this frame</button>
        <button type="button" id="save-final" class="micro link">Save SVG &mdash; final state</button>
      </div>
    </div>
    <div class="config-section" id="chain-section" hidden>
      <div class="micro dim">Chain</div>
      <div class="config-row">
        <button type="button" id="chain-save" class="micro link">Save config to chain</button>
        <span class="note" id="chain-status">the token owner can store this display configuration on chain</span>
      </div>
      <div class="note" id="chain-tx" hidden></div>
    </div>
  </div>
</dialog>

<script>
${["js/colour.js", "js/layout.js", "js/animation.js", "js/render.js",
   "js/artwork.js", `data/${work.slug}.js`, "js/chain-config.js",
   "js/chain.js", "js/app.js"].map(inlineJs).join("\n")}
</script>

</body>
</html>
`;
}

// ---- main ------------------------------------------------------------------

// The index page is hand-edited, but its styles are inlined (it ships to
// the site as a single file); refresh that block from styles.css each run.
function refreshIndex() {
  const p = path.join(APP, "index.html");
  const s = fs.readFileSync(p, "utf8");
  const out = s.replace(
    /<style data-src="css\/styles.css">[\s\S]*?<\/style>/,
    () => `<style data-src="css/styles.css">\n${inlineCss()}</style>`
  );
  if (out !== s) fs.writeFileSync(p, out);
}

(async () => {
  await collect();
  refreshIndex();
  for (const w of works) {
    prune(w);
    verify(w);
    fs.writeFileSync(path.join(APP, "data", w.slug + ".js"), dataFile(w));
    fs.writeFileSync(path.join(APP, w.slug + ".html"), page(w));
    const steps = w.edges.reduce((a, e) => a + e.steps.size, 0);
    const hits = w.topology === "spiral"
      ? ", " + w.edges.reduce((a, e) => a + e.hits, 0).toLocaleString("en-US") + " hits kept"
      : "";
    const returns = w.returnEdges.length
      ? ` (incl. ${w.returnEdges.length} return search${w.returnEdges.length === 1 ? "" : "es"} for "${headerBase(w)}")`
      : "";
    console.log(`${w.name}: ${steps} steps across ${w.edges.length} searches` +
      `${returns}${hits} — all hashes verified`);
  }
})();
