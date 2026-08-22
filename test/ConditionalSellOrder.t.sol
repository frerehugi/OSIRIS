// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {ConditionalSellOrder} from "../contracts/ConditionalSellOrder.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSquidRouter} from "./mocks/MockSquidRouter.sol";

/// @notice Test-Suite für ConditionalSellOrder (Apis).
///
/// Ausführen:    forge test --match-contract ConditionalSellOrderTest -vvv

contract ConditionalSellOrderTest is Test {

    ConditionalSellOrder sellOrder;
    MockERC20       wbtc;
    MockERC20       usdc;
    MockSquidRouter router;

    address owner    = makeAddr("owner");
    address keeper   = makeAddr("keeper");
    address hacker   = makeAddr("hacker");
    address admin    = makeAddr("admin");
    address treasury = makeAddr("treasury");

    uint256 constant WBTC_BALANCE = 1e8; // 1 wBTC (8 Decimals)
    uint16  constant DEFAULT_FEE_BPS = 99;
    uint256 constant DEFAULT_MIN_FEE = 35_000;

    function setUp() public {
        wbtc   = new MockERC20("Wrapped BTC", "wBTC", 8);
        usdc   = new MockERC20("USD Coin",    "USDC", 6);
        router = new MockSquidRouter();

        sellOrder = new ConditionalSellOrder(address(router), admin, treasury);

        wbtc.mint(owner, WBTC_BALANCE);
        usdc.mint(address(router), 1_000_000e6);
    }

    // ─── Hilfsfunktionen ─────────────────────────────────────────────────────

    function _feeFor(uint256 amount) internal pure returns (uint256) {
        uint256 fee = (amount * DEFAULT_FEE_BPS) / 10_000;
        return fee < DEFAULT_MIN_FEE ? DEFAULT_MIN_FEE : fee;
    }

    function _createOrder(uint16 bps, uint32 maxExecutions) internal returns (uint256 orderId) {
        vm.prank(owner);
        orderId = sellOrder.createOrder(address(wbtc), address(usdc), bps, maxExecutions);
    }

    function _approve() internal {
        vm.prank(owner);
        wbtc.approve(address(sellOrder), type(uint256).max);
    }

    // ─── createOrder ─────────────────────────────────────────────────────────

    function test_createOrder_storesFields() public {
        uint256 orderId = _createOrder(5000, 1); // 50%, einmalig
        ConditionalSellOrder.SellOrder memory order = sellOrder.getOrder(orderId);

        assertEq(order.owner, owner);
        assertEq(order.sellToken, address(wbtc));
        assertEq(order.targetToken, address(usdc));
        assertEq(order.bps, 5000);
        assertEq(order.maxExecutions, 1);
        assertEq(order.executedCount, 0);
        assertFalse(order.cancelled);
    }

    function test_createOrder_incrementsOrderId() public {
        uint256 first  = _createOrder(5000, 1);
        uint256 second = _createOrder(2500, 1);
        assertEq(second, first + 1);
    }

    function test_createOrder_revertsOnSameToken() public {
        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.SameToken.selector);
        sellOrder.createOrder(address(wbtc), address(wbtc), 5000, 1);
    }

    function test_createOrder_revertsOnZeroBps() public {
        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.InvalidBps.selector);
        sellOrder.createOrder(address(wbtc), address(usdc), 0, 1);
    }

    function test_createOrder_revertsOnBpsAboveMax() public {
        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.InvalidBps.selector);
        sellOrder.createOrder(address(wbtc), address(usdc), 10_001, 1);
    }

    function test_createOrder_revertsOnZeroMaxExecutions() public {
        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.InvalidBps.selector);
        sellOrder.createOrder(address(wbtc), address(usdc), 5000, 0);
    }

    // ─── cancelOrder ─────────────────────────────────────────────────────────

    function test_cancelOrder_setsCancelled() public {
        uint256 orderId = _createOrder(5000, 1);
        vm.prank(owner);
        sellOrder.cancelOrder(orderId);
        assertTrue(sellOrder.getOrder(orderId).cancelled);
    }

    function test_cancelOrder_revertsForNonOwner() public {
        uint256 orderId = _createOrder(5000, 1);
        vm.prank(hacker);
        vm.expectRevert(ConditionalSellOrder.NotOwner.selector);
        sellOrder.cancelOrder(orderId);
    }

    function test_cancelOrder_revertsIfAlreadyCancelled() public {
        uint256 orderId = _createOrder(5000, 1);
        vm.startPrank(owner);
        sellOrder.cancelOrder(orderId);
        vm.expectRevert(ConditionalSellOrder.OrderAlreadyCancelled.selector);
        sellOrder.cancelOrder(orderId);
        vm.stopPrank();
    }

    // ─── execute — Zugriffskontrolle ────────────────────────────────────────

    function test_execute_ownerCanExecuteDirectly() public {
        _approve();
        uint256 orderId = _createOrder(5000, 1);
        uint256 amount  = WBTC_BALANCE / 2;
        uint256 outAmount = 30_000e6;

        bytes memory callData = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(wbtc), amount - _feeFor(amount), address(usdc), outAmount, owner
        );

        vm.prank(owner);
        sellOrder.execute(orderId, address(router), outAmount, callData);

        assertEq(sellOrder.getOrder(orderId).executedCount, 1);
    }

    function test_execute_revertsForUnauthorizedCaller() public {
        _approve();
        uint256 orderId = _createOrder(5000, 1);
        vm.prank(hacker);
        vm.expectRevert(ConditionalSellOrder.NotExecutor.selector);
        sellOrder.execute(orderId, address(router), 1, "");
    }

    function test_execute_keeperNeedsPerOwnerApproval() public {
        _approve();
        uint256 orderId = _createOrder(5000, 1);

        vm.prank(keeper);
        vm.expectRevert(ConditionalSellOrder.NotExecutor.selector);
        sellOrder.execute(orderId, address(router), 1, "");

        vm.prank(owner);
        sellOrder.setKeeper(keeper, true);

        uint256 amount = WBTC_BALANCE / 2;
        uint256 outAmount = 30_000e6;
        bytes memory callData = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(wbtc), amount - _feeFor(amount), address(usdc), outAmount, owner
        );

        vm.prank(keeper);
        sellOrder.execute(orderId, address(router), outAmount, callData);
        assertEq(sellOrder.getOrder(orderId).executedCount, 1);
    }

    function test_execute_keeperApprovalIsPerOwnerNotGlobal() public {
        // Ein für owner freigegebener Keeper darf nicht automatisch Orders
        // eines anderen Owners ausführen.
        _approve();
        vm.prank(owner);
        sellOrder.setKeeper(keeper, true);

        address otherOwner = makeAddr("otherOwner");
        wbtc.mint(otherOwner, WBTC_BALANCE);
        vm.prank(otherOwner);
        wbtc.approve(address(sellOrder), type(uint256).max);
        vm.prank(otherOwner);
        uint256 otherOrderId = sellOrder.createOrder(address(wbtc), address(usdc), 5000, 1);

        vm.prank(keeper);
        vm.expectRevert(ConditionalSellOrder.NotExecutor.selector);
        sellOrder.execute(otherOrderId, address(router), 1, "");
    }

    // ─── execute — Beträge, Gebühr, Slippage ────────────────────────────────

    function test_execute_computesAmountFromCurrentBalanceAtExecutionTime() public {
        // 50% eines Bestands, der SICH ZWISCHEN Order-Erstellung und Ausführung
        // ändert — amount muss auf dem aktuellen, nicht dem ursprünglichen
        // Bestand basieren.
        _approve();
        uint256 orderId = _createOrder(5000, 1);

        wbtc.mint(owner, WBTC_BALANCE); // Bestand verdoppelt sich vor der Ausführung
        uint256 currentBalance = wbtc.balanceOf(owner);
        uint256 expectedAmount = currentBalance / 2;
        uint256 outAmount = 60_000e6;

        bytes memory callData = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(wbtc), expectedAmount - _feeFor(expectedAmount), address(usdc), outAmount, owner
        );

        vm.prank(owner);
        sellOrder.execute(orderId, address(router), outAmount, callData);
    }

    function test_execute_chargesFeeToTreasury() public {
        _approve();
        uint256 orderId = _createOrder(10_000, 1); // 100%
        uint256 amount  = WBTC_BALANCE;
        uint256 fee     = _feeFor(amount);
        uint256 outAmount = 55_000e6;

        bytes memory callData = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(wbtc), amount - fee, address(usdc), outAmount, owner
        );

        vm.prank(owner);
        sellOrder.execute(orderId, address(router), outAmount, callData);

        assertEq(wbtc.balanceOf(treasury), fee);
    }

    function test_execute_revertsOnSlippageExceeded() public {
        _approve();
        uint256 orderId = _createOrder(10_000, 1);
        uint256 amount  = WBTC_BALANCE;
        uint256 outAmount = 50_000e6;
        uint256 minOut  = outAmount + 1; // fordert mehr, als der Mock liefert

        bytes memory callData = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(wbtc), amount - _feeFor(amount), address(usdc), outAmount, owner
        );

        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.SlippageExceeded.selector);
        sellOrder.execute(orderId, address(router), minOut, callData);
    }

    function test_execute_revertsOnZeroMinAmountOut() public {
        _approve();
        uint256 orderId = _createOrder(5000, 1);
        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.MinOutRequired.selector);
        sellOrder.execute(orderId, address(router), 0, "");
    }

    function test_execute_revertsOnUnapprovedRouter() public {
        _approve();
        uint256 orderId = _createOrder(5000, 1);
        address randomRouter = makeAddr("randomRouter");
        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.RouterNotApproved.selector);
        sellOrder.execute(orderId, randomRouter, 1, "");
    }

    function test_execute_ownerCanApproveAdditionalRouter() public {
        _approve();
        MockSquidRouter secondRouter = new MockSquidRouter();
        usdc.mint(address(secondRouter), 1_000_000e6);

        uint256 orderId = _createOrder(5000, 1);
        vm.prank(owner);
        sellOrder.setRouter(address(secondRouter), true);

        uint256 amount = WBTC_BALANCE / 2;
        uint256 outAmount = 30_000e6;
        bytes memory callData = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(wbtc), amount - _feeFor(amount), address(usdc), outAmount, owner
        );

        vm.prank(owner);
        sellOrder.execute(orderId, address(secondRouter), outAmount, callData);
        assertEq(sellOrder.getOrder(orderId).executedCount, 1);
    }

    function test_execute_revertsOnSwapFailure() public {
        _approve();
        uint256 orderId = _createOrder(5000, 1);
        router.setShouldFail(true);
        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.SwapFailed.selector);
        sellOrder.execute(orderId, address(router), 1, abi.encodeWithSelector(MockSquidRouter.swap.selector, address(wbtc), 1, address(usdc), 1, owner));
    }

    function test_execute_revertsOnZeroBalance() public {
        _approve();
        vm.prank(owner);
        wbtc.transfer(hacker, wbtc.balanceOf(owner)); // Bestand auf 0 leeren
        uint256 orderId = _createOrder(5000, 1);
        vm.prank(owner);
        vm.expectRevert(ConditionalSellOrder.NothingToSell.selector);
        sellOrder.execute(orderId, address(router), 1, "");
    }

    // ─── execute — maxExecutions / Order-Abschluss ──────────────────────────

    function test_execute_autoCancelsAfterMaxExecutionsReached() public {
        _approve();
        uint256 orderId = _createOrder(1000, 1); // 10%, einmalig

        uint256 amount = (WBTC_BALANCE * 1000) / 10_000;
        uint256 outAmount = 6_000e6;
        bytes memory callData = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(wbtc), amount - _feeFor(amount), address(usdc), outAmount, owner
        );

        vm.prank(owner);
        sellOrder.execute(orderId, address(router), outAmount, callData);

        ConditionalSellOrder.SellOrder memory order = sellOrder.getOrder(orderId);
        assertTrue(order.cancelled);
        assertFalse(sellOrder.canExecute(orderId));
    }

    function test_execute_revertsIfAlreadyComplete() public {
        _approve();
        uint256 orderId = _createOrder(1000, 1);
        uint256 amount = (WBTC_BALANCE * 1000) / 10_000;
        uint256 outAmount = 6_000e6;
        bytes memory callData = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(wbtc), amount - _feeFor(amount), address(usdc), outAmount, owner
        );

        vm.startPrank(owner);
        sellOrder.execute(orderId, address(router), outAmount, callData);
        vm.expectRevert(ConditionalSellOrder.OrderAlreadyCancelled.selector);
        sellOrder.execute(orderId, address(router), outAmount, callData);
        vm.stopPrank();
    }

    function test_execute_allowsMultipleExecutionsUpToMax() public {
        _approve();
        uint256 orderId = _createOrder(1000, 3); // 10 % je Ausführung, bis zu 3x

        for (uint256 i = 0; i < 3; i++) {
            uint256 balance = wbtc.balanceOf(owner);
            uint256 amount  = (balance * 1000) / 10_000;
            uint256 outAmount = 1_000e6;
            bytes memory callData = abi.encodeWithSelector(
                MockSquidRouter.swap.selector, address(wbtc), amount - _feeFor(amount), address(usdc), outAmount, owner
            );
            vm.prank(owner);
            sellOrder.execute(orderId, address(router), outAmount, callData);
        }

        ConditionalSellOrder.SellOrder memory order = sellOrder.getOrder(orderId);
        assertEq(order.executedCount, 3);
        assertTrue(order.cancelled); // nach der 3. (letzten) Ausführung abgeschlossen
    }

    // ─── Admin-Funktionen ────────────────────────────────────────────────────

    function test_setFee_updatesFeeAndMinFee() public {
        vm.prank(admin);
        sellOrder.setFee(200, 50_000);
        assertEq(sellOrder.feeBps(), 200);
        assertEq(sellOrder.minFee(), 50_000);
    }

    function test_setFee_revertsAboveHardCap() public {
        vm.prank(admin);
        vm.expectRevert(ConditionalSellOrder.FeeTooHigh.selector);
        sellOrder.setFee(501, 0);
    }

    function test_setFee_revertsForNonAdmin() public {
        vm.prank(hacker);
        vm.expectRevert(ConditionalSellOrder.NotAdmin.selector);
        sellOrder.setFee(100, 0);
    }

    function test_setTreasury_updatesTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(admin);
        sellOrder.setTreasury(newTreasury);
        assertEq(sellOrder.treasury(), newTreasury);
    }

    function test_setAdmin_updatesAdmin() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        sellOrder.setAdmin(newAdmin);
        assertEq(sellOrder.admin(), newAdmin);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(ConditionalSellOrder.InvalidAddress.selector);
        new ConditionalSellOrder(address(0), admin, treasury);

        vm.expectRevert(ConditionalSellOrder.InvalidAddress.selector);
        new ConditionalSellOrder(address(router), address(0), treasury);

        vm.expectRevert(ConditionalSellOrder.InvalidAddress.selector);
        new ConditionalSellOrder(address(router), admin, address(0));
    }

    function test_constructor_setsDefaultFeeToOsirisFloor() public view {
        assertEq(sellOrder.feeBps(), DEFAULT_FEE_BPS);
        assertEq(sellOrder.minFee(), DEFAULT_MIN_FEE);
    }
}
