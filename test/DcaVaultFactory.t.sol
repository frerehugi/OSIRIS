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

    address squidRouter  = makeAddr("squidRouter");
    address globalKeeper = makeAddr("globalKeeper");
    address admin        = makeAddr("admin");
    address alice        = makeAddr("alice");
    address bob          = makeAddr("bob");

    event VaultCreated(address indexed owner, address indexed vault);
    event FeeUpdated(uint16 feeBps, uint256 minFee);
    event AdminUpdated(address indexed admin);

    function setUp() public {
        vaultImplementation = new DcaVault();
        factory = new DcaVaultFactory(address(vaultImplementation), squidRouter, globalKeeper, admin);
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

    function test_createVault_globalKeeperAutoAuthorized() public {
        vm.prank(alice);
        address vault = factory.createVault();

        assertTrue(DcaVault(vault).isKeeper(globalKeeper));
    }

    function test_constructor_revertsOnZeroVaultImplementation() public {
        vm.expectRevert(DcaVaultFactory.InvalidAddress.selector);
        new DcaVaultFactory(address(0), squidRouter, globalKeeper, admin);
    }

    function test_constructor_revertsOnZeroSquidRouter() public {
        vm.expectRevert(DcaVaultFactory.InvalidAddress.selector);
        new DcaVaultFactory(address(vaultImplementation), address(0), globalKeeper, admin);
    }

    function test_constructor_revertsOnZeroGlobalKeeper() public {
        vm.expectRevert(DcaVaultFactory.InvalidAddress.selector);
        new DcaVaultFactory(address(vaultImplementation), squidRouter, address(0), admin);
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(DcaVaultFactory.InvalidAddress.selector);
        new DcaVaultFactory(address(vaultImplementation), squidRouter, globalKeeper, address(0));
    }

    function test_constructor_setsDefaultFee() public view {
        assertEq(factory.feeBps(), 99);
        assertEq(factory.minFee(), 20_000);
        assertEq(factory.admin(), admin);
    }

    // ─── setFee Tests ────────────────────────────────────────────────────────

    function test_setFee_success() public {
        vm.prank(admin);
        factory.setFee(100, 30_000);

        assertEq(factory.feeBps(), 100);
        assertEq(factory.minFee(), 30_000);
    }

    function test_setFee_emitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit FeeUpdated(100, 30_000);

        vm.prank(admin);
        factory.setFee(100, 30_000);
    }

    function test_setFee_revertsIfNotAdmin() public {
        vm.prank(alice);
        vm.expectRevert(DcaVaultFactory.NotAdmin.selector);
        factory.setFee(100, 30_000);
    }

    function test_setFee_revertsIfExceedsCap() public {
        vm.prank(admin);
        vm.expectRevert(DcaVaultFactory.FeeTooHigh.selector);
        factory.setFee(501, 30_000);
    }

    function test_setFee_allowsExactCap() public {
        vm.prank(admin);
        factory.setFee(500, 30_000);
        assertEq(factory.feeBps(), 500);
    }

    // ─── setAdmin Tests ──────────────────────────────────────────────────────

    function test_setAdmin_success() public {
        vm.prank(admin);
        factory.setAdmin(bob);
        assertEq(factory.admin(), bob);
    }

    function test_setAdmin_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit AdminUpdated(bob);

        vm.prank(admin);
        factory.setAdmin(bob);
    }

    function test_setAdmin_revertsIfNotAdmin() public {
        vm.prank(alice);
        vm.expectRevert(DcaVaultFactory.NotAdmin.selector);
        factory.setAdmin(bob);
    }

    function test_setAdmin_revertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(DcaVaultFactory.InvalidAddress.selector);
        factory.setAdmin(address(0));
    }

    // ─── feeInfo Tests ───────────────────────────────────────────────────────

    function test_feeInfo_returnsCorrectValues() public view {
        (uint16 feeBps, uint256 minFee, address treasury) = factory.feeInfo();
        assertEq(feeBps, 99);
        assertEq(minFee, 20_000);
        assertEq(treasury, globalKeeper);
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
