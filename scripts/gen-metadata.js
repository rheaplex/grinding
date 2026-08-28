// Write Transient Labs-style token metadata, one extensionless JSON file per
// token at metadata/<id>, ready for `ipfs add -r metadata` — the directory
// CID then becomes the contract's base URI (tokenURI(n) = ipfs://<cid>/<n>).
//
// Per https://docs.transientlabs.xyz metadata structure: name, description,
// external_url, attributes, tags, image (+image_sha256), animation_url
// (+animation_sha256), media. The work's web page is both the external link
// (on the show site) and the animation_url (on IPFS); the preview PNG from
// gen-previews.js is the image.
//
//   APP_CID=<cid of app/> IMAGES_CID=<cid of previews/png/> \
//   node scripts/gen-metadata.js
//
// Optional: SHOW_URL_BASE (default https://show.rhea.art/grinding/).
// upload-ipfs.sh runs this with the CIDs it just added.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TOKEN_COUNT, TOKENS } = require("./tokens");
const { APP_DIR, loadWork } = require("./lib");

const APP_CID = process.env.APP_CID;
const IMAGES_CID = process.env.IMAGES_CID;
const SHOW_URL_BASE = process.env.SHOW_URL_BASE || "https://show.rhea.art/grinding/";
if (!APP_CID || !IMAGES_CID) {
  console.error(
    "usage: APP_CID=<cid of app/> IMAGES_CID=<cid of previews/png/> node scripts/gen-metadata.js\n" +
    "(scripts/upload-ipfs.sh adds those directories and runs this for you)"
  );
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const META_DIR = process.env.META_DIR || path.join(ROOT, "metadata");
fs.mkdirSync(META_DIR, { recursive: true });

const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fmt = n => n.toLocaleString("en-US");

for (const token of TOKENS) {
  const series = loadWork(token.work).series;
  const totals = {
    searches: series.records.length,
    matches: series.records.reduce((a, r) => a + (r.steps ? r.steps.length : 1), 0),
    // every-hit (spiral) records carry the deepest nonce scanned; first-match
    // records stop at their winning nonce
    attempts: series.records.reduce((a, r) => a + (r.lastNonce ? r.lastNonce + 1 : r.attempts), 0),
    hits: series.records.reduce((a, r) => a + (r.hits || 0), 0),
  };
  const pngPath = path.join(ROOT, "previews", "png", `${token.id}.png`);
  const pagePath = path.join(APP_DIR, token.page);

  const baseClause = series.base ? `the base “${series.base}”` : "its base word";
  const metadata = {
    name: token.name,
    description:
      `${token.note} Proof-of-work text search: each candidate hashes ` +
      `${baseClause} with an incrementing counter appended; the grind climbs successively longer ` +
      `prefix matches until the ${series.hashFunction} hash spells its target word. ` +
      `Every hash shown was actually found, across ${fmt(totals.attempts)} attempts. ` +
      `Number ${token.id} of the ${TOKEN_COUNT} Grinding tokens.`,
    external_url: `${SHOW_URL_BASE}${token.page}`,
    attributes: [
      { trait_type: "Work", value: series.name },
      { trait_type: "Base", value: series.base || "per search" },
      { trait_type: "Topology", value: series.topology || "star_from" },
      { trait_type: "Search Encoding", value: series.searchEncoding },
      { trait_type: "Hash Function", value: series.hashFunction },
      { trait_type: "Searches", value: String(totals.searches) },
      { trait_type: "Matches", value: String(totals.matches) },
      { trait_type: "Hashes", value: String(totals.attempts) },
      ...(totals.hits ? [{ trait_type: "Hits Collected", value: String(totals.hits) }] : []),
    ],
    tags: ["grinding", "proof-of-work", "hash", "text", "generative"],
    image: `ipfs://${IMAGES_CID}/${token.id}.png`,
    image_sha256: sha256(pngPath),
    animation_url: `ipfs://${APP_CID}/${token.page}`,
    animation_sha256: sha256(pagePath),
    media: {
      uri: `ipfs://${APP_CID}/${token.page}`,
      size: String(fs.statSync(pagePath).size),
      dimensions: "1920x1080",
      mimeType: "text/html",
    },
  };

  const file = path.join(META_DIR, String(token.id));
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2) + "\n");
  console.log(`${token.id} ${token.name}: ${path.relative(ROOT, file)}`);
}

if (TOKENS.length < TOKEN_COUNT) {
  console.warn(
    `warning: wrote ${TOKENS.length} of ${TOKEN_COUNT} metadata files; ` +
    `tokenURI will 404 for the missing ids until scripts/tokens.js is filled in`
  );
}

// Collection metadata for ERC-7572 contractURI() — OpenSea reads this for
// the collection name, description, and image. Lives beside the token files,
// so CONTRACT_URI = <base URI>/collection.
const collection = {
  name: "Grinding",
  description:
    "Proof-of-work text search. Each candidate hashes a base with a counter " +
    "appended; the grind climbs successively longer prefix matches until the " +
    "SHA-256 hash spells its target word. Twelve works, each one base and its " +
    "found words, drawn from the real search records — every hash shown was " +
    "actually found. Rhea Myers, 2026.",
  image: `ipfs://${IMAGES_CID}/1.png`,
  external_link: SHOW_URL_BASE,
};
const collectionFile = path.join(META_DIR, "collection");
fs.writeFileSync(collectionFile, JSON.stringify(collection, null, 2) + "\n");
console.log(`collection: ${path.relative(ROOT, collectionFile)}`);
