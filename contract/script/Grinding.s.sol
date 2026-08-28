// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Grinding} from "../src/Grinding.sol";

/// Deploy the implementation and a UUPS (ERC-1967) proxy pointing at it.
///
///   ADMIN=0x... BASE_URI="ipfs://<cid>/" CONTRACT_URI="ipfs://<cid>" \
///   forge script script/Grinding.s.sol:Deploy --rpc-url $RPC --broadcast
///
/// ADMIN defaults to the broadcasting sender; the URIs default to empty and
/// can be set later with setBaseURI / setContractURI.
contract Deploy is Script {
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
