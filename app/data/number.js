// Series data — Number.
// From results.csv: task words_each, base "one", encoding ascii8. One record
// per target word; its steps are every successively longer prefix match
// (first nonce per match length) of the one continuing grind. Every candidate
// message is one ‖ nonce (64-bit little-endian); a matched prefix spells the
// word in ASCII hex.
(function () {
  const grinding = window.grinding = window.grinding || {};

  // word, matched chars, nonce, hash — every successively longer prefix match
  const rows = [
    ["two", 1, 4, "746ecd24d5f32e2ac564c6df616c99c9cc3e44fcae0e67234d2b591ece76b166"],
    ["two", 2, 100873, "747715824ad29ce666f5aad69262019c12d138e8570f68bf1e5448711df2e460"],
    ["two", 3, 10001501, "74776f79ea8ca4cc1e25213e3c8787b7d34bf1fd8b265e0a392b0971085b4ba1"],
    ["three", 1, 4, "746ecd24d5f32e2ac564c6df616c99c9cc3e44fcae0e67234d2b591ece76b166"],
    ["three", 2, 10440, "7468c3a4ed768c29f17f80014a46b02e5888b6439878af7d7532c145ce5822c4"],
    ["three", 3, 15641475, "746872438a96b4e491e1840e2d944ab390413d85ad9f2ed4996bf0127c62345f"],
    ["three", 4, 7987464882, "74687265a3a993c790ac06faef2c0a505ce591762cc427ce0f14afc95140dd19"],
    ["three", 5, 812222936346, "7468726565eec9f99426bb58346df242b11da55596342eb613293a0d01b14513"],
    ["four", 1, 145, "6683a12f1374b9ed249abbdc194f4d72acb516f170a12259dc360eab3a827acf"],
    ["four", 2, 4395, "666f6afae086919d71b332e3bdca595cfa2379d895be8be63be1412b2a5dfc41"],
    ["four", 3, 16864985, "666f75a2b45ca02546fd235c229556c7c68d9d872a29e001136352b650e2854c"],
    ["four", 4, 3299839686, "666f7572de1385af8d3842d9fd83ac31bbb8552d53edf0c073cc54ebc6e4da3f"],
    ["five", 1, 145, "6683a12f1374b9ed249abbdc194f4d72acb516f170a12259dc360eab3a827acf"],
    ["five", 2, 30055, "6669a498d98e9c021c7083f9f7ac5857c5b3c0c0acc782662b3a7e1fec67481b"],
    ["five", 3, 3035179, "666976053f87545a2217cf19c92bbccd58a194500f2786fef50cabc949ec402e"],
    ["five", 4, 750981343, "66697665caa96d4687b6e9646cc08bbeabf9bcbe1032ebfdf52e9663dc1b5cbb"],
    ["six", 1, 25, "7315c247a461b3f32ef9dfda4d1cad218561b26ef225d2b02ef923ce1aed1a58"],
    ["six", 2, 200425, "7369f7a84799e5b48deb71ee140738bd4c1ff3acdf73b09ebc6d82ec4e043a6d"],
    ["six", 3, 20834218, "7369782ced56bc1fe050d963e783f5f0127bc4495bbe5609c79d65e7803db0ab"],
    ["seven", 1, 25, "7315c247a461b3f32ef9dfda4d1cad218561b26ef225d2b02ef923ce1aed1a58"],
    ["seven", 2, 61331, "7365408345486ce04fedcef6120df1560802c9ff97673b8214880baf6f4de241"],
    ["seven", 3, 26558206, "736576703131293e77cb7e12b9f9a217ddabae8d36b1f772cf46cf8740fda407"],
    ["seven", 4, 613889083, "73657665783c527cb4f484e477841fdfbdc93899cb146169408c3b560a202635"],
    ["seven", 5, 3178052849263, "736576656ee5557cee59b9981c0a422be8e2051897e194c167dca041d9fbf50c"],
    ["eight", 1, 628, "6542d0abe2c594d25ea1957514c657d14617311f83a5bc1e8f07a78b3d390e3f"],
    ["eight", 2, 27157, "65691e6e63386ea2f422cc3bbd28ddf336cb5ad21e1cdc3a8f774cd77ff4cff9"],
    ["eight", 3, 21621441, "656967e2d92edcec9c6cd09cba1ff68c4774fab4cf87ea0a19d1941cc772d414"],
    ["eight", 4, 1847288658, "656967680f39339fd43063f6cd9cc46005c6f2469e0d8b5c51b36b9c0d2c16ae"],
    ["eight", 5, 602498062990, "6569676874ca84898a0741232bf4fc46f73f8c6992d1ff321c6f6339dd5eec28"],
    ["nine", 1, 136, "6e367660a5e3b7cf81b3ef0436848a5e6515dc4ed8c7f253fe675e4eba79e5a4"],
    ["nine", 2, 18953, "6e6960663e8887a8d5f8463c3b763e8a439cc6dddd1107329ba88dd1a9045eeb"],
    ["nine", 3, 24047238, "6e696ef2171122abb9dd6e6232331c0abb55836263c8b8b9fcb9f76c78898d76"],
    ["nine", 4, 715215373, "6e696e654466e47a8e5af62a2dad1a49821214764a3b229488c3f7aa87466720"],
    ["ten", 1, 4, "746ecd24d5f32e2ac564c6df616c99c9cc3e44fcae0e67234d2b591ece76b166"],
    ["ten", 2, 36162, "74655eabebde8ab86e0a23891d0c1d283802e128f9a64cff527a56f453eb174a"],
    ["ten", 3, 23609720, "74656e596d1c163cd8d86528659b0588934a259577c24f5a150d9c996f757b04"],
  ];

  const ascii8hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const words = [...new Set(rows.map(r => r[0]))];

  grinding.series = {
    name: "Number",
    slug: "number",
    base: "one",
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
