// finalSvg is the preview pipeline's core: the app's own artwork code run
// outside the browser. These tests pin the properties the pipeline relies
// on — valid standalone SVG, determinism, and config actually taking effect.
const test = require("node:test");
const assert = require("node:assert/strict");

const { SCHEMES, loadWork, finalSvg } = require("../lib");
const { TOKENS } = require("../tokens");

test("every token's work renders a standalone SVG", () => {
  for (const t of TOKENS) {
    const svg = finalSvg(t.work, t.config);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
      `token ${t.id} (${t.work})`);
    assert.match(svg, /<\/svg>\s*$/);
    assert.match(svg, /<metadata>/, "embeds the grind metadata block");
  }
});

test("rendering is deterministic", () => {
  assert.equal(finalSvg("colour"), finalSvg("colour"));
});

test("the scheme sets the ground colour", () => {
  for (const [name, palette] of Object.entries(SCHEMES)) {
    const svg = finalSvg("colour", { scheme: name });
    assert.ok(svg.includes(`fill="${palette.ground}"`),
      `${name} ground ${palette.ground} missing`);
  }
});

test("layout and encoding config change the output", () => {
  const base = finalSvg("shape");
  assert.notEqual(finalSvg("shape", { layout: "rings" }), base);
  assert.notEqual(finalSvg("shape", { encoding: "grey4" }), base);
});

test("export scale multiplies the pixel size, not the geometry", () => {
  const g = loadWork("colour");
  const piece = g.artwork.build({});
  const w = piece.model.width;
  const at = s => finalSvg("colour", {}, s).match(/width="(\d+)"/)[1];
  assert.equal(at(1), String(w));
  assert.equal(at(2), String(w * 2));
});

test("hub series draw no initial-value row", () => {
  // in star_from and spiral the base is the concept the words are ground
  // from — not part of the composition; a ring's seed word still leads it
  const model = work => loadWork(work).artwork.build({}).model;
  for (const work of ["gender", "pattern", "direction", "passions", "attribution"]) {
    assert.ok(!model(work).header, `${work} should have no header row`);
  }
  assert.ok(model("colour").header, "a ring keeps its seed row");
  assert.ok(model("number").header, "a chain keeps its seed row");
  assert.ok(!model("icjbag").header, "icjbag declines its seed row (seedRow: false)");
});

test("headerless pieces skip the initial-value rest in the lead-in", () => {
  // default row pause is 2s: one lead rest without a header row, two with
  const lead = work => loadWork(work).artwork.build({}).sched.lead;
  assert.equal(lead("gender"), 2000);
  assert.equal(lead("icjbag"), 2000);
  assert.equal(lead("colour"), 4000);
});

test("the final frame shows every search resolved", () => {
  // every row locked: as many filled rows as records, none still churning
  const g = loadWork("number");
  const piece = g.artwork.build({});
  const state = g.artwork.stateAtFrame(piece, piece.finalFrame);
  assert.equal(state.phase.done, true);
  assert.equal(state.rows.filter(Boolean).length, piece.searches.length);
});
