// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC2981Upgradeable} from "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Grinding
/// @author Rhea Myers
/// @notice The twelve Grinding tokens. Each token is one display of the
///         proof-of-work text searches, rendered by the web app in `app/`.
///         The token's owner may store the display configuration on chain —
///         the same vocabulary as the page's Config panel — and anyone may
///         read it back, either as a struct or as the query string the page
///         accepts (e.g. `?layout=rosette&scheme=video`).
///
///         The contract admin (the `Ownable` owner) sets the base metadata
///         URI and the collection (contract) URI. Both work with IPFS: set
///         the base URI to `ipfs://<cid>/` and `tokenURI(n)` resolves to
///         `ipfs://<cid>/<n>`. Metadata changes are announced with ERC-4906
///         events so marketplaces such as OpenSea refresh their caches, and
///         the collection metadata is exposed via ERC-7572 `contractURI()`.
///         The admin also sets the collection-wide ERC-2981 royalty, which
///         marketplaces (and the Royalty Registry) read to pay resale royalties.
///
///         Upgradeable via UUPS: the admin may upgrade the implementation.
contract Grinding is ERC721Upgradeable, ERC2981Upgradeable, OwnableUpgradeable, UUPSUpgradeable, IERC4906 {
    using Strings for uint256;

    /// @notice Fixed edition size. All tokens are minted at initialization;
    ///         there is no way to mint more.
    uint256 public constant TOKEN_COUNT = 12;

    /// @notice Display configuration for one token, mirroring the web page's
    ///         Config panel. String fields hold the page's option slugs
    ///         (layout: plate|rings|hexRing|honeycomb|radial|rosette|spiral|gutter,
    ///         encoding: rgb12|grey4|duo8, display: squares|circles|hex|ascii,
    ///         sizing: fit|shrink|fill|overlap, scheme: paper|night|video|inverse).
    ///         An empty string means "leave that option at the page default".
    ///         Values are not validated on chain — the page's vocabulary can
    ///         grow without a contract upgrade, and the page ignores values it
    ///         does not recognise.
    struct TokenConfig {
        string layout;
        string encoding;
        string display;
        string sizing;
        string scheme;
        uint32 drawSeconds; // page default 120; 0 freezes on the final state
        uint32 pauseSeconds; // page default 60; 0 runs the cycle once
        uint32 rowPauseSeconds; // page default 2
        bool set; // true once the owner has stored a config; lets an explicit
            // zero timing be told apart from "never configured"
    }

    /// @custom:storage-location erc7201:grinding.storage.Grinding
    struct GrindingStorage {
        string baseTokenURI;
        string contractURI;
        mapping(uint256 tokenId => TokenConfig) configs;
    }

    // keccak256(abi.encode(uint256(keccak256("grinding.storage.Grinding")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x7c8354c0ad19a14d136b9472b4943cc519bdf24d235ae85eb89a9db206c11800;

    function _storage() private pure returns (GrindingStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /// @notice A token owner stored a new display configuration.
    event TokenConfigured(uint256 indexed tokenId, TokenConfig config);
    /// @notice A token owner cleared the stored configuration; the page falls
    ///         back to its defaults.
    event TokenConfigCleared(uint256 indexed tokenId);
    /// @notice ERC-7572: the collection metadata changed.
    event ContractURIUpdated();
    /// @notice The admin set (or, with a zero receiver and fee, removed) the
    ///         collection-wide ERC-2981 royalty.
    event DefaultRoyaltySet(address indexed receiver, uint96 feeBasisPoints);

    /// @notice `msg.sender` does not own the token it tried to configure.
    error NotTokenOwner(uint256 tokenId, address sender);

    constructor() {
        _disableInitializers();
    }

    /// @param admin Receives the twelve tokens, administers the metadata
    ///        URIs, and authorizes upgrades.
    /// @param baseTokenURI Prefix for `tokenURI`, e.g. `ipfs://<cid>/`.
    /// @param contractURI_ Collection metadata, e.g. `ipfs://<cid>`.
    function initialize(address admin, string calldata baseTokenURI, string calldata contractURI_)
        public
        initializer
    {
        __ERC721_init("Grinding", "GRIND");
        __Ownable_init(admin);
        GrindingStorage storage $ = _storage();
        $.baseTokenURI = baseTokenURI;
        $.contractURI = contractURI_;
        for (uint256 id = 1; id <= TOKEN_COUNT; id++) {
            _mint(admin, id);
        }
    }

    // ---- metadata (admin) ---------------------------------------------------

    /// @notice Set the prefix that `tokenURI` appends the token id to. For
    ///         IPFS use `ipfs://<cid>/` (note the trailing slash). Emits the
    ///         ERC-4906 batch event so marketplaces re-fetch all metadata.
    function setBaseURI(string calldata baseTokenURI) external onlyOwner {
        _storage().baseTokenURI = baseTokenURI;
        emit BatchMetadataUpdate(1, TOKEN_COUNT);
    }

    /// @notice ERC-7572 collection metadata URI, read by OpenSea for the
    ///         collection name, description, and image.
    function contractURI() external view returns (string memory) {
        return _storage().contractURI;
    }

    function setContractURI(string calldata contractURI_) external onlyOwner {
        _storage().contractURI = contractURI_;
        emit ContractURIUpdated();
    }

    function _baseURI() internal view override returns (string memory) {
        return _storage().baseTokenURI;
    }

    // ---- royalties (admin) --------------------------------------------------

    /// @notice Set the ERC-2981 royalty every token reports: `feeBasisPoints`
    ///         of the sale price (out of 10,000, so 1000 is 10%) to `receiver`.
    ///         Read by OpenSea, the SuperRare Bazaar (via the Royalty Registry),
    ///         and any other marketplace that honours the standard. Reverts on
    ///         a zero receiver or a fee above 100%.
    function setDefaultRoyalty(address receiver, uint96 feeBasisPoints) external onlyOwner {
        _setDefaultRoyalty(receiver, feeBasisPoints);
        emit DefaultRoyaltySet(receiver, feeBasisPoints);
    }

    /// @notice Remove the royalty: `royaltyInfo` returns the zero address and 0.
    function deleteDefaultRoyalty() external onlyOwner {
        _deleteDefaultRoyalty();
        emit DefaultRoyaltySet(address(0), 0);
    }

    // ---- per-token configuration -------------------------------------------

    /// @notice Store the display configuration for a token. Only the token's
    ///         current owner may call; `config.set` is forced true. Emits
    ///         ERC-4906 `MetadataUpdate` so renderers refresh the token.
    function setTokenConfig(uint256 tokenId, TokenConfig memory config) external {
        _requireTokenOwner(tokenId);
        config.set = true;
        _storage().configs[tokenId] = config;
        emit TokenConfigured(tokenId, config);
        emit MetadataUpdate(tokenId);
    }

    /// @notice Remove the stored configuration, returning the token's display
    ///         to the page defaults. Only the token's current owner may call.
    function clearTokenConfig(uint256 tokenId) external {
        _requireTokenOwner(tokenId);
        delete _storage().configs[tokenId];
        emit TokenConfigCleared(tokenId);
        emit MetadataUpdate(tokenId);
    }

    /// @notice The stored configuration for a token. `config.set` is false
    ///         (and every field empty/zero) when the owner has not stored one.
    function tokenConfig(uint256 tokenId) external view returns (TokenConfig memory) {
        _requireOwned(tokenId);
        return _storage().configs[tokenId];
    }

    /// @notice The stored configuration as the query string the web page
    ///         accepts, e.g. `?layout=rosette&scheme=video&duration=20&pause=0&rowpause=2`.
    ///         Empty string fields are omitted; the timing parameters are
    ///         included whenever a config has been stored (an explicit 0 is
    ///         meaningful to the page). Returns "" when nothing is stored.
    function configQuery(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        TokenConfig storage c = _storage().configs[tokenId];
        if (!c.set) return "";
        string memory q = "";
        q = _param(q, "layout", c.layout);
        q = _param(q, "encoding", c.encoding);
        q = _param(q, "display", c.display);
        q = _param(q, "size", c.sizing);
        q = _param(q, "scheme", c.scheme);
        q = _param(q, "duration", uint256(c.drawSeconds).toString());
        q = _param(q, "pause", uint256(c.pauseSeconds).toString());
        q = _param(q, "rowpause", uint256(c.rowPauseSeconds).toString());
        return q;
    }

    /// Append `key=value` to the query under construction, skipping empty
    /// values and choosing `?` or `&` by whether anything is there yet.
    function _param(string memory q, string memory key, string memory value)
        private
        pure
        returns (string memory)
    {
        if (bytes(value).length == 0) return q;
        return string.concat(q, bytes(q).length == 0 ? "?" : "&", key, "=", value);
    }

    function _requireTokenOwner(uint256 tokenId) private view {
        if (_requireOwned(tokenId) != msg.sender) revert NotTokenOwner(tokenId, msg.sender);
    }

    // ---- upgrades & interfaces ----------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev 0x49064906 is the ERC-4906 interface id, per the EIP. ERC-721 and
    ///      ERC-2981 answer for themselves up the inheritance chain.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, ERC2981Upgradeable, IERC165)
        returns (bool)
    {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId);
    }
}
