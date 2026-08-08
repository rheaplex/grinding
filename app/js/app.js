// Page wiring — vanilla DOM around the artwork packages. One piece is built
// per (layout, encoding); painting is the sketch's single path: an integer
// frame in, pixels out.
(function () {
  const R = window.grinding;
  const series = R.series;

  // schemes live in the stylesheet as body-class variable sets; the drawing
  // reads the computed values so chrome and artwork always agree
  const schemeOrder = [
    ["paper", "black on white"], ["night", "white on black"],
    ["video", "green on black"], ["inverse", "black on green"]
  ];
  function currentTheme() {
    const cs = getComputedStyle(document.body);
    const v = name => cs.getPropertyValue(name).trim();
    return { ground: v("--ground"), ink: v("--ink"), grid: v("--grid"), ruleSoft: v("--rule-soft"), magic: v("--magic") };
  }

  const encodingOrder = ["rgb12", "grey4", "duo8"];

  const $ = id => document.getElementById(id);
  const host = $("host");
  const fmt = n => n.toLocaleString("en-US");

  const state = { layout: "gutter", encoding: "rgb12", display: "squares", scheme: "paper", drawSeconds: 30, pauseSeconds: 7, rowPauseSeconds: 2, running: false };

  // black grounds raise the colour floor so zero bytes don't vanish
  const darkSchemes = ["night", "video"];
  const channelFloor = () => darkSchemes.includes(state.scheme) ? 48 : undefined;
  let piece = null, view = null, painted = 0, frame = 0;
  let timer = null, startFrame = 0, t0 = 0;

  // ---- config dialog ------------------------------------------------------

  function optButton(bar, key, label, pick) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = key;
    b.textContent = label;
    b.addEventListener("click", pick);
    bar.appendChild(b);
  }

  const layoutBar = $("layout-buttons");
  for (const name of R.layout.layoutNames)
    optButton(layoutBar, name, name, () => { state.layout = name; rebuild(); });

  const encodingBar = $("encoding-buttons");
  for (const key of encodingOrder)
    optButton(encodingBar, key, R.colour.encodings[key].label, () => { state.encoding = key; rebuild(); });

  const displayBar = $("display-buttons");
  for (const [key, label] of [["squares", "squares"], ["circles", "circles"], ["hex", "hex"], ["ascii", "ascii text"]])
    optButton(displayBar, key, label, () => { state.display = key; rebuild(); });

  const schemeBar = $("scheme-buttons");
  for (const [key, label] of schemeOrder)
    optButton(schemeBar, key, label, () => {
      state.scheme = key;
      document.body.className = "scheme-" + key;
      rebuild();
    });

  function syncControls() {
    [...layoutBar.children].forEach(b => b.classList.toggle("active", b.dataset.key === state.layout));
    [...encodingBar.children].forEach(b => b.classList.toggle("active", b.dataset.key === state.encoding));
    [...displayBar.children].forEach(b => b.classList.toggle("active", b.dataset.key === state.display));
    [...schemeBar.children].forEach(b => b.classList.toggle("active", b.dataset.key === state.scheme));
    $("cell-count").textContent = piece ? (piece.textual ? piece.glyphs : piece.cols) : "—";
  }

  // visible at startup and on mouse move / tap; fades after 10s of quiet
  const configBtn = $("config-open");
  let configHideTimer = null;
  function wakeConfig() {
    configBtn.classList.remove("faded");
    clearTimeout(configHideTimer);
    configHideTimer = setTimeout(() => configBtn.classList.add("faded"), 10000);
  }
  addEventListener("mousemove", wakeConfig);
  addEventListener("touchstart", wakeConfig, { passive: true });
  wakeConfig();

  const dialog = $("config");
  $("config-open").addEventListener("click", () => dialog.showModal());
  $("config-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", e => { if (e.target === dialog) dialog.close(); });

  function numberInput(id, key) {
    const input = $(id);
    input.value = state[key];
    input.addEventListener("change", () => {
      state[key] = Math.max(0, Number(input.value) || 0);
      input.value = state[key];
      rebuild();
    });
  }
  numberInput("duration", "drawSeconds");
  numberInput("pause", "pauseSeconds");
  numberInput("row-pause", "rowPauseSeconds");

  $("save-frame").addEventListener("click", () => {
    const ph = R.artwork.phaseAtFrame(piece, frame);
    save(frame, "frame-" + String(ph.frame).padStart(4, "0"));
  });
  $("save-final").addEventListener("click", () => save(piece.finalFrame, "final"));

  function save(f, suffix) {
    if (!piece) return;
    const svg = R.artwork.svgAtFrame(piece, f, currentTheme());
    R.render.download(series.slug + "-" + state.layout + "-" + suffix + ".svg", svg);
  }

  // ---- build & paint ------------------------------------------------------

  function rebuild() {
    stop();
    piece = R.artwork.build({
      layout: state.layout, encoding: state.encoding, display: state.display,
      drawSeconds: state.drawSeconds, holdSeconds: state.pauseSeconds,
      rowPauseSeconds: state.rowPauseSeconds, channelFloor: channelFloor()
    });
    view = R.render.mount(host, piece.model, currentTheme());
    frame = piece.finalFrame;
    painted = 0;
    paintFrame(frame);
    alignTelemetry();
    syncControls();
    // any (re)build starts a fresh run; duration 0 stays on the final state
    if (state.drawSeconds !== 0) start();
  }

  // line the telemetry's thick bar up with the drawing's top rule (the SVG
  // letterboxes inside its column, so the rule's page position is computed)
  function alignTelemetry() {
    const head = document.querySelector(".telemetry .head");
    if (!head) return;
    if (piece.model.topRuleY == null) { head.style.marginTop = ""; return; }
    const hostH = host.clientHeight, hostW = host.clientWidth;
    const drawingH = Math.min(hostH, hostW * piece.model.height / piece.model.width);
    const ruleY = (hostH - drawingH) / 2 + drawingH * piece.model.topRuleY / piece.model.height;
    head.style.marginTop = Math.max(0, Math.round(ruleY - (head.offsetHeight - 3))) + "px";
  }

  function paintFrame(f) {
    const ph = R.artwork.phaseAtFrame(piece, f);
    if (ph.locked < painted) {
      for (let i = 0; i < piece.searches.length; i++) view.clearRow(i);
      painted = 0;
    }
    const upTo = ph.done ? piece.searches.length : ph.locked;
    for (let i = painted; i < upTo; i++) view.fillRow(i, piece.real[i], piece.magic[i]);
    painted = upTo;
    if (!ph.done && !ph.resting && ph.current >= 0) {
      const live = R.artwork.liveCells(piece, ph);
      view.fillRow(ph.current, live.colours, live.magic, false);
    }
    const matched = piece.searches.map((r, i) =>
      (ph.done || i < ph.locked) ? (r.matchedChars ?? r.totalChars) : (i === ph.current ? ph.achieved : 0));
    view.setLabels(piece.searches, ph.done ? -1 : ph.current, { liveNonce: ph.nonce, matched });
    readouts(ph);
    return ph;
  }

  function start() {
    if (timer) return;
    // restart the clock from the top when sitting in the final hold,
    // otherwise the loop would play out the remaining hold before wrapping
    startFrame = frame >= piece.finalFrame ? 0 : frame;
    frame = startFrame;
    paintFrame(frame);
    t0 = performance.now();
    const fps = piece.fps;
    timer = setInterval(() => {
      if (document.hidden || !view) return;
      frame = startFrame + Math.round((performance.now() - t0) / 1000 * fps);
      // pause 0: run the cycle once and freeze on the final state
      if (state.pauseSeconds === 0 && frame >= piece.finalFrame) { stop(); return; }
      paintFrame(frame);
    }, Math.round(1000 / fps));
    state.running = true;
    syncControls();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    state.running = false;
    if (view && piece) { frame = piece.finalFrame; paintFrame(frame); }
    syncControls();
  }

  // ---- telemetry ----------------------------------------------------------

  // telemetry may be commented out of the page; every write is optional
  const put = (id, value) => { const n = $(id); if (n) n.textContent = value; };

  function readouts(ph) {
    const i = ph.done ? piece.searches.length - 1 : Math.max(0, ph.current);
    const s = piece.searches[i];
    const m = ph.done ? (s.matchedChars ?? s.totalChars) : Math.max(0, ph.achieved);
    put("t-search", String(i + 1).padStart(2, "0"));
    const target = $("t-target");
    if (target) {
      target.textContent = "";
      target.appendChild(document.createTextNode(s.plaintext.slice(0, m)));
      const tail = document.createElement("span");
      tail.className = "u";
      tail.textContent = s.plaintext.slice(m);
      target.appendChild(tail);
    }
    put("t-match", m + " / " + s.totalChars);
    put("t-encoded", s.encodedHex.slice(0, m * 2) || "—");
    put("t-nonce", fmt(ph.nonce));
    put("t-step", fmt(ph.step));
    const status = $("status");
    if (status) {
      status.textContent = ph.done ? "Series complete" : "Searching " + s.plaintext;
      status.classList.toggle("done", ph.done);
    }
  }

  // ---- fit the 16:9 composition to the window -----------------------------

  const page = document.querySelector(".plate-page");
  const DESIGN = { w: 1920, h: 1080 };
  function fitPage() {
    const s = Math.min(innerWidth / DESIGN.w, innerHeight / DESIGN.h);
    page.style.transform = "scale(" + s + ")";
    page.style.left = (innerWidth - DESIGN.w * s) / 2 + "px";
    page.style.top = (innerHeight - DESIGN.h * s) / 2 + "px";
  }
  addEventListener("resize", fitPage);
  fitPage();

  // ---- static page text ---------------------------------------------------

  document.title = series.name + " — Grinding";
  put("series-name", series.name);
  const totals = R.artwork.totals(series.records);
  put("total-searches", String(totals.searches));
  put("total-matches", String(totals.matches));
  put("total-hashes", fmt(totals.attempts));

  rebuild();
})();
