// Grinding contract connection. Fill in the proxy address after deployment;
// while it is empty the pages stay fully static and never touch a wallet.
(function () {
  const grinding = window.grinding = window.grinding || {};
  grinding.chainConfig = {
    address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", // local anvil rehearsal
    chainId: 31337,
    // used to offer adding the network to a wallet that lacks it
    chainName: "Anvil (local)",
    rpcUrl: "http://127.0.0.1:8545"
  };
})();
