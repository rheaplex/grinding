// Chain package — the optional Ethereum side of a page. If the viewer has an
// Ethereum plugin (window.ethereum) and chain-config.js names the contract,
// the page can read this token's stored display configuration from the
// Grinding contract, and its owner can write the current configuration back.
// Reads use configQuery(tokenId), which returns exactly the query string the
// page already parses; writes call setTokenConfig(tokenId, config), which
// the contract restricts to the token's current owner. Everything is plain
// eth_call / eth_sendTransaction — no wallet library.
(function () {
  const grinding = window.grinding = window.grinding || {};

  // selectors, verified against the compiled contract (forge inspect)
  const SEL = {
    configQuery: "0x156d1198",     // configQuery(uint256)
    ownerOf: "0x6352211e",         // ownerOf(uint256)
    setTokenConfig: "0x48e36746"   // setTokenConfig(uint256,(string x5,uint32 x3,bool))
  };

  // ---- minimal ABI encoding -----------------------------------------------

  const pad = h => h.padStart(64, "0");
  const uint = n => pad(BigInt(n).toString(16));
  const utf8hex = s => [...new TextEncoder().encode(s)]
    .map(b => b.toString(16).padStart(2, "0")).join("");

  // a dynamic tuple of 5 strings, 3 uint32s, and a bool: heads then tails
  function encodeConfig(v) {
    const strings = [v.layout, v.encoding, v.display, v.sizing, v.scheme];
    const heads = [], tails = [];
    let tail = 9 * 32; // offsets are from the tuple's own start
    for (const s of strings) {
      heads.push(uint(tail));
      const hex = utf8hex(s || "");
      const words = uint(hex.length / 2) +
        (hex ? hex.padEnd(Math.ceil(hex.length / 64) * 64, "0") : "");
      tails.push(words);
      tail += words.length / 2;
    }
    heads.push(uint(v.drawSeconds), uint(v.pauseSeconds), uint(v.rowPauseSeconds), uint(1));
    return heads.join("") + tails.join("");
  }

  const writeCalldata = (tokenId, v) =>
    SEL.setTokenConfig + uint(tokenId) + uint(0x40) + encodeConfig(v);

  // decode one returned string (offset word, length word, bytes)
  function decodeString(hex) {
    const data = hex.replace(/^0x/, "");
    const len = parseInt(data.slice(64, 128), 16);
    const bytes = data.slice(128, 128 + len * 2);
    let out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder().decode(out);
  }

  // ---- the calls -----------------------------------------------------------

  const eth = () => window.ethereum;
  const cfg = () => grinding.chainConfig || {};
  const tokenId = () => grinding.series && grinding.series.tokenId;

  const enabled = () => !!(eth() && cfg().address && tokenId());

  const call = data => eth().request({
    method: "eth_call",
    params: [{ to: cfg().address, data }, "latest"]
  });

  // the stored config as the page's own query string ("" when none is set)
  async function read() {
    return decodeString(await call(SEL.configQuery + uint(tokenId())));
  }

  async function ownerOf() {
    const ret = await call(SEL.ownerOf + uint(tokenId()));
    return "0x" + ret.replace(/^0x/, "").slice(24, 64);
  }

  // prompt the wallet for an account. On the wrong network, ask the wallet
  // to switch — and to add the network first (from chain-config's rpcUrl)
  // if it does not know it — rather than writing to a lookalike contract
  // elsewhere; if the viewer declines, this rejects.
  async function connect() {
    if (cfg().chainId != null) {
      const want = cfg().chainId;
      const chain = parseInt(await eth().request({ method: "eth_chainId" }), 16);
      if (chain !== want) {
        const hexId = "0x" + want.toString(16);
        try {
          await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
        } catch (e) {
          if (e && e.code === 4902 && cfg().rpcUrl) {
            // the wallet has never heard of this chain: offer to add it
            await eth().request({
              method: "wallet_addEthereumChain",
              params: [{
                chainId: hexId,
                chainName: cfg().chainName || "chain " + want,
                rpcUrls: [cfg().rpcUrl],
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }
              }]
            });
            await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
          } else {
            throw new Error("wallet is on chain " + chain + ", the contract is on " + want);
          }
        }
      }
    }
    const accounts = await eth().request({ method: "eth_requestAccounts" });
    return accounts[0];
  }

  // owner-only: setTokenConfig(tokenId, values); resolves to the tx hash
  async function write(from, values) {
    return eth().request({
      method: "eth_sendTransaction",
      params: [{ from, to: cfg().address, data: writeCalldata(tokenId(), values) }]
    });
  }

  grinding.chain = {
    enabled, read, ownerOf, connect, write, tokenId,
    _abi: { encodeConfig, writeCalldata, decodeString } // exposed for tests
  };
})();
