# Grinding — token contract

An upgradeable ERC-721 for the twelve *Grinding* tokens. Each token is one
display of the proof-of-work text searches rendered by the web app in `../app/`.

## Design

- **Fixed edition.** `initialize` mints tokens 1–12 to the admin; there is no
  further minting.
- **Upgradeable.** UUPS (ERC-1967 proxy); only the admin (`Ownable` owner) can
  upgrade. Contract storage is ERC-7201 namespaced (`grinding.storage.Grinding`).
- **Owner-set display configuration.** The token's owner stores the web page's
  Config panel settings on chain with `setTokenConfig` (and `clearTokenConfig`
  to return to page defaults). Anyone can read them back: `tokenConfig(id)`
  returns the struct, `configQuery(id)` returns the query string the page
  accepts, e.g. `?layout=rosette&scheme=video&duration=20&pause=0&rowpause=2`.
  Values are deliberately not validated on chain, so the page's vocabulary can
  grow without an upgrade; the page ignores values it does not recognise.
- **Admin-set metadata, IPFS-ready.** `setBaseURI("ipfs://<cid>/")` makes
  `tokenURI(n)` resolve to `ipfs://<cid>/<n>`. `setContractURI` sets the
  ERC-7572 collection metadata OpenSea reads.
- **Admin-set royalty (ERC-2981).** `setDefaultRoyalty(receiver, bps)` makes
  every token's `royaltyInfo` report `bps`/10,000 of the sale price to
  `receiver` (`deleteDefaultRoyalty` removes it). OpenSea reads this directly;
  the SuperRare Bazaar reads it through Manifold's Royalty Registry engine,
  which resolves ERC-2981 with no registration needed.
- **Marketplace freshness.** Base-URI and config changes emit ERC-4906
  `MetadataUpdate` / `BatchMetadataUpdate` events (and `supportsInterface`
  advertises `0x49064906`), so OpenSea re-fetches metadata after changes.

## Use

```sh
forge test

# deploy implementation + proxy (ADMIN defaults to the sender; URIs to "")
ADMIN=0x... BASE_URI="ipfs://<cid>/" CONTRACT_URI="ipfs://<cid>" \
forge script script/Grinding.s.sol:Deploy --rpc-url $RPC --broadcast

# upgrade an existing proxy (sender must be the admin)
PROXY=0x... forge script script/Grinding.s.sol:Upgrade --rpc-url $RPC --broadcast

# the royalties upgrade: new implementation and setDefaultRoyalty in one
# transaction (ROYALTY_BPS defaults to 1000 = 10%, ROYALTY_RECEIVER to the admin)
PROXY=0x... forge script script/Grinding.s.sol:UpgradeRoyalties --rpc-url $RPC --broadcast

# rehearse that upgrade against the live proxy on a mainnet fork first
MAINNET_RPC_URL=$RPC forge test --match-contract Mainnet -vv
```

`Deploy` also sets the royalty on a fresh proxy when the sender is the admin.

## Marketplaces

The contract needs nothing marketplace-specific on chain. Listing is a
per-wallet ERC-721 `setApprovalForAll` of the marketplace's operator contract,
covering every token that wallet holds:

| marketplace | operator | address |
| --- | --- | --- |
| OpenSea | Seaport conduit | `0x1E0049783F008A0085193E00003D00cd54003c71` |
| SuperRare | Bazaar | `0x6D7c44773C52D396F43c2D511B81aa168E9a7a42` |

```sh
# approve (or, with APPROVED=false, revoke) an operator for the sender's tokens
PROXY=0x... OPERATOR=superrare forge script script/Grinding.s.sol:ApproveOperator --rpc-url $RPC --broadcast
PROXY=0x... OPERATOR=opensea   forge script script/Grinding.s.sol:ApproveOperator --rpc-url $RPC --broadcast
```

Both marketplaces read the ERC-2981 royalty: OpenSea directly, SuperRare's
Bazaar through Manifold's Royalty Registry engine. SuperRare's site indexes
external contracts only on request from an onboarded creator (its self-service
import covers Transient Labs and Manifold contracts), so ask their support to
index the proxy.

## Etherscan verification

Easiest is at deploy time: add `--verify` (with `ETHERSCAN_API_KEY` set) to the
deploy command above. For manual or post-hoc verification,
`./verify-bundle.sh [chainid]` builds `verify/` with Standard-JSON-Input files
(exact match) and flattened sources (partial match) for both the
implementation and the ERC-1967 proxy, the proxy's constructor arguments
extracted from the broadcast, and a README with the pinned compiler settings
and ready-made `forge verify-contract` commands. Once both are verified, use
"Is this a proxy?" on the proxy's Etherscan page to enable Read/Write as
Proxy.

Dependencies are git submodules of the enclosing repository — the standard
forge arrangement: only `.gitmodules` and pinned commit pointers are
committed, never the library content. `lib/forge-std` v1.16.2,
`lib/openzeppelin-contracts` and `lib/openzeppelin-contracts-upgradeable`
v5.7.0. A fresh clone restores them with
`git submodule update --init --recursive`.
