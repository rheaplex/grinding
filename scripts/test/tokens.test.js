// The token table is the single source of truth for the asset pipeline;
// these tests catch the ways an edit to it can silently break the scripts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { TOKEN_COUNT, TOKENS } = require("../tokens");
const { APP_DIR } = require("../lib");

test("token count matches the contract's fixed edition", () => {
  assert.equal(TOKEN_COUNT, 12);
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "contract", "src", "Grinding.sol"), "utf8");
  const match = source.match(/TOKEN_COUNT\s*=\s*(\d+)/);
  assert.ok(match, "Grinding.sol should declare TOKEN_COUNT");
  assert.equal(Number(match[1]), TOKEN_COUNT);
});

test("ids are unique, ordered, and within the edition", () => {
  const ids = TOKENS.map(t => t.id);
  assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b));
  for (const id of ids) {
    assert.ok(id >= 1 && id <= TOKEN_COUNT, `id ${id} outside 1..${TOKEN_COUNT}`);
  }
});

test("every entry is complete and its app files exist", () => {
  for (const t of TOKENS) {
    for (const field of ["work", "page", "name", "note", "config"]) {
      assert.ok(t[field] !== undefined, `token ${t.id} missing ${field}`);
    }
    assert.ok(fs.existsSync(path.join(APP_DIR, t.page)),
      `token ${t.id}: app/${t.page} missing`);
    assert.ok(fs.existsSync(path.join(APP_DIR, "data", `${t.work}.js`)),
      `token ${t.id}: app/data/${t.work}.js missing`);
  }
});

test("data files carry the same token ids as this table", () => {
  const { loadWork } = require("../lib");
  for (const t of TOKENS) {
    assert.equal(loadWork(t.work).series.tokenId, t.id,
      `${t.work}: series.tokenId disagrees with tokens.js`);
  }
});

test("preview configs use the page vocabulary", () => {
  const allowed = {
    layout: ["plate", "rings", "hexRing", "honeycomb", "radial", "rosette", "spiral", "gutter"],
    encoding: ["rgb12", "grey4", "duo8"],
    display: ["squares", "circles", "hex", "ascii"],
    sizing: ["fit", "shrink", "fill", "overlap"],
    scheme: ["paper", "night", "video", "inverse"],
  };
  for (const t of TOKENS) {
    for (const [key, values] of Object.entries(allowed)) {
      if (t.config[key] !== undefined) {
        assert.ok(values.includes(t.config[key]),
          `token ${t.id}: config.${key} "${t.config[key]}" not in ${values}`);
      }
    }
  }
});
