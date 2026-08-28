// Grinding contract connection. Fill in the proxy address after deployment;
// while it is empty the pages stay fully static and never touch a wallet.
(function () {
  const grinding = window.grinding = window.grinding || {};
  grinding.chainConfig = {
    address: "0xf0f744E57FfC931105EA68b0830009E01631F3aC", // the Grinding proxy on mainnet
    chainId: 1,
    chainName: "Ethereum Mainnet",
    rpcUrl: "" // mainnet is known to every wallet; no add-network offer needed
  };
})();
