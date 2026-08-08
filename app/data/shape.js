// Series data — Shape.
// From results.csv: task words_each, base "circle", encoding ascii8. One record
// per target word; its steps are every successively longer prefix match
// (first nonce per match length) of the one continuing grind. Every candidate
// message is circle ‖ nonce (64-bit little-endian); a matched prefix spells the
// word in ASCII hex.
(function () {
  const grinding = window.grinding = window.grinding || {};

  // word, matched chars, nonce, hash — every successively longer prefix match
  const rows = [
    ["triangle", 1, 942, "742bbac41aebf15b56008a12aae6ba7827e328f4a41cf2d79b30eead1a9e7569"],
    ["triangle", 2, 64566, "74727bcc0d43d580b8dced6c78b3b338e53e8f2c8dcd88f1664e0f78b59374fa"],
    ["triangle", 3, 9459496, "747269758ae223ca08a04095ef9752092e010daafd0649307cc870562c660c7b"],
    ["triangle", 4, 1903082377, "74726961da04daf014b13326e1a208d216fc4daf622b034ae24111dfd754cd5a"],
    ["triangle", 5, 493920377740, "747269616e3506e2011ba81bbebb0330721b2f71e52643b691c94a12dfaec4a4"],
    ["triangle", 6, 78206048688766, "747269616e67cc8e3094c658073af6507c989d21317a632849f413db7c43dc0b"],
    ["square", 1, 225, "738e85b4720f29a1d48d37019323b64e696df7735d65d6e737547edb70fa8a88"],
    ["square", 2, 2591, "737138b7b90387090d25f51f7e02bc65a24186de3fd37d51301d7780d78c193c"],
    ["square", 3, 26713306, "737175c27d0ac4335d047c3b385995f33e16711cdbe31e9abf96bdb3f046b049"],
    ["square", 4, 3757427004, "73717561ef5fd59a48b626d4bb0cd23701e7318dc5a08fac41f34dfa69742a7c"],
    ["square", 5, 3105695075858, "7371756172934bb6013d20105439cb2e852677b0cb28555c4fd8518603b6a0e0"],
    ["square", 6, 392673055059321, "7371756172659d3806ac569787a11385bf6069780c8af481fe7f44bf2995d5e9"],
  ];

  const ascii8hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const words = [...new Set(rows.map(r => r[0]))];

  grinding.series = {
    name: "Shape",
    slug: "shape",
    base: "circle",
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
