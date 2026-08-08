// Series data — Colour.
// From results.csv: task words_each, base "red", encoding ascii8. One record
// per target word; its steps are every successively longer prefix match
// (first nonce per match length) of the one continuing grind. Every candidate
// message is red ‖ nonce (64-bit little-endian); a matched prefix spells the
// word in ASCII hex.
(function () {
  const grinding = window.grinding = window.grinding || {};

  // word, matched chars, nonce, hash — every successively longer prefix match
  const rows = [
    ["orange", 1, 235, "6f13badde4e3c3eb4dec5b46ee0fee7b7a8bff0859b1e863d0b5c567cd182ec5"],
    ["orange", 2, 63938, "6f726f8f871f4591c6bdf231fc8d682d1a189a09ba6d54a30f90e8e537e136e9"],
    ["orange", 3, 30856745, "6f72615c7dab1390fa094736109b45e24df47fa9ef4826920cb5c8d824b97632"],
    ["orange", 4, 495192798, "6f72616e089746a7a496e3af43b04f25eee731120e19b47d8f8d361bd3f4e694"],
    ["orange", 5, 83716479481, "6f72616e67952d4e25dfd92c309ab37670aacabde280db49ac8d1c11690f1c82"],
    ["orange", 6, 380057725553316, "6f72616e6765fe0c2f23ec4e95c938856b1969a1181e7edc664a397ad42035d7"],
    ["yellow", 1, 58, "79065258ac97807c8c9f191916e6c5d718d3a6dc269431945df862fd4b7ae8e8"],
    ["yellow", 2, 182912, "796562b6035de399b50be867251f939e781cb8d7578acfa5ef3178074d13e752"],
    ["yellow", 3, 67241285, "79656c7a6bdc39689cac6d2065a2ee7ba09961d6666f4fec7770b1771be5fcd4"],
    ["yellow", 4, 8288324316, "79656c6c447f715b201fab948c8616869843bcebe25e0597a5db658851313cde"],
    ["yellow", 5, 436525254674, "79656c6c6fd1c4d1bdd4f00a26d30f371bf0430715799b3346985c7e6578df23"],
    ["yellow", 6, 534590898576312, "79656c6c6f770fcd4775821125e6d24a857ea21e5d4dedfbb06549cc816c58ba"],
    ["green", 1, 170, "6764ae34a5d909eb5ebe12d5608b1504990a238153e527192bc64231e2bcd2cb"],
    ["green", 2, 63478, "677240ba5ddb1f2848e8d310e9ae0a7c96805ee17d0ba75cba8af5a217d351cf"],
    ["green", 3, 31582932, "677265ffc7d4c6dcbf93647895a82522dc2edda0a7645ec40883778ab0b07c36"],
    ["green", 4, 88852173, "67726565c53960d0d57e5031a50f66c3035d43ba68f10ce7d8c49f332bf395d3"],
    ["green", 5, 555692735661, "677265656ec40152cfbbdc3dcd830fef4ffe8fe109a9926acba8d447b915bed2"],
    ["blue", 1, 445, "6203b5295fb26eab10ce26b9b2369a8333e73f9faa1a76278bc0156d7f515e72"],
    ["blue", 2, 54632, "626c771143625544b17c7b1ca56000a794f4d77a422862a17d943489299f0aba"],
    ["blue", 3, 35568231, "626c758ba39165163491ed785d305509426a860809e6a1d263d09d18324e0959"],
    ["blue", 4, 1906277479, "626c7565d2234f97ce211af59b637e430fc40f6f45108e51343eb1389b8d9ce2"],
    ["purple", 1, 55, "70d29cfc01bef971ffa17a01ce32e33767753ea68fb87905b8c1cf12fd009c1a"],
    ["purple", 2, 28728, "7075ed54b35343e5667110323a96d6b6b64a4d7bfb989056a821e6453332f6f4"],
    ["purple", 3, 5495738, "707572dde5f95476e53d217ff413db1d7757c56a2da5a38f56a26db0c6518fb2"],
    ["purple", 4, 5140152571, "70757270a568952b21263f4847506e26cf7369cf430db99517744d22268ad08d"],
    ["purple", 5, 1665338430691, "707572706cc1eb243d7babb48e466306ff09e364679c7c8f3ff81795135c3408"],
    ["purple", 6, 380630440663088, "707572706c65daf5d433b948159299e7a13c7a2a1c2eb1c093d4e6ee8ca7c2ed"],
    ["red", 1, 11, "7285787e00c6aa1fb2213805805d30544000f64d0cd8cb982f6cbcc542ab35f7"],
    ["red", 2, 87209, "7265aa69f71f03dfca72f0615c417a767d99b4936ad2965fb10a1d131bf54d9c"],
    ["red", 3, 98739526, "72656454743c0e93af1c541238f4fcf98893890bcde4d162cc83378a11eaf505"],
  ];

  const ascii8hex = s => [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const words = [...new Set(rows.map(r => r[0]))];

  grinding.series = {
    name: "Colour",
    slug: "colour",
    base: "red",
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
