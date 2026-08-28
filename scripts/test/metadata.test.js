// Run gen-metadata.js against a temp directory and check its output against
// the Transient Labs metadata structure the contract's base URI will serve.
// Needs previews/png (run gen-previews.js first); the whole-pipeline dry run
// at the end needs ipfs and is skipped without it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const { TOKENS } = require("../tokens");

const APP_CID = "bafytestappcid";
const IMAGES_CID = "bafytestimagescid";
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const havePreviews = TOKENS.every(t =>
  fs.existsSync(path.join(ROOT, "previews", "png", `${t.id}.png`)));

test("gen-metadata refuses to run without CIDs", () => {
  const r = spawnSync("node", [path.join(ROOT, "scripts", "gen-metadata.js")],
    { env: { ...process.env, APP_CID: "", IMAGES_CID: "" } });
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr), /usage:/);
});

test("metadata follows the Transient Labs structure", { skip: !havePreviews }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grinding-meta-"));
  execFileSync("node", [path.join(ROOT, "scripts", "gen-metadata.js")],
    { env: { ...process.env, APP_CID, IMAGES_CID, META_DIR: dir } });

  for (const t of TOKENS) {
    const file = path.join(dir, String(t.id));
    assert.ok(fs.existsSync(file), `metadata file ${t.id} (extensionless) missing`);
    const m = JSON.parse(fs.readFileSync(file, "utf8"));

    // required fields
    assert.equal(m.name, t.name);
    assert.ok(m.description.length > 0);
    assert.equal(m.image, `ipfs://${IMAGES_CID}/${t.id}.png`);

    // the page html is both the external link and the animation
    assert.equal(m.animation_url, `ipfs://${APP_CID}/${t.page}`);
    assert.ok(m.external_url.endsWith(`/${t.page}`));

    // integrity hashes match the actual assets
    assert.equal(m.image_sha256, sha256(path.join(ROOT, "previews", "png", `${t.id}.png`)));
    assert.equal(m.animation_sha256, sha256(path.join(ROOT, "app", t.page)));

    // attributes are trait_type/value pairs; media describes the main asset
    assert.ok(Array.isArray(m.attributes) && m.attributes.length > 0);
    for (const a of m.attributes) {
      assert.ok(a.trait_type && a.value !== undefined);
    }
    assert.equal(m.media.uri, m.animation_url);
    assert.equal(m.media.mimeType, "text/html");
    assert.equal(m.media.size, String(fs.statSync(path.join(ROOT, "app", t.page)).size));
    assert.match(m.media.dimensions, /^\d+x\d+$/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const haveIpfs = spawnSync("ipfs", ["version"]).status === 0;

test("car export refuses a dry run", () => {
  const r = spawnSync(path.join(ROOT, "scripts", "upload-ipfs.sh"), ["--dry-run", "--car"],
    { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs a real run/);
});

test("upload-ipfs dry run prints a base URI and records nothing",
  { skip: !haveIpfs || !havePreviews }, () => {
    const r = spawnSync(path.join(ROOT, "scripts", "upload-ipfs.sh"), ["--dry-run"],
      { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /base URI: ipfs:\/\/baf[a-z2-7]+\/$/m);
    assert.ok(!r.stdout.includes("recorded in"), "dry run must not write ipfs-cids.env");
  });
