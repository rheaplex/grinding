// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Grinding} from "../src/Grinding.sol";

/// A second implementation version, proving state survives an upgrade and the
/// upgraded code is actually the one running.
contract GrindingV2 is Grinding {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract GrindingTest is Test {
    Grinding token;
    address admin = makeAddr("admin");
    address collector = makeAddr("collector");
    address stranger = makeAddr("stranger");

    string constant BASE = "ipfs://bafybeibase/";
    string constant COLLECTION = "ipfs://bafybeicollection";

    function setUp() public {
        Grinding implementation = new Grinding();
        token = Grinding(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(Grinding.initialize, (admin, BASE, COLLECTION))
                )
            )
        );
    }

    function someConfig() internal pure returns (Grinding.TokenConfig memory) {
        return Grinding.TokenConfig({
            layout: "rosette",
            encoding: "grey4",
            display: "circles",
            sizing: "shrink",
            scheme: "video",
            drawSeconds: 20,
            pauseSeconds: 0,
            rowPauseSeconds: 2,
            set: false // the contract forces this true
        });
    }

    // ---- supply -------------------------------------------------------------

    function test_mints_exactly_twelve_to_admin() public {
        assertEq(token.TOKEN_COUNT(), 12);
        assertEq(token.balanceOf(admin), 12);
        for (uint256 id = 1; id <= 12; id++) {
            assertEq(token.ownerOf(id), admin);
        }
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 0));
        token.ownerOf(0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 13));
        token.ownerOf(13);
    }

    function test_cannot_initialize_twice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize(stranger, "", "");
    }

    function test_implementation_is_locked() public {
        Grinding implementation = new Grinding();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(stranger, "", "");
    }

    // ---- metadata -----------------------------------------------------------

    function test_token_uri_is_ipfs_base_plus_id() public view {
        assertEq(token.tokenURI(1), "ipfs://bafybeibase/1");
        assertEq(token.tokenURI(12), "ipfs://bafybeibase/12");
    }

    function test_admin_sets_base_uri_and_batch_event_fires() public {
        vm.expectEmit();
        emit IERC4906.BatchMetadataUpdate(1, 12);
        vm.prank(admin);
        token.setBaseURI("ipfs://bafybeinew/");
        assertEq(token.tokenURI(7), "ipfs://bafybeinew/7");
    }

    function test_non_admin_cannot_set_base_uri() public {
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        token.setBaseURI("ipfs://nope/");
    }

    function test_contract_uri_admin_only() public {
        assertEq(token.contractURI(), COLLECTION);

        vm.expectEmit();
        emit Grinding.ContractURIUpdated();
        vm.prank(admin);
        token.setContractURI("ipfs://bafybeiother");
        assertEq(token.contractURI(), "ipfs://bafybeiother");

        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        token.setContractURI("ipfs://nope");
    }

    function test_supports_erc4906_and_erc721() public view {
        assertTrue(token.supportsInterface(0x49064906)); // ERC-4906
        assertTrue(token.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(token.supportsInterface(0x5b5e139f)); // ERC-721 metadata
    }

    // ---- per-token configuration --------------------------------------------

    function test_token_owner_sets_config_and_anyone_reads_it() public {
        vm.prank(admin);
        token.transferFrom(admin, collector, 3);

        vm.expectEmit(true, false, false, false);
        emit Grinding.TokenConfigured(3, someConfig());
        vm.expectEmit();
        emit IERC4906.MetadataUpdate(3);
        vm.prank(collector);
        token.setTokenConfig(3, someConfig());

        vm.prank(stranger); // gettable publicly
        Grinding.TokenConfig memory got = token.tokenConfig(3);
        assertTrue(got.set);
        assertEq(got.layout, "rosette");
        assertEq(got.encoding, "grey4");
        assertEq(got.display, "circles");
        assertEq(got.sizing, "shrink");
        assertEq(got.scheme, "video");
        assertEq(got.drawSeconds, 20);
        assertEq(got.pauseSeconds, 0);
        assertEq(got.rowPauseSeconds, 2);
    }

    function test_only_current_owner_may_configure() public {
        vm.prank(admin);
        token.transferFrom(admin, collector, 3);

        // a stranger can't, and neither can the contract admin once transferred
        vm.expectRevert(abi.encodeWithSelector(Grinding.NotTokenOwner.selector, 3, stranger));
        vm.prank(stranger);
        token.setTokenConfig(3, someConfig());

        vm.expectRevert(abi.encodeWithSelector(Grinding.NotTokenOwner.selector, 3, admin));
        vm.prank(admin);
        token.setTokenConfig(3, someConfig());

        vm.expectRevert(abi.encodeWithSelector(Grinding.NotTokenOwner.selector, 3, stranger));
        vm.prank(stranger);
        token.clearTokenConfig(3);
    }

    function test_config_of_nonexistent_token_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 13));
        token.setTokenConfig(13, someConfig());
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 13));
        token.tokenConfig(13);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 13));
        token.configQuery(13);
    }

    function test_clear_config_returns_to_unset() public {
        vm.startPrank(admin);
        token.setTokenConfig(5, someConfig());
        assertTrue(token.tokenConfig(5).set);

        vm.expectEmit();
        emit Grinding.TokenConfigCleared(5);
        token.clearTokenConfig(5);
        vm.stopPrank();

        assertFalse(token.tokenConfig(5).set);
        assertEq(token.tokenConfig(5).layout, "");
        assertEq(token.configQuery(5), "");
    }

    function test_config_query_builds_page_query_string() public {
        assertEq(token.configQuery(1), ""); // nothing stored yet

        vm.prank(admin);
        token.setTokenConfig(1, someConfig());
        assertEq(
            token.configQuery(1),
            "?layout=rosette&encoding=grey4&display=circles&size=shrink&scheme=video&duration=20&pause=0&rowpause=2"
        );
    }

    function test_config_query_omits_empty_fields_keeps_timings() public {
        Grinding.TokenConfig memory sparse;
        sparse.scheme = "night";
        sparse.drawSeconds = 30;
        sparse.pauseSeconds = 7;
        sparse.rowPauseSeconds = 2;

        vm.prank(admin);
        token.setTokenConfig(2, sparse);
        assertEq(token.configQuery(2), "?scheme=night&duration=30&pause=7&rowpause=2");
    }

    // ---- erc-721 behaviour --------------------------------------------------
    // after is-art-editions' lib/testErc721.js (setup/transfers/urls) and the
    // koala-noosphere-onchain suite's interface and tokenURI checks

    function test_name_and_symbol() public view {
        assertEq(token.name(), "Grinding");
        assertEq(token.symbol(), "GRIND");
    }

    function test_transfers() public {
        vm.prank(admin);
        token.transferFrom(admin, collector, 1);
        assertEq(token.ownerOf(1), collector);
        assertEq(token.balanceOf(admin), 11);
        assertEq(token.balanceOf(collector), 1);

        vm.prank(collector);
        token.transferFrom(collector, admin, 1);
        assertEq(token.ownerOf(1), admin);
        assertEq(token.balanceOf(admin), 12);
    }

    function test_transfer_by_non_owner_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, stranger, 2)
        );
        vm.prank(stranger);
        token.transferFrom(admin, stranger, 2);
    }

    function test_approved_address_can_transfer() public {
        vm.prank(admin);
        token.approve(collector, 2);
        vm.prank(collector);
        token.transferFrom(admin, collector, 2);
        assertEq(token.ownerOf(2), collector);
    }

    function test_safe_transfer() public {
        vm.prank(admin);
        token.safeTransferFrom(admin, collector, 4);
        assertEq(token.ownerOf(4), collector);
    }

    function test_does_not_support_invalid_interface() public view {
        assertFalse(token.supportsInterface(0xffffffff));
    }

    function test_token_uri_reverts_for_nonexistent_token() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 13));
        token.tokenURI(13);
    }

    function test_empty_base_uri_gives_empty_token_uri() public {
        Grinding bare = Grinding(
            address(
                new ERC1967Proxy(
                    address(new Grinding()), abi.encodeCall(Grinding.initialize, (admin, "", ""))
                )
            )
        );
        assertEq(bare.tokenURI(1), "");
        assertEq(bare.contractURI(), "");
    }

    function test_config_persists_across_transfer_and_new_owner_can_overwrite() public {
        vm.prank(admin);
        token.setTokenConfig(6, someConfig());
        vm.prank(admin);
        token.transferFrom(admin, collector, 6);

        // the stored config travels with the token...
        assertEq(token.tokenConfig(6).layout, "rosette");

        // ...and control over it moved to the new owner
        Grinding.TokenConfig memory theirs;
        theirs.scheme = "paper";
        vm.prank(collector);
        token.setTokenConfig(6, theirs);
        assertEq(token.tokenConfig(6).scheme, "paper");
        assertEq(token.tokenConfig(6).layout, "");
    }

    // ---- upgrades -----------------------------------------------------------

    function test_admin_upgrades_and_state_survives() public {
        vm.prank(admin);
        token.transferFrom(admin, collector, 3);
        vm.prank(collector);
        token.setTokenConfig(3, someConfig());

        address v2 = address(new GrindingV2());
        vm.prank(admin);
        token.upgradeToAndCall(v2, "");

        assertEq(GrindingV2(address(token)).version(), 2);
        assertEq(token.ownerOf(3), collector);
        assertEq(token.tokenConfig(3).layout, "rosette");
        assertEq(token.tokenURI(3), "ipfs://bafybeibase/3");
        assertEq(token.contractURI(), COLLECTION);
    }

    function test_non_admin_cannot_upgrade() public {
        address v2 = address(new GrindingV2());
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        token.upgradeToAndCall(v2, "");
    }
}
