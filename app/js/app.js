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
    return {
      ground: v("--ground"), ink: v("--ink"), grid: v("--grid"), ruleSoft: v("--rule-soft"),
      magic: v("--magic"), magicWeight: v("--magic-weight") || "400"
    };
  }

  const encodingOrder = ["rgb12", "grey4", "duo8"];

  const $ = id => document.getElementById(id);
  const host = $("host");
  const fmt = n => n.toLocaleString("en-US");

  // ---- defaults & tuning --------------------------------------------------
  const DEFAULTS = {
    layout: "gutter", encoding: "rgb12", display: "squares", sizing: "fit",
    scheme: "paper", drawSeconds: 120, pauseSeconds: 60, rowPauseSeconds: 2
  };
  const DISPLAYS = [["squares", "squares"], ["circles", "circles"], ["hex", "hex"], ["ascii", "ascii text"]];
  const SIZINGS = [["fit", "fitted"], ["shrink", "shrink"], ["fill", "grow"], ["overlap", "overlap"]];
  const FAN_LAYOUTS = ["radial", "rosette", "spiral"]; // element sizing applies here...
  const BLOCK_DISPLAYS = ["squares", "circles"];       // ...in these displays
  const CONFIG_FADE_MS = 10000;    // the config button fades after this much quiet
  const DARK_CHANNEL_FLOOR = 48;   // colour floor on black grounds
  const DARK_SCHEMES = ["night", "video"];

  const state = { ...DEFAULTS, running: false };

  // ---- url configuration --------------------------------------------------
  // any config option can be set with query parameters, e.g.
  //   ?layout=rosette&display=circles&size=shrink&scheme=video
  //   &encoding=grey4&duration=20&pause=0&rowpause=1&save=final
  // save=final downloads the finished state once loaded; save=<frame>
  // downloads that frame instead. kiosk=true walks the display options at
  // random, one step per cycle (see the kiosk section).
  const params = new URLSearchParams(location.search);
  const pick = (key, allowed) => {
    const v = params.get(key);
    return v !== null && allowed.includes(v) ? v : null;
  };
  const pickNumber = key => {
    const v = Number(params.get(key));
    return params.has(key) && Number.isFinite(v) && v >= 0 ? v : null;
  };
  // switches accept the usual spellings: ?kiosk=true|on|1, ?chrome=off|false|0
  const pickFlag = (key, spellings) => spellings.includes((params.get(key) || "").toLowerCase());
  state.layout = pick("layout", R.layout.layoutNames) ?? state.layout;
  state.display = pick("display", DISPLAYS.map(d => d[0])) ?? state.display;
  state.sizing = pick("size", SIZINGS.map(s => s[0])) ?? state.sizing;
  state.encoding = pick("encoding", encodingOrder) ?? state.encoding;
  state.scheme = pick("scheme", schemeOrder.map(s => s[0])) ?? state.scheme;
  state.drawSeconds = pickNumber("duration") ?? state.drawSeconds;
  state.pauseSeconds = pickNumber("pause") ?? state.pauseSeconds;
  state.rowPauseSeconds = pickNumber("rowpause") ?? state.rowPauseSeconds;
  document.body.className = "scheme-" + state.scheme;

  // black grounds raise the colour floor so zero bytes don't vanish
  const channelFloor = () => DARK_SCHEMES.includes(state.scheme) ? DARK_CHANNEL_FLOOR : undefined;
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
  for (const [key, label] of DISPLAYS)
    optButton(displayBar, key, label, () => { state.display = key; rebuild(); });

  const sizingBar = $("sizing-buttons");
  for (const [key, label] of SIZINGS)
    optButton(sizingBar, key, label, () => { state.sizing = key; rebuild(); });

  const schemeBar = $("scheme-buttons");
  for (const [key, label] of schemeOrder)
    optButton(schemeBar, key, label, () => {
      state.scheme = key;
      document.body.className = "scheme-" + key;
      rebuild();
    });

  // element size only means something where the geometry fans out
  const sizingApplies = () => FAN_LAYOUTS.includes(state.layout)
    && BLOCK_DISPLAYS.includes(state.display);

  function syncControls() {
    [...layoutBar.children].forEach(b => b.classList.toggle("active", b.dataset.key === state.layout));
    [...encodingBar.children].forEach(b => b.classList.toggle("active", b.dataset.key === state.encoding));
    [...displayBar.children].forEach(b => b.classList.toggle("active", b.dataset.key === state.display));
    [...sizingBar.children].forEach(b => {
      b.classList.toggle("active", b.dataset.key === state.sizing);
      b.disabled = !sizingApplies();
    });
    [...schemeBar.children].forEach(b => b.classList.toggle("active", b.dataset.key === state.scheme));
    $("cell-count").textContent = piece ? (piece.textual ? piece.glyphs : piece.cols) : "—";
  }

  // visible at startup and on mouse move / tap; fades after 10s of quiet.
  // ?chrome=off removes it entirely — for capture, kiosks, and previews,
  // where the plate is the whole composition
  const configBtn = $("config-open");
  let configHideTimer = null;
  function wakeConfig() {
    configBtn.classList.remove("faded");
    clearTimeout(configHideTimer);
    configHideTimer = setTimeout(() => configBtn.classList.add("faded"), CONFIG_FADE_MS);
  }
  if (pickFlag("chrome", ["off", "false", "0"])) {
    configBtn.style.display = "none";
  } else {
    addEventListener("mousemove", wakeConfig);
    addEventListener("touchstart", wakeConfig, { passive: true });
    wakeConfig();
  }

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

  // ---- kiosk --------------------------------------------------------------
  // ?kiosk=true walks the display options at random: each time a cycle
  // completes, one of layout, hash display, element size, scheme, or
  // encoding steps to a different value and the piece rebuilds. Timing is
  // left alone, so the URL (or the chain) still sets the pace; a still
  // (duration 0) moves on after its pause instead
  const kiosk = pickFlag("kiosk", ["true", "on", "1"]);
  const KIOSK_OPTIONS = [
    ["layout", () => R.layout.layoutNames],
    ["display", () => DISPLAYS.map(d => d[0])],
    ["sizing", () => sizingApplies() ? SIZINGS.map(s => s[0]) : []],
    ["scheme", () => schemeOrder.map(s => s[0])],
    ["encoding", () => encodingOrder]
  ];
  const pickRandom = list => list[Math.floor(Math.random() * list.length)];
  let kioskTimer = null;
  function kioskStep() {
    // only options with somewhere visible to step to
    const [key, values] = pickRandom(KIOSK_OPTIONS.filter(([, v]) => v().length > 1));
    state[key] = pickRandom(values().filter(v => v !== state[key]));
    if (key === "scheme") document.body.className = "scheme-" + state.scheme;
    rebuild();
  }

  // ---- build & paint ------------------------------------------------------

  function rebuild() {
    stop();
    piece = R.artwork.build({
      layout: state.layout, encoding: state.encoding, display: state.display,
      sizing: state.sizing,
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
    else if (kiosk) kioskTimer = setTimeout(kioskStep, Math.max(1, state.pauseSeconds) * 1000);
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
    view.setHeader(ph.header !== false);
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
      // a kiosk moves on once the cycle (with no hold, the drawing) is done
      const cycleEnd = state.pauseSeconds === 0 ? piece.finalFrame : piece.frames;
      if (kiosk && frame >= cycleEnd) { kioskStep(); return; }
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
    clearTimeout(kioskTimer);
    kioskTimer = null;
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

  // ---- chain ---------------------------------------------------------------
  // with an Ethereum plugin and a configured contract (chain-config.js), the
  // token's stored display configuration fills in whatever the URL leaves
  // unsaid — an explicit query parameter always wins — and the token's owner
  // can write the current configuration back from the Config dialog. The
  // contract enforces ownership; the page checks it first to say so plainly.
  const chain = R.chain;
  if (chain && chain.enabled()) {
    chain.read().then(stored => {
      if (!stored) return; // nothing written on chain yet
      const sp = new URLSearchParams(stored.replace(/^\?/, ""));
      const take = (key, allowed, apply) => {
        if (params.has(key) || !sp.has(key)) return false;
        const v = sp.get(key);
        if (allowed && !allowed.includes(v)) return false;
        apply(v);
        return true;
      };
      const takeNumber = (key, apply) => take(key, null, v => apply(Number(v)));
      let changed = false;
      changed = take("layout", R.layout.layoutNames, v => { state.layout = v; }) || changed;
      changed = take("encoding", encodingOrder, v => { state.encoding = v; }) || changed;
      changed = take("display", DISPLAYS.map(d => d[0]), v => { state.display = v; }) || changed;
      changed = take("size", SIZINGS.map(s => s[0]), v => { state.sizing = v; }) || changed;
      changed = take("scheme", schemeOrder.map(s => s[0]), v => {
        state.scheme = v;
        document.body.className = "scheme-" + v;
      }) || changed;
      changed = takeNumber("duration", v => { state.drawSeconds = Math.max(0, v || 0); }) || changed;
      changed = takeNumber("pause", v => { state.pauseSeconds = Math.max(0, v || 0); }) || changed;
      changed = takeNumber("rowpause", v => { state.rowPauseSeconds = Math.max(0, v || 0); }) || changed;
      if (changed) {
        $("duration").value = state.drawSeconds;
        $("pause").value = state.pauseSeconds;
        $("row-pause").value = state.rowPauseSeconds;
        rebuild();
      }
    }).catch(() => {}); // an unreachable chain loses the viewer nothing
  }

  const chainSection = $("chain-section");
  if (chain && chain.enabled() && chainSection) {
    chainSection.hidden = false;
    const status = $("chain-status");
    // the transaction hash gets its own full-width line at the bottom of the
    // section; inline beside the button it forces the dialog wide open
    const txLine = $("chain-tx");
    const showTx = hash => {
      if (!txLine) return;
      txLine.textContent = hash;
      txLine.hidden = false;
    };
    $("chain-save").addEventListener("click", async () => {
      try {
        if (txLine) txLine.hidden = true;
        status.textContent = "connecting…";
        const account = await chain.connect();
        const owner = await chain.ownerOf();
        if (owner.toLowerCase() !== account.toLowerCase()) {
          status.textContent = "only the owner of token " + chain.tokenId() +
            " may write; " + account.slice(0, 10) + "… does not own it";
          return;
        }
        status.textContent = "confirm in the wallet…";
        const tx = await chain.write(account, {
          layout: state.layout, encoding: state.encoding, display: state.display,
          sizing: state.sizing, scheme: state.scheme,
          drawSeconds: state.drawSeconds, pauseSeconds: state.pauseSeconds,
          rowPauseSeconds: state.rowPauseSeconds
        });
        status.textContent = "sent";
        showTx(tx);
      } catch (e) {
        status.textContent = e && e.message ? e.message : "failed";
      }
    });
  }

  // ?save=final (or a frame number) downloads that state once loaded
  const saveParam = params.get("save");
  if (saveParam === "final") save(piece.finalFrame, "final");
  else if (saveParam && /^\d+$/.test(saveParam)) save(Number(saveParam), "frame-" + saveParam.padStart(4, "0"));
})();
