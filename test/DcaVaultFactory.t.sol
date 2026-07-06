// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {DcaVault} from "../contracts/DcaVault.sol";
import {DcaVaultFactory} from "../contracts/DcaVaultFactory.sol";

/// @notice Test-Suite für DcaVaultFactory.
///
/// Ausführen: forge test --match-contract DcaVaultFactoryTest -vvv

contract DcaVaultFactoryTest is Test {

    DcaVault        vaultImplementation;
    DcaVaultFactory factory;

    address squidRouter = makeAddr("squidRouter");
    address alice       = makeAddr("alice");
    address bob         = makeAddr("bob");

    event VaultCreated(address indexed owner, address indexed vault);

    function setUp() public {
        vaultImplementation = new DcaVault();
        factory = new DcaVaultFactory(address(vaultImplementation), squidRouter);
    }

    function test_createVault_success() public {
        vm.prank(alice);
        address vault = factory.createVault();

        assertTrue(vault != address(0));
        assertEq(factory.vaultCount(), 1);
        assertEq(factory.getAllVaults()[0], vault);
        assertEq(factory.getVaults(alice)[0], vault);
    }

    function test_createVault_multipleVaultsPerOwner() public {
        vm.startPrank(alice);
        address vault1 = factory.createVault();
        address vault2 = factory.createVault();
        vm.stopPrank();

        assertTrue(vault1 != vault2);

        address[] memory aliceVaults = factory.getVaults(alice);
        assertEq(aliceVaults.length, 2);
        assertEq(aliceVaults[0], vault1);
        assertEq(aliceVaults[1], vault2);
    }

    function test_createVault_squidRouterWhitelisted() public {
        vm.prank(alice);
        address vault = factory.createVault();

        assertTrue(DcaVault(vault).approvedRouters(squidRouter));
    }

    function test_createVault_ownerIsCorrect() public {
        vm.prank(alice);
        address vault = factory.createVault();

        assertEq(DcaVault(vault).owner(), alice);
    }

    function test_createVault_emitsEvent() public {
        // Die Vault-Adresse steht vor dem Call nicht fest (Clones.clone() ist
        // nicht deterministisch) — nur der indexed owner-Topic wird geprüft.
        vm.expectEmit(true, false, false, false);
        emit VaultCreated(alice, address(0));

        vm.prank(alice);
        factory.createVault();
    }

    function test_getAllVaults_returnsAll() public {
        vm.prank(alice);
        address vaultA = factory.createVault();
        vm.prank(bob);
        address vaultB = factory.createVault();

        address[] memory all = factory.getAllVaults();
        assertEq(all.length, 2);
        assertEq(all[0], vaultA);
        assertEq(all[1], vaultB);
        assertEq(factory.vaultCount(), 2);
    }
}
