// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {TriggerVault} from "../contracts/TriggerVault.sol";
import {TriggerVaultFactory} from "../contracts/TriggerVaultFactory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSquidRouter} from "./mocks/MockSquidRouter.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Test-Suite für TriggerVault + TriggerVaultFactory (APIS).
///
/// Ausführen:    forge test --match-contract TriggerVaultTest -vvv

contract TriggerVaultTest is Test {

    event MinFeeUpdated(address indexed token, uint256 minFee);

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
    uint256 constant DEFAULT_MIN_FEE = 35_000;      // usdc (6 Decimals), unverändert seit Plan 2 B3
    uint256 constant DEFAULT_MIN_FEE_WBTC = 50;     // wbtc (8 Decimals), ≈$0.0385 bei ~$77k/BTC — Plan 4 Befund A
    uint256 constant DEFAULT_TRIGGER_PRICE = 65_000e8;
    uint16  constant DEFAULT_MAX_SLIPPAGE_BPS = 200; // 2 %, siehe TriggerVaultFactory-Konstruktor

    function setUp() public {
        usdc   = new MockERC20("USD Coin",    "USDC", 6);
        wbtc   = new MockERC20("Wrapped BTC", "wBTC", 8);
        router = new MockSquidRouter();

        implementation = new TriggerVault();

        // usdc ist in beiden Richtungen (Buy/Sell) das Stablecoin-Bein — wird
        // ATOMAR im Konstruktor freigeschaltet (siehe TriggerVaultFactory),
        // sonst revertet jedes setupPlan() mit StablecoinRequired().
        address[] memory initialStablecoins = new address[](1);
        initialStablecoins[0] = address(usdc);

        // minFeeByToken-Seeding (Plan 4 Befund A) — usdc behält den bisherigen
        // Wert, wbtc bekommt einen realistisch decimals-skalierten Wert statt
        // den alten globalen 35_000 (der bei wbtc, 8 statt 6 Decimals, 0,00035
        // wBTC bedeutet hätte — genau der vom Review reproduzierte Bug).
        address[] memory minFeeTokens = new address[](2);
        minFeeTokens[0] = address(usdc);
        minFeeTokens[1] = address(wbtc);
        uint256[] memory minFeeValues = new uint256[](2);
        minFeeValues[0] = DEFAULT_MIN_FEE;
        minFeeValues[1] = DEFAULT_MIN_FEE_WBTC;

        factory = new TriggerVaultFactory(
            address(implementation), address(router), keeper, admin,
            initialStablecoins, minFeeTokens, minFeeValues
        );

        usdc.mint(owner, 1_000e6);
        wbtc.mint(address(router), 10e8);
    }

    // ─── Hilfsfunktionen ─────────────────────────────────────────────────────

    function _feeFor(uint256 amt) internal pure returns (uint256) {
        uint256 fee = (amt * DEFAULT_FEE_BPS) / 10_000;
        return fee < DEFAULT_MIN_FEE ? DEFAULT_MIN_FEE : fee;
    }

    // Spiegelt TriggerVault._slippageFloor() exakt (gleiche mulDiv-Kette),
    // damit Tests die On-Chain-Grenze exakt statt approximativ treffen können.
    function _expectedBuyFloor(uint256 amountIn, uint256 price, uint8 dh, uint8 doo, uint16 maxSlippageBps)
        internal pure returns (uint256)
    {
        uint256 slippageFactor = 10_000 - maxSlippageBps;
        uint256 usdValue = Math.mulDiv(amountIn, 1e8, 10 ** dh);
        return Math.mulDiv(usdValue, (10 ** doo) * slippageFactor, price * 10_000);
    }

    function _expectedSellFloor(uint256 amountIn, uint256 price, uint8 dh, uint8 doo, uint16 maxSlippageBps)
        internal pure returns (uint256)
    {
        uint256 slippageFactor = 10_000 - maxSlippageBps;
        uint256 usdValue = Math.mulDiv(amountIn, price, 10 ** dh);
        return Math.mulDiv(usdValue, (10 ** doo) * slippageFactor, 1e8 * 10_000);
    }

    function _createVault() internal returns (TriggerVault vault) {
        vm.prank(owner);
        vault = TriggerVault(factory.createVault());
    }

    // Buy-Plan: heldToken=Stablecoin, watchToken=outputToken=Zieltoken,
    // triggerAbove=false ("kaufen, wenn der Preis fällt") — siehe neue
    // Richtungs-Invariante in TriggerVault.setupPlan().
    function _createBuyVaultWithPlan(uint256 amt, uint256 expiresAt) internal returns (TriggerVault vault) {
        vault = _createVault();
        vm.prank(owner);
        usdc.approve(address(vault), amt);
        vm.prank(owner);
        vault.setupPlan(address(usdc), address(wbtc), address(wbtc), amt, false, DEFAULT_TRIGGER_PRICE, expiresAt);
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
        address[] memory noStablecoins = new address[](0);
        address[] memory noMinFeeTokens = new address[](0);
        uint256[] memory noMinFeeValues = new uint256[](0);
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        new TriggerVaultFactory(address(0), address(router), keeper, admin, noStablecoins, noMinFeeTokens, noMinFeeValues);
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        new TriggerVaultFactory(address(implementation), address(0), keeper, admin, noStablecoins, noMinFeeTokens, noMinFeeValues);
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        new TriggerVaultFactory(address(implementation), address(router), address(0), admin, noStablecoins, noMinFeeTokens, noMinFeeValues);
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        new TriggerVaultFactory(address(implementation), address(router), keeper, address(0), noStablecoins, noMinFeeTokens, noMinFeeValues);
    }

    function test_constructor_revertsOnMinFeeArrayLengthMismatch() public {
        address[] memory noStablecoins = new address[](0);
        address[] memory minFeeTokens = new address[](1);
        minFeeTokens[0] = address(usdc);
        uint256[] memory minFeeValues = new uint256[](2);
        minFeeValues[0] = 1;
        minFeeValues[1] = 2;
        vm.expectRevert(TriggerVaultFactory.ArrayLengthMismatch.selector);
        new TriggerVaultFactory(address(implementation), address(router), keeper, admin, noStablecoins, minFeeTokens, minFeeValues);
    }

    function test_constructor_setsDefaultFee() public view {
        assertEq(factory.feeBps(), DEFAULT_FEE_BPS);
        assertEq(factory.minFeeByToken(address(usdc)), DEFAULT_MIN_FEE);
        assertEq(factory.minFeeByToken(address(wbtc)), DEFAULT_MIN_FEE_WBTC);
    }

    function test_constructor_whitelistsInitialStablecoins() public {
        assertTrue(factory.isStablecoin(address(usdc)));
        assertFalse(factory.isStablecoin(address(wbtc)));
    }

    function test_constructor_worksWithEmptyStablecoinList() public {
        address[] memory noStablecoins = new address[](0);
        address[] memory noMinFeeTokens = new address[](0);
        uint256[] memory noMinFeeValues = new uint256[](0);
        TriggerVaultFactory f = new TriggerVaultFactory(
            address(implementation), address(router), keeper, admin,
            noStablecoins, noMinFeeTokens, noMinFeeValues
        );
        assertFalse(f.isStablecoin(address(usdc)));
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
        assertFalse(vault.triggerAbove());
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

    // ─── setupPlan: Richtungs-Invariante + Stablecoin-Allowlist (neu) ────────

    function test_setupPlan_revertsIfWatchTokenIsNeitherLeg() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        TriggerVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(TriggerVault.InvalidWatchToken.selector);
        vault.setupPlan(address(usdc), address(wbtc), address(other), AMOUNT, false, DEFAULT_TRIGGER_PRICE, 0);
    }

    function test_setupPlan_revertsOnMismatchedDirection_buyWithTriggerAbove() public {
        // Buy (heldToken=Stablecoin, watchToken=outputToken) MUSS triggerAbove=false haben.
        TriggerVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(TriggerVault.InvalidDirection.selector);
        vault.setupPlan(address(usdc), address(wbtc), address(wbtc), AMOUNT, true, DEFAULT_TRIGGER_PRICE, 0);
    }

    function test_setupPlan_revertsOnMismatchedDirection_sellWithoutTriggerAbove() public {
        // Sell (heldToken=watchToken=Zieltoken) MUSS triggerAbove=true haben.
        wbtc.mint(owner, 1e8);
        TriggerVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(TriggerVault.InvalidDirection.selector);
        vault.setupPlan(address(wbtc), address(usdc), address(wbtc), 1e8, false, DEFAULT_TRIGGER_PRICE, 0);
    }

    function test_setupPlan_revertsIfNonWatchLegNotStablecoin() public {
        // wbtc ist auf der Factory nicht als Stablecoin gelistet — ein
        // "Buy"-Plan mit wbtc als heldToken (statt usdc) muss revertieren.
        MockERC20 otherTarget = new MockERC20("Other Target", "OTGT", 18);
        otherTarget.mint(address(router), 1_000e18);
        TriggerVault vault = _createVault();
        vm.prank(owner);
        wbtc.approve(address(vault), 1e8);
        wbtc.mint(owner, 1e8);
        vm.prank(owner);
        vm.expectRevert(TriggerVault.StablecoinRequired.selector);
        vault.setupPlan(address(wbtc), address(otherTarget), address(otherTarget), 1e8, false, DEFAULT_TRIGGER_PRICE, 0);
    }

    function test_setupPlan_snapshotsFeeAndSlippageBps() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        assertEq(vault.snapshotFeeBps(), DEFAULT_FEE_BPS);
        assertEq(vault.snapshotMinFee(), DEFAULT_MIN_FEE);
        assertEq(vault.snapshotMaxSlippageBps(), factory.maxSlippageBps());
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
        uint256 fee = _feeFor(AMOUNT);
        // minAmountOut muss über dem neuen On-Chain-Slippage-Floor liegen
        // (siehe _slippageFloor()-Tests unten), sonst revertet der Aufruf
        // schon vorher mit MinOutBelowFloor() statt den eigentlich getesteten
        // SwapFailed()-Pfad zu erreichen.
        uint256 minAmountOut = 500_000;
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.SwapFailed.selector);
        vault.execute(address(router), minAmountOut, abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), AMOUNT - fee, address(wbtc), minAmountOut, owner));
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

    // ─── execute: On-Chain-Slippage-Floor ────────────────────────────────────

    function test_execute_revertsIfMinAmountOutBelowFloor() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        uint256 fee = _feeFor(AMOUNT);
        uint256 netIn = AMOUNT - fee;
        uint256 floor = _expectedBuyFloor(netIn, DEFAULT_TRIGGER_PRICE, 6, 8, DEFAULT_MAX_SLIPPAGE_BPS);
        assertGt(floor, 0); // sonst wäre dieser Test wirkungslos

        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), netIn, address(wbtc), floor - 1, owner);
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.MinOutBelowFloor.selector);
        vault.execute(address(router), floor - 1, callData);
    }

    function test_execute_succeedsExactlyAtFloor() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);
        uint256 fee = _feeFor(AMOUNT);
        uint256 netIn = AMOUNT - fee;
        uint256 floor = _expectedBuyFloor(netIn, DEFAULT_TRIGGER_PRICE, 6, 8, DEFAULT_MAX_SLIPPAGE_BPS);

        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), netIn, address(wbtc), floor, owner);
        vm.prank(keeper);
        vault.execute(address(router), floor, callData);
        assertTrue(vault.executed());
    }

    function test_execute_sellDirection_revertsIfMinAmountOutBelowFloor() public {
        wbtc.mint(owner, 1e8);
        usdc.mint(address(router), 100_000e6);

        TriggerVault vault = _createVault();
        vm.prank(owner);
        wbtc.approve(address(vault), 1e8);
        vm.prank(owner);
        vault.setupPlan(address(wbtc), address(usdc), address(wbtc), 1e8, true, 75_000e8, 0);

        uint256 fee = _feeFor(1e8);
        uint256 netIn = 1e8 - fee;
        uint256 floor = _expectedSellFloor(netIn, 75_000e8, 8, 6, DEFAULT_MAX_SLIPPAGE_BPS);
        assertGt(floor, 0);

        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(wbtc), netIn, address(usdc), floor - 1, owner);
        vm.prank(keeper);
        vm.expectRevert(TriggerVault.MinOutBelowFloor.selector);
        vault.execute(address(router), floor - 1, callData);
    }

    // ─── execute: Fee-/Slippage-Snapshot ──────────────────────────────────────

    function test_execute_ignoresFeeAndSlippageBpsChangeAfterSetup() public {
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);

        vm.startPrank(admin);
        factory.setFee(500);                       // deutlich höhere Gebühr
        factory.setMinFee(address(usdc), 5_000_000); // deutlich höhere Mindestgebühr
        factory.setMaxSlippageBps(2_000);          // deutlich großzügigere Toleranz
        vm.stopPrank();

        uint256 fee = _feeFor(AMOUNT); // weiterhin auf Basis des alten Snapshots (99 bps)
        uint256 netIn = AMOUNT - fee;
        uint256 floor = _expectedBuyFloor(netIn, DEFAULT_TRIGGER_PRICE, 6, 8, DEFAULT_MAX_SLIPPAGE_BPS);

        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), netIn, address(wbtc), floor, owner);

        uint256 keeperBalanceBefore = usdc.balanceOf(keeper);
        vm.prank(keeper);
        vault.execute(address(router), floor, callData);

        assertEq(usdc.balanceOf(keeper), keeperBalanceBefore + fee);
        assertEq(vault.snapshotFeeBps(), DEFAULT_FEE_BPS);
        assertEq(vault.snapshotMaxSlippageBps(), DEFAULT_MAX_SLIPPAGE_BPS);
    }

    function test_execute_sendsFeeToRotatedKeeper() public {
        address newKeeper = makeAddr("newTriggerKeeper");
        TriggerVault vault = _createBuyVaultWithPlan(AMOUNT, 0);

        vm.prank(admin);
        factory.setGlobalKeeper(newKeeper);

        uint256 fee = _feeFor(AMOUNT);
        uint256 netIn = AMOUNT - fee;
        uint256 floor = _expectedBuyFloor(netIn, DEFAULT_TRIGGER_PRICE, 6, 8, DEFAULT_MAX_SLIPPAGE_BPS);
        bytes memory callData = abi.encodeWithSelector(MockSquidRouter.swap.selector, address(usdc), netIn, address(wbtc), floor, owner);

        vm.prank(owner);
        vault.execute(address(router), floor, callData);

        assertEq(usdc.balanceOf(newKeeper), fee);
        assertEq(usdc.balanceOf(keeper), 0);
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

    function test_setFee_updatesFee() public {
        vm.prank(admin);
        factory.setFee(200);
        assertEq(factory.feeBps(), 200);
    }

    function test_setFee_revertsAboveHardCap() public {
        vm.prank(admin);
        vm.expectRevert(TriggerVaultFactory.FeeTooHigh.selector);
        factory.setFee(501);
    }

    function test_setFee_revertsForNonAdmin() public {
        vm.prank(hacker);
        vm.expectRevert(TriggerVaultFactory.NotAdmin.selector);
        factory.setFee(100);
    }

    function test_setAdmin_updatesAdmin() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        factory.setAdmin(newAdmin);
        assertEq(factory.admin(), newAdmin);
    }

    // ─── setMinFee (Plan 4 Befund A: jetzt pro Token statt global) ────────────

    function test_setMinFee_isPerToken() public {
        vm.startPrank(admin);
        factory.setMinFee(address(usdc), 9_000);
        factory.setMinFee(address(wbtc), 15);
        vm.stopPrank();

        assertEq(factory.minFeeByToken(address(usdc)), 9_000);
        assertEq(factory.minFeeByToken(address(wbtc)), 15);
    }

    function test_setMinFee_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MinFeeUpdated(address(usdc), 9_000);
        vm.prank(admin);
        factory.setMinFee(address(usdc), 9_000);
    }

    function test_setMinFee_revertsForNonAdmin() public {
        vm.prank(hacker);
        vm.expectRevert(TriggerVaultFactory.NotAdmin.selector);
        factory.setMinFee(address(usdc), 9_000);
    }

    function test_setMinFee_revertsIfExceedsDecimalsScaledCap() public {
        // usdc hat 6 Decimals, siehe setUp() — Cap ist 5 volle Einheiten.
        uint256 cap = factory.MAX_MIN_FEE_WHOLE_UNITS() * 1e6;
        vm.prank(admin);
        vm.expectRevert(TriggerVaultFactory.MinFeeTooHigh.selector);
        factory.setMinFee(address(usdc), cap + 1);
    }

    function test_setMinFee_allowsExactDecimalsScaledCap() public {
        uint256 cap = factory.MAX_MIN_FEE_WHOLE_UNITS() * 1e6;
        vm.prank(admin);
        factory.setMinFee(address(usdc), cap);
        assertEq(factory.minFeeByToken(address(usdc)), cap);
    }

    function test_setMinFee_capScalesWithTokenDecimals() public {
        // wbtc hat 8 Decimals, siehe setUp() — derselbe "5 volle Einheiten"-Cap
        // erlaubt daher einen anderen Rohwert als bei usdc (6 Decimals).
        uint256 cap = factory.MAX_MIN_FEE_WHOLE_UNITS() * 1e8;
        vm.startPrank(admin);
        factory.setMinFee(address(wbtc), cap);
        vm.expectRevert(TriggerVaultFactory.MinFeeTooHigh.selector);
        factory.setMinFee(address(wbtc), cap + 1);
        vm.stopPrank();
    }

    function test_setMinFee_skipsCapForTokenWithoutDecimals() public {
        // hacker ist ein reiner makeAddr()-Platzhalter ohne Contract-Code —
        // decimals() reverted, der Cap greift bewusst nicht (siehe try/catch
        // in TriggerVaultFactory.setMinFee()).
        vm.prank(admin);
        factory.setMinFee(hacker, type(uint256).max);
        assertEq(factory.minFeeByToken(hacker), type(uint256).max);
    }

    // ─── Reviewer-Reproduktion: wBTC-Sell-Mindestgebühr vor/nach dem Fix ──────
    //
    // Reproduziert exakt den in der Zweitreview (01.09.2026) gemeldeten Fall:
    // beim alten globalen 35_000-Skalar wären das bei 0,001 wBTC (8 Decimals)
    // 35 % Gebühr trotz nominell 0,99 % feeBps. Mit dem neuen, korrekt
    // skalierten Wert aus setUp() (DEFAULT_MIN_FEE_WBTC = 50) bleibt die
    // effektive Gebühr für dieselbe Trade-Größe fair.
    function test_execute_sellDirection_minFeeIsFairForSmallWbtcTrade() public {
        uint256 smallSellAmount = 0.001e8; // 0,001 wBTC
        wbtc.mint(owner, smallSellAmount);
        usdc.mint(address(router), 100e6);

        TriggerVault vault = _createVault();
        vm.prank(owner);
        wbtc.approve(address(vault), smallSellAmount);
        vm.prank(owner);
        vault.setupPlan(address(wbtc), address(usdc), address(wbtc), smallSellAmount, true, 75_000e8, 0);

        // Mit dem alten globalen Skalar (35_000) wäre das ~35 % gewesen —
        // (35_000 / 100_000 raw) = 35 %. Mit dem neuen, wBTC-skalierten Wert
        // (50) ist die effektive Gebühr wieder nahe am nominellen feeBps.
        uint256 percentageFee = (smallSellAmount * DEFAULT_FEE_BPS) / 10_000;
        uint256 expectedFee = percentageFee < DEFAULT_MIN_FEE_WBTC ? DEFAULT_MIN_FEE_WBTC : percentageFee;
        uint256 effectiveFeeBps = (expectedFee * 10_000) / smallSellAmount;

        assertLt(effectiveFeeBps, 200); // deutlich unter 2 %, nicht 35 % wie im Reviewer-Fall
        assertEq(vault.snapshotMinFee(), DEFAULT_MIN_FEE_WBTC);
    }

    function test_constructor_setsDefaultMaxSlippageBps() public view {
        assertEq(factory.maxSlippageBps(), DEFAULT_MAX_SLIPPAGE_BPS);
    }

    function test_setMaxSlippageBps_success() public {
        vm.prank(admin);
        factory.setMaxSlippageBps(500);
        assertEq(factory.maxSlippageBps(), 500);
    }

    function test_setMaxSlippageBps_revertsAboveCap() public {
        uint16 cap = factory.MAX_SLIPPAGE_BPS_CAP();
        vm.prank(admin);
        vm.expectRevert(TriggerVaultFactory.SlippageBpsTooHigh.selector);
        factory.setMaxSlippageBps(cap + 1);
    }

    function test_setMaxSlippageBps_allowsExactCap() public {
        uint16 cap = factory.MAX_SLIPPAGE_BPS_CAP();
        vm.prank(admin);
        factory.setMaxSlippageBps(cap);
        assertEq(factory.maxSlippageBps(), cap);
    }

    function test_setMaxSlippageBps_revertsForNonAdmin() public {
        vm.prank(hacker);
        vm.expectRevert(TriggerVaultFactory.NotAdmin.selector);
        factory.setMaxSlippageBps(500);
    }

    function test_setStablecoin_success() public {
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        assertFalse(factory.isStablecoin(address(dai)));
        vm.prank(admin);
        factory.setStablecoin(address(dai), true);
        assertTrue(factory.isStablecoin(address(dai)));
    }

    function test_setStablecoin_revertsForNonAdmin() public {
        vm.prank(hacker);
        vm.expectRevert(TriggerVaultFactory.NotAdmin.selector);
        factory.setStablecoin(address(wbtc), true);
    }

    // ─── setGlobalKeeper ─────────────────────────────────────────────────────

    function test_setGlobalKeeper_success() public {
        address newKeeper = makeAddr("newTriggerKeeper");
        vm.prank(admin);
        factory.setGlobalKeeper(newKeeper);
        assertEq(factory.globalKeeper(), newKeeper);
    }

    function test_setGlobalKeeper_revertsIfNotAdmin() public {
        vm.prank(hacker);
        vm.expectRevert(TriggerVaultFactory.NotAdmin.selector);
        factory.setGlobalKeeper(makeAddr("newTriggerKeeper"));
    }

    function test_setGlobalKeeper_revertsOnZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(TriggerVaultFactory.InvalidAddress.selector);
        factory.setGlobalKeeper(address(0));
    }

    function test_setGlobalKeeper_affectsNewVaultsOnly() public {
        TriggerVault vaultA = _createVault();

        address newKeeper = makeAddr("newTriggerKeeper");
        vm.prank(admin);
        factory.setGlobalKeeper(newKeeper);

        TriggerVault vaultB = _createVault();

        assertTrue(vaultA.isKeeper(keeper));
        assertFalse(vaultA.isKeeper(newKeeper));

        assertTrue(vaultB.isKeeper(newKeeper));
        assertFalse(vaultB.isKeeper(keeper));
    }
}
