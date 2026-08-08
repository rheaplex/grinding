// Node script (not loaded by the pages): regenerate a series data file from
// results.csv. Every successively longer prefix match is kept (first nonce
// per match length), grouped by target in the given order, and every hash is
// verified as SHA-256(base ‖ nonce as u64 LE) before writing.
//
//   node app/data/generate.js <name> <base> <outfile> <target>...
//   node app/data/generate.js Number one app/data/number.js two three four ...
const fs = require("fs");
const crypto = require("crypto");

const [name, base, outfile, ...order] = process.argv.slice(2);
if (!order.length) {
  console.error("usage: node generate.js <name> <base> <outfile> <target>...");
  process.exit(1);
}

const lines = fs.readFileSync("results.csv", "utf8").trim().split("\n");
const head = lines[0].split(",");
const col = n => head.indexOf(n);

const seen = new Set();
const byWord = new Map(order.map(w => [w, []]));
for (const line of lines.slice(1)) {
  const f = line.split(",");
  if (f[col("task")] !== "words_each" || f[col("base")] !== base || f[col("encoding")] !== "ascii8") continue;
  const word = f[col("target")];
  if (!byWord.has(word)) continue;
  const chars = Number(f[col("matched_chars")]);
  const key = word + ":" + chars;
  if (seen.has(key)) continue; // repeated runs + longer-in-bits ties: keep first
  seen.add(key);
  byWord.get(word).push({ word, matchedChars: chars, nonce: Number(f[col("nonce")]), hash: f[col("digest")] });
}

for (const [w, rows] of byWord) {
  if (!rows.length) throw new Error("no rows for target " + w);
  for (const r of rows) {
    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(BigInt(r.nonce));
    const h = crypto.createHash("sha256").update(Buffer.concat([Buffer.from(base), le])).digest("hex");
    if (h !== r.hash) throw new Error("hash mismatch for " + r.word + " @ " + r.nonce);
  }
}

let out = `// Series data — ${name}.
// From results.csv: task words_each, base "${base}", encoding ascii8. One record
// per target word; its steps are every successively longer prefix match
// (first nonce per match length) of the one continuing grind. Every candidate
// message is ${base} ‖ nonce (64-bit little-endian); a matched prefix spells the
// word in ASCII hex.
(function () {
  const grinding = window.grinding = window.grinding || {};

  // word, matched chars, nonce, hash — every successively longer prefix match
  const rows = [
`;
for (const w of order)
  for (const r of byWord.get(w))
    out += `    ["${r.word}", ${r.matchedChars}, ${r.nonce}, "${r.hash}"],\n`;
out += `  ];

  const ascii8hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const words = [...new Set(rows.map(r => r[0]))];

  grinding.series = {
    name: "${name}",
    slug: "${name.toLowerCase()}",
    base: "${base}",
    searchEncoding: "ascii8",
    hashFunction: "SHA-256",
    budgetBits: 49,
    records: words.map((word, index) => {
      let prevNonce = 0;
      const steps = rows.filter(r => r[0] === word).map(([, matchedChars, nonce, hash]) => {
        const st = { matchedChars, nonce, prevNonce, deltaAttempts: nonce - prevNonce, hash };
        prevNonce = nonce;
        return st;
      });
      const final = steps[steps.length - 1];
      return {
        index,
        word,
        plaintext: word, // as it appears in the csv
        totalChars: word.length,
        matchedChars: final.matchedChars, // < totalChars if the budget ran out
        full: final.matchedChars === word.length,
        encodedHex: ascii8hex(word),
        matchedNibbles: final.matchedChars * 2,
        nonce: final.nonce,
        attempts: final.nonce + 1,
        hash: final.hash,
        steps
      };
    }),
    words
  };
})();
`;
fs.writeFileSync(outfile, out);
console.log(name + ":", [...byWord.values()].flat().length, "steps across", order.length, "words — all hashes verified");
