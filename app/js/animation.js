// Animation package — how stored results become elapsed time.
// Nothing here knows about colour or shape: it maps a clock to a search index
// and a nonce, scaling the step size up and back down so the ramp eases in and
// out and still lands exactly on the recorded winning nonce.
(function () {
  const grinding = window.grinding = window.grinding || {};

  const easings = {
    linear: p => p,
    inOutCubic: p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2,
    inOutQuint: p => p < 0.5 ? 16 * Math.pow(p, 5) : 1 - Math.pow(-2 * p + 2, 5) / 2,
    outExpo: p => p === 1 ? 1 : 1 - Math.pow(2, -10 * p),
    inOutSine: p => -(Math.cos(Math.PI * p) - 1) / 2
  };

  // work a step represents: the hashes since the previous match on its search
  const work = s => s.deltaAttempts ?? s.attempts;

  // per-step duration derived from the real attempt count, compressed by sqrt
  // so an astronomical spread in work becomes a small spread on screen.
  // steps are the flattened progression: { row, matchedChars, achievedChars,
  // nonce, prevNonce, deltaAttempts, hash } in grind order.
  function schedule(steps, opts = {}) {
    const { timeScale = 1, holdMs = 7000, baseMs = 650, spanMs = 2500, compress = Math.sqrt, drawMs = null, rowPauseMs = 0 } = opts;
    const slowest = Math.max(...steps.map(work));
    let durations = steps.map(s => (baseMs + spanMs * compress(work(s) / slowest)) / timeScale);
    // a rest after each row's final step — not after the last row — plus a
    // two-part lead-in: a rest with everything pending, then the initial
    // value appears and rests before the first row begins
    const pauses = steps.map((s, i) =>
      rowPauseMs && steps[i + 1] && steps[i + 1].row !== s.row ? rowPauseMs : 0);
    const headerAt = rowPauseMs;
    const lead = rowPauseMs * 2;
    const pauseTotal = lead + pauses.reduce((a, p) => a + p, 0);
    const workTotal = durations.reduce((a, d) => a + d, 0);
    // an explicit drawing time rescales the grind so the whole drawing
    // (rests included, at their set length) takes exactly drawMs
    if (drawMs > 0 && workTotal > 0) {
      const k = Math.max(drawMs - pauseTotal, drawMs * 0.1) / workTotal;
      durations = durations.map(d => d * k);
    }
    const starts = [];
    let t = lead;
    durations.forEach((d, i) => { starts.push(t); t += d + pauses[i]; });
    return { durations, starts, pauses, lead, headerAt, gridEnd: t, total: t + holdMs, holdMs };
  }

  function phaseAt(clockMs, steps, sched, opts = {}) {
    const { easing = "inOutCubic", churnEvery = 11, loop = true, dtMs = 0, frameP: framePOpt = 1 / 16 } = opts;
    const ease = typeof easing === "function" ? easing : easings[easing];
    const t = loop ? clockMs % sched.total : Math.min(clockMs, sched.total);
    const last = steps.length - 1;
    const rows = steps[last].row + 1;
    if (t >= sched.gridEnd) {
      return { t, locked: rows, current: -1, stepIndex: -1, achieved: -1, nonce: steps[last].nonce, step: 0, seed: 0, done: true, header: true };
    }
    // the lead-in rests: first everything greyed out, every row pending,
    // then the initial value appears and holds before the first row begins
    if (t < sched.starts[0]) {
      return {
        t, stepIndex: -1, locked: 0, current: -2, resting: true,
        header: t >= (sched.headerAt || 0),
        achieved: 0, targetChars: 0, nonce: 0, step: 0, seed: 0, done: false
      };
    }
    let s = 0;
    while (s < last && t >= sched.starts[s + 1]) s++;
    const st = steps[s];
    // in the rest after a row's final step: the row sits freshly locked
    if (t - sched.starts[s] >= sched.durations[s]) {
      return {
        t, stepIndex: s, locked: st.row + 1, current: st.row, resting: true,
        header: true, achieved: st.matchedChars, targetChars: st.matchedChars,
        nonce: st.nonce, step: 0, seed: 0, done: false
      };
    }
    const p = Math.min(1, (t - sched.starts[s]) / sched.durations[s]);
    const frameP = dtMs ? dtMs / sched.durations[s] : framePOpt;
    const e = ease(p), ePrev = ease(Math.max(0, p - frameP));
    // each step continues its search's grind from the previous match
    const from = st.prevNonce || 0, span = st.nonce - from;
    const nonce = Math.round(from + span * e);
    return {
      t, stepIndex: s, locked: st.row, current: st.row, header: true,
      achieved: st.achievedChars, targetChars: st.matchedChars, nonce,
      step: Math.max(1, Math.round(span * (e - ePrev))),
      seed: (Math.floor(nonce / churnEvery) % 2147483647) + s * 7919,
      done: false, progress: p
    };
  }

  const finalPhase = (steps, sched) => ({
    t: sched.gridEnd, locked: steps[steps.length - 1].row + 1, current: -1, stepIndex: -1, achieved: -1,
    nonce: steps[steps.length - 1].nonce, step: 0, seed: 0, done: true, header: true
  });

  // ---- frame addressing: the whole piece as a function of an integer ----
  const FPS = 30;
  const frameCount = (sched, fps = FPS) => Math.max(1, Math.round(sched.total / 1000 * fps));

  // deterministic: the same frame index always yields the same phase
  function phaseAtFrame(frame, steps, sched, opts = {}) {
    const fps = opts.fps || FPS;
    const frames = frameCount(sched, fps);
    const f = ((Math.round(frame) % frames) + frames) % frames;
    const ph = phaseAt(f / fps * 1000, steps, sched, { ...opts, loop: false, dtMs: 1000 / fps });
    return { ...ph, frame: f, frames, fps };
  }

  // first frame at which every search is locked (the exportable final state)
  function finalFrame(sched, fps = FPS) {
    return Math.min(frameCount(sched, fps) - 1, Math.ceil(sched.gridEnd / 1000 * fps) + 1);
  }

  grinding.animation = { easings, schedule, phaseAt, finalPhase, FPS, frameCount, phaseAtFrame, finalFrame };
})();
