// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {DcaVault} from "../contracts/DcaVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockUniversalRouter} from "./mocks/MockUniversalRouter.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

/// @notice Vollständige Test-Suite für DcaVault.
///
/// Ausführen:    forge test -vvv
/// Mit Coverage: forge coverage
/// Einzelner Test: forge test --match-test test_setupPlan_success -vvv

contract DcaVaultTest is Test {

    // ─── Contracts ───────────────────────────────────────────────────────────

    DcaVault             vault;
    MockERC20            usdc;
    MockERC20            weth;
    MockERC20            celo;
    MockUniversalRouter  router;
    MockPermit2          permit2;

    // ─── Adressen ────────────────────────────────────────────────────────────

    address owner   = makeAddr("owner");
    address keeper  = makeAddr("keeper");
    address hacker  = makeAddr("hacker");

    // ─── Permit2-Adresse (wird auf diese Adresse deployed) ───────────────────
    address constant PERMIT2_ADDR = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ─── Test-Parameter ──────────────────────────────────────────────────────

    uint256 constant TOTAL_AMOUNT   = 100e6;  // 100 USDC (6 Decimals)
    uint32  constant DURATION       = 10;     // 10 Tranchen
    uint256 constant INTERVAL       = 1 days;
    uint256 constant TRANCHE_AMOUNT = TOTAL_AMOUNT / DURATION; // 10 USDC

    // Pool-Parameter (V4)
    uint24  constant POOL_FEE      = 3000;
    int24   constant TICK_SPACING  = 60;

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        // Mock-Contracts deployen
        usdc   = new MockERC20("USD Coin",  "USDC", 6);
        weth   = new MockERC20("Wrapped ETH", "WETH", 18);
        celo   = new MockERC20("Celo",      "CELO", 18);
        router = new MockUniversalRouter();

        // Permit2-Mock an der echten Permit2-Adresse deployen
        permit2 = new MockPermit2();
        vm.etch(PERMIT2_ADDR, address(permit2).code);

        // Vault deployen
        vm.prank(owner);
        vault = new DcaVault(address(router), owner);

        // Owner mit USDC versorgen
        usdc.mint(owner, TOTAL_AMOUNT * 10);

        // Weth + Celo für Router-Output bereitstellen
        weth.mint(address(router), 1000e18);
        celo.mint(address(router), 1000e18);
    }

    // ─── Hilfsfunktionen ─────────────────────────────────────────────────────

    function _approveAndSetup(
        uint256 totalAmount,
        uint32  duration,
        uint256 interval,
        uint256 firstExecution
    ) internal {
        address[] memory targets      = new address[](2);
        uint16[]  memory bps          = new uint16[](2);
        uint24[]  memory fees         = new uint24[](2);
        int24[]   memory tickSpacings = new int24[](2);
        address[] memory hooks        = new address[](2);

        targets[0]      = address(weth);
        targets[1]      = address(celo);
        bps[0]          = 5000;  // 50%
        bps[1]          = 5000;  // 50%
        fees[0]         = POOL_FEE;
        fees[1]         = POOL_FEE;
        tickSpacings[0] = TICK_SPACING;
        tickSpacings[1] = TICK_SPACING;
        hooks[0]        = address(0);
        hooks[1]        = address(0);

        vm.startPrank(owner);
        usdc.approve(address(vault), totalAmount);
        vault.setupPlan(
            address(usdc),
            totalAmount,
            duration,
            interval,
            firstExecution,
            targets,
            bps,
            fees,
            tickSpacings,
            hooks
        );
        vm.stopPrank();
    }

    // ─── Constructor Tests ───────────────────────────────────────────────────

    function test_constructor_setsOwnerAndRouter() public view {
        assertEq(vault.owner(),                  owner);
        assertEq(address(vault.universalRouter()), address(router));
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(DcaVault.InvalidAddress.selector);
        new DcaVault(address(0), owner);

        vm.expectRevert(DcaVault.InvalidAddress.selector);
        new DcaVault(address(router), address(0));
    }

    // ─── setupPlan Tests ─────────────────────────────────────────────────────

    function test_setupPlan_success() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);

        assertEq(vault.initialized(),           true);
        assertEq(vault.cancelled(),             false);
        assertEq(vault.totalDeposited(),        TOTAL_AMOUNT);
        assertEq(vault.trancheAmount(),         TRANCHE_AMOUNT);
        assertEq(vault.totalSteps(),            DURATION);
        assertEq(vault.currentStep(),           0);
        assertEq(vault.interval(),              INTERVAL);
        assertEq(vault.nextExecutionTimestamp(), firstExecution);
        assertEq(vault.targetConfigCount(),     2);
        assertEq(usdc.balanceOf(address(vault)), TOTAL_AMOUNT);
    }

    function test_setupPlan_emitsEvent() public {
        uint256 firstExecution = block.timestamp + 1 hours;

        vm.expectEmit(true, true, false, true);
        emit DcaVault.DcaPlanCreated(
            owner,
            address(usdc),
            TOTAL_AMOUNT,
            TRANCHE_AMOUNT,
            DURATION,
            INTERVAL,
            firstExecution
        );

        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
    }

    function test_setupPlan_revertsIfNotOwner() public {
        vm.prank(hacker);
        vm.expectRevert(DcaVault.NotOwner.selector);

        address[] memory targets      = new address[](1);
        uint16[]  memory bps          = new uint16[](1);
        uint24[]  memory fees         = new uint24[](1);
        int24[]   memory tickSpacings = new int24[](1);
        address[] memory hooks        = new address[](1);
        targets[0] = address(weth); bps[0] = 10000; fees[0] = 3000;
        tickSpacings[0] = 60; hooks[0] = address(0);

        vault.setupPlan(address(usdc), TOTAL_AMOUNT, DURATION, INTERVAL,
            block.timestamp + 1, targets, bps, fees, tickSpacings, hooks);
    }

    function test_setupPlan_revertsIfAlreadyInitialized() public {
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 1 hours);

        vm.expectRevert(DcaVault.AlreadyInitialized.selector);
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 2 hours);
    }

    function test_setupPlan_revertsOnInvalidAllocation() public {
        address[] memory targets      = new address[](2);
        uint16[]  memory bps          = new uint16[](2);
        uint24[]  memory fees         = new uint24[](2);
        int24[]   memory tickSpacings = new int24[](2);
        address[] memory hooks        = new address[](2);

        targets[0] = address(weth); targets[1] = address(celo);
        bps[0] = 4000; bps[1] = 4000; // nur 80% statt 100%
        fees[0] = fees[1] = 3000;
        tickSpacings[0] = tickSpacings[1] = 60;
        hooks[0] = hooks[1] = address(0);

        vm.startPrank(owner);
        usdc.approve(address(vault), TOTAL_AMOUNT);
        vm.expectRevert(DcaVault.AllocationInvalid.selector);
        vault.setupPlan(address(usdc), TOTAL_AMOUNT, DURATION, INTERVAL,
            block.timestamp + 1, targets, bps, fees, tickSpacings, hooks);
        vm.stopPrank();
    }

    function test_setupPlan_revertsOnDuplicateTarget() public {
        address[] memory targets      = new address[](2);
        uint16[]  memory bps          = new uint16[](2);
        uint24[]  memory fees         = new uint24[](2);
        int24[]   memory tickSpacings = new int24[](2);
        address[] memory hooks        = new address[](2);

        targets[0] = address(weth); targets[1] = address(weth); // Duplikat!
        bps[0] = 5000; bps[1] = 5000;
        fees[0] = fees[1] = 3000;
        tickSpacings[0] = tickSpacings[1] = 60;
        hooks[0] = hooks[1] = address(0);

        vm.startPrank(owner);
        usdc.approve(address(vault), TOTAL_AMOUNT);
        vm.expectRevert(DcaVault.DuplicateTarget.selector);
        vault.setupPlan(address(usdc), TOTAL_AMOUNT, DURATION, INTERVAL,
            block.timestamp + 1, targets, bps, fees, tickSpacings, hooks);
        vm.stopPrank();
    }

    // ─── setKeeper Tests ─────────────────────────────────────────────────────

    function test_setKeeper_success() public {
        vm.prank(owner);
        vault.setKeeper(keeper, true);
        assertTrue(vault.isKeeper(keeper));
    }

    function test_setKeeper_revertsIfNotOwner() public {
        vm.prank(hacker);
        vm.expectRevert(DcaVault.NotOwner.selector);
        vault.setKeeper(keeper, true);
    }

    // ─── canExecute Tests ────────────────────────────────────────────────────

    function test_canExecute_falseBeforeInit() public view {
        assertFalse(vault.canExecute());
    }

    function test_canExecute_falseBeforeTimestamp() public {
        uint256 firstExecution = block.timestamp + 1 days;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        assertFalse(vault.canExecute());
    }

    function test_canExecute_trueAfterTimestamp() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);
        assertTrue(vault.canExecute());
    }

    // ─── executeStep Tests ───────────────────────────────────────────────────

    function test_executeStep_advancesStep() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        uint256[] memory minOut = new uint256[](2);
        minOut[0] = 1; minOut[1] = 1;

        vm.prank(owner);
        vault.executeStep(minOut);

        assertEq(vault.currentStep(), 1);
        assertEq(vault.nextExecutionTimestamp(), firstExecution + INTERVAL);
        assertEq(vault.remainingSteps(), DURATION - 1);
    }

    function test_executeStep_revertsIfTooEarly() public {
        uint256 firstExecution = block.timestamp + 1 days;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);

        uint256[] memory minOut = new uint256[](2);
        minOut[0] = 1; minOut[1] = 1;

        vm.prank(owner);
        vm.expectRevert(DcaVault.TooEarly.selector);
        vault.executeStep(minOut);
    }

    function test_executeStep_revertsIfNotExecutor() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        uint256[] memory minOut = new uint256[](2);
        minOut[0] = 1; minOut[1] = 1;

        vm.prank(hacker);
        vm.expectRevert(DcaVault.NotExecutor.selector);
        vault.executeStep(minOut);
    }

    function test_executeStep_keeperCanExecute() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        vm.prank(owner);
        vault.setKeeper(keeper, true);

        uint256[] memory minOut = new uint256[](2);
        minOut[0] = 1; minOut[1] = 1;

        vm.prank(keeper);
        vault.executeStep(minOut);

        assertEq(vault.currentStep(), 1);
    }

    function test_executeStep_lastStepUsesFullBalance() public {
        // Nur 1 Schritt — gesamtes Guthaben wird verwendet
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, 1, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        uint256[] memory minOut = new uint256[](2);
        minOut[0] = 1; minOut[1] = 1;

        vm.prank(owner);
        vault.executeStep(minOut);

        assertEq(vault.currentStep(), 1);
        assertEq(vault.remainingSteps(), 0);
    }

    function test_executeStep_revertsAfterComplete() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, 1, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        uint256[] memory minOut = new uint256[](2);
        minOut[0] = 1; minOut[1] = 1;

        vm.startPrank(owner);
        vault.executeStep(minOut);

        vm.expectRevert(DcaVault.PlanComplete.selector);
        vault.executeStep(minOut);
        vm.stopPrank();
    }

    // ─── cancelPlan Tests ────────────────────────────────────────────────────

    function test_cancelPlan_returnsTokens() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);

        uint256 ownerBalanceBefore = usdc.balanceOf(owner);

        vm.prank(owner);
        vault.cancelPlan();

        assertTrue(vault.cancelled());
        assertEq(usdc.balanceOf(owner), ownerBalanceBefore + TOTAL_AMOUNT);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_cancelPlan_emitsEvent() public {
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 1 hours);

        vm.expectEmit(false, false, false, true);
        emit DcaVault.PlanCancelled(TOTAL_AMOUNT);

        vm.prank(owner);
        vault.cancelPlan();
    }

    function test_cancelPlan_revertsIfAlreadyCancelled() public {
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 1 hours);

        vm.startPrank(owner);
        vault.cancelPlan();

        vm.expectRevert(DcaVault.PlanCancelled.selector);
        vault.cancelPlan();
        vm.stopPrank();
    }

    function test_cancelPlan_revertsIfNotOwner() public {
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 1 hours);

        vm.prank(hacker);
        vm.expectRevert(DcaVault.NotOwner.selector);
        vault.cancelPlan();
    }

    // ─── View-Funktionen ─────────────────────────────────────────────────────

    function test_remainingInputBalance_zeroBeforeInit() public view {
        assertEq(vault.remainingInputBalance(), 0);
    }

    function test_remainingInputBalance_afterSetup() public {
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 1 hours);
        assertEq(vault.remainingInputBalance(), TOTAL_AMOUNT);
    }

    function test_getTargetConfigs_returnsCorrectData() public {
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 1 hours);

        DcaVault.TargetConfig[] memory configs = vault.getTargetConfigs();
        assertEq(configs.length,       2);
        assertEq(configs[0].token,     address(weth));
        assertEq(configs[0].bps,       5000);
        assertEq(configs[0].poolFee,   POOL_FEE);
        assertEq(configs[0].tickSpacing, TICK_SPACING);
        assertEq(configs[1].token,     address(celo));
        assertEq(configs[1].bps,       5000);
    }

    // ─── Fuzz Tests ──────────────────────────────────────────────────────────

    /// @notice Testet dass trancheAmount immer ≤ totalAmount / duration ist.
    function testFuzz_trancheAmount(uint32 duration) public {
        vm.assume(duration >= 1 && duration <= 365);
        uint256 amount = uint256(duration) * 1e6; // Mindestbetrag: 1 USDC pro Tranche

        address[] memory targets      = new address[](1);
        uint16[]  memory bps          = new uint16[](1);
        uint24[]  memory fees         = new uint24[](1);
        int24[]   memory tickSpacings = new int24[](1);
        address[] memory hooks        = new address[](1);
        targets[0] = address(weth); bps[0] = 10000;
        fees[0] = 3000; tickSpacings[0] = 60; hooks[0] = address(0);

        usdc.mint(owner, amount);

        vm.startPrank(owner);
        usdc.approve(address(vault), amount);
        vault.setupPlan(address(usdc), amount, duration, INTERVAL,
            block.timestamp + 1, targets, bps, fees, tickSpacings, hooks);
        vm.stopPrank();

        assertEq(vault.trancheAmount(), amount / duration);
        assertLe(vault.trancheAmount() * duration, amount);
    }
}
