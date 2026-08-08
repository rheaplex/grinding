// Series data — Form.
// From results.csv: task words_each, base "point", encoding ascii8. One record
// per target word; its steps are every successively longer prefix match
// (first nonce per match length) of the one continuing grind. Every candidate
// message is point ‖ nonce (64-bit little-endian); a matched prefix spells the
// word in ASCII hex.
(function () {
  const grinding = window.grinding = window.grinding || {};

  // word, matched chars, nonce, hash — every successively longer prefix match
  const rows = [
    ["line", 1, 76, "6ccf6caf1b7ee8a2b4131eb461350f3176e29b5814331db8f1317a82caceb6a1"],
    ["line", 2, 63439, "6c6942c95b5ea8d701dd5d0c7a6c2e3de903b19524b7b0ee6d56c6960fe10465"],
    ["line", 3, 16728127, "6c696e98cf39e70300d4039bd254beeede7b473ed930fc3f3a58407ecaf31f39"],
    ["line", 4, 853971501, "6c696e65c19edba671c21c1113c97dd6e9bc0d33e538d328870d5d259dccfc17"],
    ["plane", 1, 176, "70eaa0e71c4b408605e91f0e51ceb072bea1316f34f257c7adde035d777036f1"],
    ["plane", 2, 202064, "706c9bba9214d3277ea5eb502763705efdfcbf50d22109889caf85e2f1189148"],
    ["plane", 3, 32087252, "706c619f640cbb29b0816732ecdf96f9f31490151e2a7ef377dcd40c7aef5522"],
    ["plane", 4, 3563498863, "706c616ec78b87d106ff0278b0eb46100e5a880ef35c75d1122ebed3434823c2"],
    ["plane", 5, 805506999743, "706c616e65c89c68566433942ebd986ad20b9fe7bf9ce69e3f9989e37b69c080"],
    ["volume", 1, 867, "76c33ce8736fcf96b8e800a1a13e5744afa9f48c5080c50f042742ee1c58bc7b"],
    ["volume", 2, 57082, "766f7ddbc83b43a9cb8d4868956f0e28d9a97491cb55a7d4f4198889431e41d5"],
    ["volume", 3, 136572, "766f6c91d4ceeabb79bbee48ca04ce9c6d9bfa7b42e51806bac392e85ef0e8a0"],
    ["volume", 4, 20940783198, "766f6c75074c9dfaa4bc45c0086bc81147e9899d5d6e6c8c3dfc287a1e8b5e9b"],
    ["volume", 5, 163662703190, "766f6c756ddc80ab418d1b7d7c224fa91e230ab479d81f43156e62ae6156b3be"],
    ["volume", 6, 28314239436459, "766f6c756d6568d422d09f21e54cd2dff5bc826a5f0c74d91ec7a962c1910f0f"],
  ];

  const ascii8hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const words = [...new Set(rows.map(r => r[0]))];

  grinding.series = {
    name: "Form",
    slug: "form",
    base: "point",
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
