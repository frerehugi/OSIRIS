// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {TriggerVault} from "../contracts/TriggerVault.sol";
import {TriggerVaultFactory} from "../contracts/TriggerVaultFactory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSquidRouter} from "./mocks/MockSquidRouter.sol";

/// @notice Test-Suite für TriggerVault + TriggerVaultFactory (Apis).
///
/// Ausführen:    forge test --match-contract TriggerVaultTest -vvv

contract TriggerVaultTest is Test {

    TriggerVault        implementation;
    TriggerVaultFactory factory;
    MockERC20       usdc;
    MockERC20       wbtc;
    MockSquidRouter router;

    address owner    = makeAddr("owner");
    address keeper   = makeAddr("keeper"); // == globalKeeper
    address hacker   = makeAddr("hacker");
    address admin    = makeAddr("admin");

    uint256 constant AMOUNT = 100e6; // 100 USDC (6 Decimals)
    uint16  constant DEFAULT_FEE_BPS = 99;
    uint256 constant DEFAULT_MIN_FEE = 35_000;
    uint256 constant DEFAULT_TRIGGER_PRICE = 65_000e8;

    function setUp() public {
        usdc   = new MockERC20("USD Coin",    "USDC", 6);
        wbtc   = new MockERC20("Wrapped BTC", "wBTC", 8);
        router = new MockSquidRouter();

        implementation = new TriggerVault();
        factory = new TriggerVaultFactory(address(implementation), address(router), keeper, admin);

        usdc.mint(owner, 1_000e6);
        wbtc.mint(address(router), 10e8);
    }

    // ─── Hilfsfunktionen ─────────────────────────────────────────────────────

    function _feeFor(uint256 amt) internal pure returns (uint256) {
        uint256 fee = (amt * DEFAULT_FEE_BPS) / 10_000;
        return fee < DEFAULT_MIN_FEE ? DEFAULT_MIN_FEE : fee;
    }

    function _createVault() internal returns (TriggerVault vault) {
        vm.prank(owner);
        vault = TriggerVault(factory.createVault());
    }

    function _createBuyVaultWithPlan(uint256 amt, uint256 expiresAt) internal returns (TriggerVault vault) {
        vault = _createVault();
        vm.prank(owner);
        usdc.approve(address(vault), amt);
        vm.prank(owner);
        vault.setupPlan(address(usdc), address(wbtc), address(wbtc), amt, true, DEFAULT_TRIGGER_PRICE, expiresAt);
    }

    // ─── Factory: createVault ────────────────────────────────────────────────

    function test_createVault_clonesAndInitializes() public {
        TriggerVault vault = _createVault();
        assertEq(vault.owner(), owner);
        assertEq(vault.factory(), address(factory));
        assertTrue(vault.approvedRouters(address(router)));
        assertTrue(vault.isKeeper(keeper));
    }

    function test_createVault_tracksVaultsOfOwnerAndAll() public {
        TriggerVault v1 = _createVault();
        TriggerVault v2 = _createVault();
        assertEq(factory.getVaults(owner).length, 2);
        assertEq(factory.getVaults(owner)[0], address(v1));
        assertEq(factory.getVaults(owner)[1], address(v2));
        assertEq(factory.getAllVaults().length, 2);
        assertEq(factory.vaultCount(), 2);
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        new TriggerVaultFactory(address(0), address(router), keeper, admin);
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        new TriggerVaultFactory(address(implementation), address(0), keeper, admin);
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        new TriggerVaultFactory(address(implementation), address(router), address(0), admin);
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        new TriggerVaultFactory(address(implementation), address(router), keeper, address(0));
    }

    function test_constructor_setsDefaultFee() public view {
        assertEq(factory.feeBps(), DEFAULT_FEE_BPS);
        assertEq(factory.minFee(), DEFAULT_MIN_FEE);
    }

    // ─── initialize guard ────────────────────────────────────────────────────

    function test_initialize_revertsIfAlreadyInitialized() public {
        TriggerVault vault = _createVault();
        vm.expectRevert(TriggerVault.AlreadyInitialized.selector);
        vault.initialize(owner, address(router), keeper);
    }

    function test_initialize_revertsOnImplementationDirectly() public {
        vm.expectRevert(TriggerVault.AlreadyInitialized.selector);
        implementation.initialize(owner, address(router), keeper);
    }

    // ─── setupPlan ───────────────────────────────────────────────────────────

    function test_setupPlan_pullsFundsAndStoresFields() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        assertEq(usdc.balanceOf(address(vault)), AMOUNT);
        assertTrue(vault.initialized());
        assertFalse(vault.cancelled());
        assertFalse(vault.executed());
        assertEq(address(vault.heldToken()), address(usdc));
        assertEq(vault.outputToken(), address(wbtc));
        assertEq(vault.watchToken(), address(wbtc));
        assertEq(vault.amount(), AMOUNT);
        assertTrue(vault.triggerAbove());
        assertEq(vault.triggerPrice(), DEFAULT_TRIGGER_PRICE);
        assertEq(vault.expiresAt(), 0);
    }

    function test_setupPlan_revertsIfAlreadyInitialized() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        vm.prank(owner);
        usdc.approve(address(vault), AMOUNT);
        vm.prank(owner);
        vm.expectRevert(TriggerVault.AlreadyInitialized.selector);
        vault.setupPlan(address(usdc), address(wbtc), address(wbtc), AMOUNT, true, DEFAULT_TRIGGER_PRICE, 0);
    }

    function test_setupPlan_revertsIfNotOwner() public {
        TriggerVault vault = _createVault();
        vm.prank(hacker);
        vm.expectRevert(TriggerVault.NotOwner.selector);
        vault.setupPlan(address(usdc), address(wbtc), address(wbtc), AMOUNT, true, DEFAULT_TRIGGER_PRICE, 0);
    }

    function test_setupPlan_revertsOnSameToken() public {
        TriggerVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(TriggerVault.SameToken.selector);
        vault.setupPlan(address(usdc), address(usdc), address(usdc), AMOUNT, true, DEFAULT_TRIGGER_PRICE, 0);
    }

    function test_setupPlan_revertsOnZeroAmount() public {
        TriggerVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(TriggerVault.InvalidAmount.selector);
        vault.setupPlan(address(usdc), address(wbtc), address(wbtc), 0, true, DEFAULT_TRIGGER_PRICE, 0);
    }

    function test_setupPlan_revertsOnZeroTriggerPrice() public {
        TriggerVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(TriggerVault.InvalidTriggerPrice.selector);
        vault.setupPlan(address(usdc), address(wbtc), address(wbtc), AMOUNT, true, 0, 0);
    }

    function test_setupPlan_revertsOnPastExpiry() public {
        vm.warp(1_000_000); // definitiv ungleich 0, damit "0 = unbegrenzt" nicht kollidiert
        TriggerVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(TriggerVault.InvalidTimestamp.selector);
        vault.setupPlan(address(usdc), address(wbtc), address(wbtc), AMOUNT, true, DEFAULT_TRIGGER_PRICE, block.timestamp - 1);
    }

    function test_setupPlan_acceptsFutureExpiry() public {
        uint256 expiry = block.timestamp + 30 days;
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, expiry);
        assertEq(vault.expiresAt(), expiry);
    }

    // ─── cancel ───────────────────────────────────────────────────────────────

    function test_cancel_refundsFullBalance() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        uint256 balanceBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.cancel();
        assertTrue(vault.cancelled());
        assertEq(usdc.balanceOf(owner), balanceBefore + AMOUNT);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_cancel_revertsIfNotOwner() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        vm.prank(hacker);
        vm.expectRevert(TriggerVault.NotOwner.selector);
        vault.cancel();
    }

    function test_cancel_revertsIfAlreadyCancelled() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        vm.startPrank(owner);
        vault.cancel();
        vm.expectRevert(TriggerVault.PlanAlreadyCancelled.selector);
        vault.cancel();
        vm.stopPrank();
    }

    function test_cancel_revertsIfNotInitialized() public {
        TriggerVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(TriggerVault.NotInitialized.selector);
        vault.cancel();
    }

    // ─── execute ─────────────────────────────────────────────────────────────

    function test_execute_swapsFullBalanceMinusFeeAndSendsToOwner() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        uint256 fee = _feeFor(AMOUNT);
        uint256 netIn = AMOUNT - fee;
        uint256 outAmount = 1_500_000; // beliebiger wBTC-Betrag (8 Decimals)

        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), netIn, address(wbtc), outAmount, owner);

        vm.prank(keeper);
        vault.execute(address(router), outAmount, callData);

        assertTrue(vault.executed());
        assertEq(wbtc.balanceOf(owner), outAmount);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_execute_chargesFeeToTreasury() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        uint256 fee = _feeFor(AMOUNT);
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), AMOUNT - fee, address(wbtc), 1_000_000, owner);

        vm.prank(keeper);
        vault.execute(address(router), 1_000_000, callData);

        assertEq(usdc.balanceOf(keeper), fee); // treasury == globalKeeper
    }

    function test_execute_ownerCanExecuteDirectly() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        uint256 fee = _feeFor(AMOUNT);
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), AMOUNT - fee, address(wbtc), 1_000_000, owner);

        vm.prank(owner);
        vault.execute(address(router), 1_000_000, callData);
        assertTrue(vault.executed());
    }

    function test_execute_revertsForUnauthorizedCaller() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        vm.prank(hacker);
        vm.expectRevert(TriggerVault.NotExecutor.selector);
        vault.execute(address(router), 1, "");
    }

    function test_execute_revertsIfNotInitialized() public {
        TriggerVault vault = _createVault();
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.NotInitialized.selector);
        vault.execute(address(router), 1, "");
    }

    function test_execute_revertsIfCancelled() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        vm.prank(owner);
        vault.cancel();
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.PlanAlreadyCancelled.selector);
        vault.execute(address(router), 1, "");
    }

    function test_execute_revertsIfAlreadyExecuted() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        uint256 fee = _feeFor(AMOUNT);
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), AMOUNT - fee, address(wbtc), 1_000_000, owner);
        vm.startPrank(keeper);
        vault.execute(address(router), 1_000_000, callData);
        vm.expectRevert(TriggerVault.PlanAlreadyExecuted.selector);
        vault.execute(address(router), 1_000_000, callData);
        vm.stopPrank();
    }

    function test_execute_revertsIfExpired() public {
        uint256 expiry = block.timestamp + 1 days;
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, expiry);
        vm.warp(expiry + 1);
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.Expired.selector);
        vault.execute(address(router), 1, "");
    }

    function test_execute_succeedsExactlyAtExpiry() public {
        uint256 expiry = block.timestamp + 1 days;
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, expiry);
        vm.warp(expiry);
        uint256 fee = _feeFor(AMOUNT);
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), AMOUNT - fee, address(wbtc), 1_000_000, owner);
        vm.prank(keeper);
        vault.execute(address(router), 1_000_000, callData);
        assertTrue(vault.executed());
    }

    function test_execute_revertsOnUnapprovedRouter() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        address randomRouter = makeAddr("randomRouter");
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.RouterNotApproved.selector);
        vault.execute(randomRouter, 1, "");
    }

    function test_execute_revertsOnZeroMinAmountOut() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.MinOutRequired.selector);
        vault.execute(address(router), 0, "");
    }

    function test_execute_revertsOnSlippageExceeded() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        uint256 fee = _feeFor(AMOUNT);
        uint256 outAmount = 1_000_000;
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), AMOUNT - fee, address(wbtc), outAmount, owner);
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.SlippageExceeded.selector);
        vault.execute(address(router), outAmount + 1, callData);
    }

    function test_execute_revertsOnSwapFailure() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        router.setShouldFail(true);
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.SwapFailed.selector);
        vault.execute(address(router), 1, abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), 1, address(wbtc), 1, owner));
    }

    function test_execute_keeperNeedsPerVaultApproval() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        address extraKeeper = makeAddr("extraKeeper");

        vm.prank(extraKeeper);
        vm.expectRevert(TriggerVault.NotExecutor.selector);
        vault.execute(address(router), 1, "");

        vm.prank(owner);
        vault.setKeeper(extraKeeper, true);

        uint256 fee = _feeFor(AMOUNT);
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), AMOUNT - fee, address(wbtc), 1_000_000, owner);
        vm.prank(extraKeeper);
        vault.execute(address(router), 1_000_000, callData);
        assertTrue(vault.executed());
    }

    function test_execute_ownerCanApproveAdditionalRouter() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        MockSquidRouter secondRouter = new MockSquidRouter();
        wbtc.mint(address(secondRouter), 10e8);

        vm.prank(owner);
        vault.setRouter(address(secondRouter), true);

        uint256 fee = _feeFor(AMOUNT);
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), AMOUNT - fee, address(wbtc), 1_000_000, owner);
        vm.prank(keeper);
        vault.execute(address(secondRouter), 1_000_000, callData);
        assertTrue(vault.executed());
    }

    // ─── canExecute ──────────────────────────────────────────────────────────

    function test_canExecute_trueWhenLive() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        assertTrue(vault.canExecute());
    }

    function test_canExecute_falseAfterCancel() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        vm.prank(owner);
        vault.cancel();
        assertFalse(vault.canExecute());
    }

    function test_canExecute_falseAfterExpiry() public {
        uint256 expiry = block.timestamp + 1 days;
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, expiry);
        vm.warp(expiry + 1);
        assertFalse(vault.canExecute());
    }

    function test_canExecute_falseIfNotInitialized() public {
        TriggerVault vault = _createVault();
        assertFalse(vault.canExecute());
    }

    // ─── Sell-Plan-Richtung (heldToken = Zieltoken, outputToken = Stablecoin) ──

    function test_sellDirection_worksSymmetrically() public {
        wbtc.mint(owner, 1e8);
        usdc.mint(address(router), 100_000e6);

        TriggerVault vault = _createVault();
        vm.prank(owner);
        wbtc.approve(address(vault), 1e8);
        vm.prank(owner);
        vault.setupPlan(address(wbtc), address(usdc), address(wbtc), 1e8, true, 75_000e8, 0);

        uint256 sellAmount = 1e8;
        uint256 fee = _feeFor(sellAmount);
        uint256 netIn = sellAmount - fee;
        uint256 outAmount = 75_000e6;
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(wbtc), netIn, address(usdc), outAmount, owner);

        uint256 usdcBefore = usdc.balanceOf(owner); // owner hält aus setUp() bereits 1000 USDC
        vm.prank(keeper);
        vault.execute(address(router), outAmount, callData);

        assertTrue(vault.executed());
        assertEq(usdc.balanceOf(owner) - usdcBefore, outAmount);
    }

    // ─── Admin-Funktionen (Factory) ──────────────────────────────────────────

    function test_setFee_updatesFeeAndMinFee() public {
        vm.prank(admin);
        factory.setFee(200, 50_000);
        assertEq(factory.feeBps(), 200);
        assertEq(factory.minFee(), 50_000);
    }

    function test_setFee_revertsAboveHardCap() public {
        vm.prank(admin);
        vm.expectRevert(TriggerVaultFactory.FeeTooHigh.selector);
        factory.setFee(501, 0);
    }

    function test_setFee_revertsForNonAdmin() public {
        vm.prank(hacker);
        vm.expectRevert(TriggerVaultFactory.NotAdmin.selector);
        factory.setFee(100, 0);
    }

    function test_setAdmin_updatesAdmin() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        factory.setAdmin(newAdmin);
        assertEq(factory.admin(), newAdmin);
    }
}
