// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SendVault} from "../contracts/SendVault.sol";
import {SendVaultFactory} from "../contracts/SendVaultFactory.sol";

/// @notice Test-Suite für SendVaultFactory.
///
/// Ausführen: forge test --match-contract SendVaultFactoryTest -vvv

contract SendVaultFactoryTest is Test {

    SendVault        vaultImplementation;
    SendVaultFactory factory;

    address globalKeeper = makeAddr("globalKeeper");
    address admin        = makeAddr("admin");
    address alice        = makeAddr("alice");
    address bob          = makeAddr("bob");
    address usdc         = makeAddr("usdc"); // nur als Mapping-Key, kein echtes Token nötig hier
    address wbtc         = makeAddr("wbtc");

    event VaultCreated(address indexed owner, address indexed vault);
    event FeeUpdated(uint16 feeBps);
    event MinFeeUpdated(address indexed token, uint256 minFee);
    event AdminUpdated(address indexed admin);

    function setUp() public {
        vaultImplementation = new SendVault();
        factory = new SendVaultFactory(address(vaultImplementation), globalKeeper, admin);
    }

    // ─── createVault ─────────────────────────────────────────────────────────

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

    function test_createVault_ownerIsCorrect() public {
        vm.prank(alice);
        address vault = factory.createVault();
        assertEq(SendVault(vault).owner(), alice);
    }

    function test_createVault_globalKeeperAutoAuthorized() public {
        vm.prank(alice);
        address vault = factory.createVault();
        assertTrue(SendVault(vault).isKeeper(globalKeeper));
    }

    function test_createVault_emitsEvent() public {
        // Vault-Adresse steht vor dem Call nicht fest (Clones.clone() ist
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

    // ─── constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroVaultImplementation() public {
        vm.expectRevert(SendVaultFactory.InvalidAddress.selector);
        new SendVaultFactory(address(0), globalKeeper, admin);
    }

    function test_constructor_revertsOnZeroGlobalKeeper() public {
        vm.expectRevert(SendVaultFactory.InvalidAddress.selector);
        new SendVaultFactory(address(vaultImplementation), address(0), admin);
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(SendVaultFactory.InvalidAddress.selector);
        new SendVaultFactory(address(vaultImplementation), globalKeeper, address(0));
    }

    function test_constructor_setsDefaultFee() public view {
        assertEq(factory.feeBps(), 49);
        assertEq(factory.admin(), admin);
    }

    // ─── setFee ──────────────────────────────────────────────────────────────

    function test_setFee_success() public {
        vm.prank(admin);
        factory.setFee(100);
        assertEq(factory.feeBps(), 100);
    }

    function test_setFee_emitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit FeeUpdated(100);
        vm.prank(admin);
        factory.setFee(100);
    }

    function test_setFee_revertsIfNotAdmin() public {
        vm.prank(alice);
        vm.expectRevert(SendVaultFactory.NotAdmin.selector);
        factory.setFee(100);
    }

    function test_setFee_revertsIfExceedsCap() public {
        vm.prank(admin);
        vm.expectRevert(SendVaultFactory.FeeTooHigh.selector);
        factory.setFee(501);
    }

    function test_setFee_allowsExactCap() public {
        vm.prank(admin);
        factory.setFee(500);
        assertEq(factory.feeBps(), 500);
    }

    // ─── setMinFee (pro Token) ───────────────────────────────────────────────

    function test_setMinFee_isPerToken() public {
        vm.startPrank(admin);
        factory.setMinFee(usdc, 9_000);   // ~$0.009 bei 6 Decimals
        factory.setMinFee(wbtc, 15);      // anderer Rohwert bei 8 Decimals
        vm.stopPrank();

        (, uint256 minFeeUsdc,) = factory.feeInfo(usdc);
        (, uint256 minFeeWbtc,) = factory.feeInfo(wbtc);
        assertEq(minFeeUsdc, 9_000);
        assertEq(minFeeWbtc, 15);
    }

    function test_setMinFee_defaultsToZeroForUnsetToken() public view {
        (, uint256 minFee,) = factory.feeInfo(usdc);
        assertEq(minFee, 0);
    }

    function test_setMinFee_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MinFeeUpdated(usdc, 9_000);
        vm.prank(admin);
        factory.setMinFee(usdc, 9_000);
    }

    function test_setMinFee_revertsIfNotAdmin() public {
        vm.prank(alice);
        vm.expectRevert(SendVaultFactory.NotAdmin.selector);
        factory.setMinFee(usdc, 9_000);
    }

    function test_setMinFee_allowsZeroAddressToken() public {
        // Bewusst kein address(0)-Check (siehe Kommentar in SendVaultFactory.sol) —
        // ein falsch gesetzter minFee für ein nie genutztes Token ist folgenlos.
        vm.prank(admin);
        factory.setMinFee(address(0), 1);
        (, uint256 minFee,) = factory.feeInfo(address(0));
        assertEq(minFee, 1);
    }

    // ─── setAdmin ────────────────────────────────────────────────────────────

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
        vm.expectRevert(SendVaultFactory.NotAdmin.selector);
        factory.setAdmin(bob);
    }

    function test_setAdmin_revertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(SendVaultFactory.InvalidAddress.selector);
        factory.setAdmin(address(0));
    }

    // ─── feeInfo ─────────────────────────────────────────────────────────────

    function test_feeInfo_returnsTreasuryAsGlobalKeeper() public view {
        (uint16 feeBps,, address treasury) = factory.feeInfo(usdc);
        assertEq(feeBps, 49);
        assertEq(treasury, globalKeeper);
    }
}
