// The pages' Ethereum side: chain.js runs against a stubbed window and a
// fake provider, and its hand-rolled ABI encoding is checked byte-for-byte
// against calldata produced by Foundry's cast.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "..", "app");

function loadChain({ ethereum, address = "0xc0ffee254729296a45a3885639AC7E10F9d54979", tokenId = 3 } = {}) {
  const window = { ethereum };
  for (const f of ["js/chain-config.js", "js/chain.js"]) {
    new Function("window", fs.readFileSync(path.join(APP, f), "utf8"))(window);
  }
  window.grinding.chainConfig.address = address;
  window.grinding.chainConfig.chainId = 31337;
  window.grinding.chainConfig.chainName = "Anvil (local)";
  window.grinding.chainConfig.rpcUrl = "http://127.0.0.1:8545";
  window.grinding.series = { tokenId };
  return window.grinding.chain;
}

// cast calldata "setTokenConfig(uint256,(string,string,string,string,string,uint32,uint32,uint32,bool))" ...
const CAST_FULL = "0x48e36746" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "0000000000000000000000000000000000000000000000000000000000000040" +
  "0000000000000000000000000000000000000000000000000000000000000120" +
  "0000000000000000000000000000000000000000000000000000000000000160" +
  "00000000000000000000000000000000000000000000000000000000000001a0" +
  "00000000000000000000000000000000000000000000000000000000000001e0" +
  "0000000000000000000000000000000000000000000000000000000000000220" +
  "0000000000000000000000000000000000000000000000000000000000000014" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000007" +
  "726f736574746500000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000005" +
  "6772657934000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000007" +
  "636972636c657300000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000006" +
  "736872696e6b0000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000005" +
  "766964656f000000000000000000000000000000000000000000000000000000";
const CAST_EMPTY = "0x48e36746" +
  "000000000000000000000000000000000000000000000000000000000000000c" +
  "0000000000000000000000000000000000000000000000000000000000000040" +
  "0000000000000000000000000000000000000000000000000000000000000120" +
  "0000000000000000000000000000000000000000000000000000000000000140" +
  "0000000000000000000000000000000000000000000000000000000000000160" +
  "0000000000000000000000000000000000000000000000000000000000000180" +
  "00000000000000000000000000000000000000000000000000000000000001a0" +
  "0000000000000000000000000000000000000000000000000000000000000078" +
  "000000000000000000000000000000000000000000000000000000000000003c" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000";

test("setTokenConfig calldata matches cast byte for byte", () => {
  const chain = loadChain();
  assert.equal(
    chain._abi.writeCalldata(3, {
      layout: "rosette", encoding: "grey4", display: "circles",
      sizing: "shrink", scheme: "video",
      drawSeconds: 20, pauseSeconds: 0, rowPauseSeconds: 2,
    }),
    CAST_FULL
  );
  assert.equal(
    chain._abi.writeCalldata(12, {
      layout: "", encoding: "", display: "", sizing: "", scheme: "",
      drawSeconds: 120, pauseSeconds: 60, rowPauseSeconds: 2,
    }),
    CAST_EMPTY
  );
});

test("read decodes configQuery's returned string", async () => {
  const query = "?layout=rosette&scheme=video&duration=20&pause=0&rowpause=2";
  const hex = [...Buffer.from(query, "utf8")].map(b => b.toString(16).padStart(2, "0")).join("");
  const requests = [];
  const ethereum = {
    request: async r => {
      requests.push(r);
      return "0x" +
        "20".padStart(64, "0") +
        query.length.toString(16).padStart(64, "0") +
        hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
    },
  };
  const chain = loadChain({ ethereum });
  assert.equal(await chain.read(), query);
  assert.equal(requests[0].method, "eth_call");
  assert.equal(requests[0].params[0].data, "0x156d1198" + "3".padStart(64, "0"));
});

test("write sends the owner's transaction to the contract", async () => {
  const sent = [];
  const ethereum = {
    request: async r => {
      if (r.method === "eth_sendTransaction") { sent.push(r.params[0]); return "0xtxhash"; }
      throw new Error("unexpected " + r.method);
    },
  };
  const chain = loadChain({ ethereum });
  const tx = await chain.write("0xowner", {
    layout: "rosette", encoding: "grey4", display: "circles",
    sizing: "shrink", scheme: "video",
    drawSeconds: 20, pauseSeconds: 0, rowPauseSeconds: 2,
  });
  assert.equal(tx, "0xtxhash");
  assert.equal(sent[0].from, "0xowner");
  assert.equal(sent[0].to, "0xc0ffee254729296a45a3885639AC7E10F9d54979");
  assert.equal(sent[0].data, CAST_FULL);
});

test("connect offers to add and switch to the contract's network", async () => {
  const calls = [];
  let added = false;
  const ethereum = {
    request: async r => {
      calls.push(r.method);
      switch (r.method) {
        case "eth_chainId": return "0x1"; // wallet starts on mainnet
        case "wallet_switchEthereumChain":
          if (!added) { const e = new Error("unknown chain"); e.code = 4902; throw e; }
          return null;
        case "wallet_addEthereumChain": added = true; return null;
        case "eth_requestAccounts": return ["0xowner"];
        default: throw new Error("unexpected " + r.method);
      }
    },
  };
  const chain = loadChain({ ethereum });
  assert.equal(await chain.connect(), "0xowner");
  assert.deepEqual(calls, [
    "eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain",
    "wallet_switchEthereumChain", "eth_requestAccounts",
  ]);
});

test("connect rejects if the viewer declines the switch", async () => {
  const ethereum = {
    request: async r => {
      if (r.method === "eth_chainId") return "0x1";
      if (r.method === "wallet_switchEthereumChain") { const e = new Error("denied"); e.code = 4001; throw e; }
      throw new Error("unexpected " + r.method);
    },
  };
  await assert.rejects(loadChain({ ethereum }).connect(), /wallet is on chain 1/);
});

test("stays dormant without a wallet, an address, or a token id", () => {
  assert.equal(loadChain({ ethereum: undefined }).enabled(), false);
  assert.equal(loadChain({ ethereum: {}, address: "" }).enabled(), false);
  // a series without a tokenId (e.g. the legacy form page) disables it too
  assert.equal(loadChain({ ethereum: {}, tokenId: null }).enabled(), false);
  assert.equal(loadChain({ ethereum: {} }).enabled(), true);
});
