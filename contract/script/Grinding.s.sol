// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Grinding} from "../src/Grinding.sol";

/// Royalty settings shared by the scripts: ROYALTY_BPS basis points of each
/// sale (default 1000 = 10%, the SuperRare convention) to ROYALTY_RECEIVER
/// (default: the contract admin).
abstract contract RoyaltyEnv is Script {
    function royaltyReceiver(address fallbackReceiver) internal view returns (address) {
        return vm.envOr("ROYALTY_RECEIVER", fallbackReceiver);
    }

    function royaltyBps() internal view returns (uint96) {
        return uint96(vm.envOr("ROYALTY_BPS", uint256(1000)));
    }
}

/// Deploy the implementation and a UUPS (ERC-1967) proxy pointing at it.
///
///   ADMIN=0x... BASE_URI="ipfs://<cid>/" CONTRACT_URI="ipfs://<cid>" \
///   forge script script/Grinding.s.sol:Deploy --rpc-url $RPC --broadcast
///
/// ADMIN defaults to the broadcasting sender; the URIs default to empty and
/// can be set later with setBaseURI / setContractURI. The royalty is set in
/// the same run when the sender is the admin (only the admin may set it);
/// otherwise the admin sets it afterwards with setDefaultRoyalty.
contract Deploy is RoyaltyEnv {
    function run() external returns (Grinding proxy) {
        address admin = vm.envOr("ADMIN", msg.sender);
        string memory baseURI = vm.envOr("BASE_URI", string(""));
        string memory contractURI = vm.envOr("CONTRACT_URI", string(""));

        vm.startBroadcast();
        Grinding implementation = new Grinding();
        proxy = Grinding(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(Grinding.initialize, (admin, baseURI, contractURI))
                )
            )
        );
        if (admin == msg.sender) {
            proxy.setDefaultRoyalty(royaltyReceiver(admin), royaltyBps());
        } else {
            console.log("admin is not the sender: call setDefaultRoyalty as the admin");
        }
        vm.stopBroadcast();

        console.log("implementation", address(implementation));
        console.log("proxy         ", address(proxy));
    }
}

/// Upgrade an existing proxy to a freshly deployed implementation. The
/// broadcasting sender must be the contract admin.
///
///   PROXY=0x... forge script script/Grinding.s.sol:Upgrade --rpc-url $RPC --broadcast
contract Upgrade is Script {
    function run() external {
        Grinding proxy = Grinding(vm.envAddress("PROXY"));

        vm.startBroadcast();
        Grinding implementation = new Grinding();
        proxy.upgradeToAndCall(address(implementation), "");
        vm.stopBroadcast();

        console.log("new implementation", address(implementation));
    }
}

/// Approve a marketplace as operator for every Grinding token the sender
/// holds — the ERC-721 `setApprovalForAll` a marketplace needs before it can
/// list or sell them. OPERATOR is `opensea` (the Seaport conduit), `superrare`
/// (the Bazaar), or any address; APPROVED=false revokes.
///
///   PROXY=0x... OPERATOR=superrare \
///   forge script script/Grinding.s.sol:ApproveOperator --rpc-url $RPC --broadcast
contract ApproveOperator is Script {
    address constant OPENSEA_CONDUIT = 0x1E0049783F008A0085193E00003D00cd54003c71;
    address constant SUPERRARE_BAZAAR = 0x6D7c44773C52D396F43c2D511B81aa168E9a7a42;

    function operator() internal view returns (address) {
        string memory name = vm.envString("OPERATOR");
        bytes32 key = keccak256(bytes(name));
        if (key == keccak256("opensea")) return OPENSEA_CONDUIT;
        if (key == keccak256("superrare")) return SUPERRARE_BAZAAR;
        return vm.parseAddress(name);
    }

    function run() external {
        Grinding proxy = Grinding(vm.envAddress("PROXY"));
        address op = operator();
        bool approved = vm.envOr("APPROVED", true);

        vm.startBroadcast();
        proxy.setApprovalForAll(op, approved);
        vm.stopBroadcast();

        console.log("operator", op);
        console.log("approved for", msg.sender, proxy.isApprovedForAll(msg.sender, op));
    }
}

/// The royalties upgrade: move a proxy deployed before ERC-2981 support to the
/// current implementation and set the collection royalty in the same
/// transaction, so the new code never runs with royalties unset. The
/// broadcasting sender must be the contract admin.
///
///   PROXY=0x... [ROYALTY_RECEIVER=0x... ROYALTY_BPS=1000] \
///   forge script script/Grinding.s.sol:UpgradeRoyalties --rpc-url $RPC --broadcast
contract UpgradeRoyalties is RoyaltyEnv {
    function run() external {
        Grinding proxy = Grinding(vm.envAddress("PROXY"));
        address receiver = royaltyReceiver(proxy.owner());
        uint96 bps = royaltyBps();

        vm.startBroadcast();
        Grinding implementation = new Grinding();
        proxy.upgradeToAndCall(
            address(implementation), abi.encodeCall(Grinding.setDefaultRoyalty, (receiver, bps))
        );
        vm.stopBroadcast();

        (address got, uint256 amount) = proxy.royaltyInfo(1, 10_000);
        console.log("new implementation", address(implementation));
        console.log("royalty receiver  ", got);
        console.log("royalty bps       ", amount);
    }
}
