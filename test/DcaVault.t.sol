// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DcaVault} from "../contracts/DcaVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSquidRouter} from "./mocks/MockSquidRouter.sol";

/// @notice Vollständige Test-Suite für DcaVault.
///
/// Ausführen:    forge test -vvv
/// Mit Coverage: forge coverage
/// Einzelner Test: forge test --match-test test_setupPlan_success -vvv

contract DcaVaultTest is Test {

    // ─── Contracts ───────────────────────────────────────────────────────────

    DcaVault         vaultImplementation;
    DcaVault         vault;
    MockERC20        usdc;
    MockERC20        weth;
    MockERC20        celo;
    MockSquidRouter  router;

    // ─── Adressen ────────────────────────────────────────────────────────────

    address owner        = makeAddr("owner");
    address keeper       = makeAddr("keeper");
    address hacker       = makeAddr("hacker");
    address globalKeeper = makeAddr("globalKeeper");

    // ─── Test-Parameter ──────────────────────────────────────────────────────

    uint256 constant TOTAL_AMOUNT   = 100e6;  // 100 USDC (6 Decimals)
    uint32  constant DURATION       = 10;     // 10 Tranchen
    uint256 constant INTERVAL       = 1 days;
    uint256 constant TRANCHE_AMOUNT = TOTAL_AMOUNT / DURATION; // 10 USDC

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        // Mock-Contracts deployen
        usdc   = new MockERC20("USD Coin",    "USDC", 6);
        weth   = new MockERC20("Wrapped ETH", "WETH", 18);
        celo   = new MockERC20("Celo",        "CELO", 18);
        router = new MockSquidRouter();

        // Master-Implementation deployen, Clone ziehen, initialisieren
        // (initialize() whitelistet den übergebenen Router automatisch).
        vaultImplementation = new DcaVault();
        vault = DcaVault(Clones.clone(address(vaultImplementation)));
        vault.initialize(owner, address(router), globalKeeper);

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
        address[] memory targets = new address[](2);
        uint16[]  memory bps     = new uint16[](2);

        targets[0] = address(weth);
        targets[1] = address(celo);
        bps[0]     = 5000; // 50%
        bps[1]     = 5000; // 50%

        vm.startPrank(owner);
        usdc.approve(address(vault), totalAmount);
        vault.setupPlan(
            address(usdc),
            totalAmount,
            duration,
            interval,
            firstExecution,
            targets,
            bps
        );
        vm.stopPrank();
    }

    /// @notice Baut routers[]/minAmountsOut[]/squidCallData[] für executeStep,
    ///         passend zum 50/50-Split aus _approveAndSetup. `amountForThisStep`
    ///         muss dem vom Vault intern berechneten Betrag für diesen Schritt
    ///         entsprechen (trancheAmount, oder bei letztem Schritt der volle
    ///         Restbestand), damit die simulierte transferFrom-Menge im Mock
    ///         zur tatsächlich freigegebenen Allowance passt.
    function _executeStepArgs(uint256 amountForThisStep, uint256 outAmount0, uint256 outAmount1)
        internal
        view
        returns (address[] memory routers, uint256[] memory minOut, bytes[] memory callData)
    {
        uint256 amountIn0 = amountForThisStep / 2;
        uint256 amountIn1 = amountForThisStep - amountIn0;

        routers = new address[](2);
        routers[0] = address(router);
        routers[1] = address(router);

        minOut = new uint256[](2);
        minOut[0] = outAmount0;
        minOut[1] = outAmount1;

        callData = new bytes[](2);
        callData[0] = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(usdc), amountIn0, address(weth), outAmount0, owner
        );
        callData[1] = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(usdc), amountIn1, address(celo), outAmount1, owner
        );
    }

    // ─── initialize Tests ────────────────────────────────────────────────────

    function test_initialize_setsOwnerAndWhitelistsRouter() public view {
        assertEq(vault.owner(), owner);
        assertTrue(vault.approvedRouters(address(router)));
    }

    function test_initialize_authorizesGlobalKeeper() public view {
        assertTrue(vault.isKeeper(globalKeeper));
    }

    function test_initialize_revertsOnZeroOwner() public {
        DcaVault freshClone = DcaVault(Clones.clone(address(vaultImplementation)));
        vm.expectRevert(DcaVault.InvalidAddress.selector);
        freshClone.initialize(address(0), address(router), globalKeeper);
    }

    function test_initialize_revertsOnZeroRouter() public {
        DcaVault freshClone = DcaVault(Clones.clone(address(vaultImplementation)));
        vm.expectRevert(DcaVault.InvalidAddress.selector);
        freshClone.initialize(owner, address(0), globalKeeper);
    }

    function test_initialize_revertsOnZeroGlobalKeeper() public {
        DcaVault freshClone = DcaVault(Clones.clone(address(vaultImplementation)));
        vm.expectRevert(DcaVault.InvalidAddress.selector);
        freshClone.initialize(owner, address(router), address(0));
    }

    function test_initialize_revertsIfCloneAlreadyInitialized() public {
        vm.expectRevert(DcaVault.AlreadyInitialized.selector);
        vault.initialize(owner, address(router), globalKeeper);
    }

    function test_initialize_revertsOnImplementationDirectly() public {
        // Der Constructor sperrt die rohe Implementation gegen initialize() —
        // Standard-Absicherung bei Clone-Factories.
        vm.expectRevert(DcaVault.AlreadyInitialized.selector);
        vaultImplementation.initialize(owner, address(router), globalKeeper);
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

        vm.startPrank(owner);
        usdc.approve(address(vault), TOTAL_AMOUNT);

        address[] memory targets = new address[](2);
        uint16[]  memory bps     = new uint16[](2);
        targets[0] = address(weth); targets[1] = address(celo);
        bps[0] = 5000; bps[1] = 5000;

        vm.expectEmit(true, true, false, true, address(vault));
        emit DcaPlanCreated(
            owner, address(usdc), TOTAL_AMOUNT, TRANCHE_AMOUNT,
            DURATION, INTERVAL, firstExecution
        );

        vault.setupPlan(address(usdc), TOTAL_AMOUNT, DURATION, INTERVAL,
            firstExecution, targets, bps);
        vm.stopPrank();
    }

    event DcaPlanCreated(
        address indexed owner,
        address indexed inputToken,
        uint256 totalAmount,
        uint256 trancheAmount,
        uint32  totalSteps,
        uint256 interval,
        uint256 firstExecutionTimestamp
    );

    function test_setupPlan_revertsIfNotOwner() public {
        address[] memory targets = new address[](1);
        uint16[]  memory bps     = new uint16[](1);
        targets[0] = address(weth); bps[0] = 10000;

        vm.prank(hacker);
        vm.expectRevert(DcaVault.NotOwner.selector);
        vault.setupPlan(address(usdc), TOTAL_AMOUNT, DURATION, INTERVAL,
            block.timestamp + 1, targets, bps);
    }

    function test_setupPlan_revertsIfAlreadyInitialized() public {
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 1 hours);

        // vm.expectRevert muss unmittelbar vor dem revertierenden Call stehen.
        address[] memory targets = new address[](2);
        uint16[]  memory bps     = new uint16[](2);
        targets[0] = address(weth); targets[1] = address(celo);
        bps[0] = 5000; bps[1] = 5000;

        vm.startPrank(owner);
        usdc.approve(address(vault), TOTAL_AMOUNT);
        vm.expectRevert(DcaVault.AlreadyInitialized.selector);
        vault.setupPlan(
            address(usdc), TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 2 hours,
            targets, bps
        );
        vm.stopPrank();
    }

    function test_setupPlan_revertsOnInvalidAllocation() public {
        address[] memory targets = new address[](2);
        uint16[]  memory bps     = new uint16[](2);

        targets[0] = address(weth); targets[1] = address(celo);
        bps[0] = 4000; bps[1] = 4000; // nur 80% statt 100%

        vm.startPrank(owner);
        usdc.approve(address(vault), TOTAL_AMOUNT);
        vm.expectRevert(DcaVault.AllocationInvalid.selector);
        vault.setupPlan(address(usdc), TOTAL_AMOUNT, DURATION, INTERVAL,
            block.timestamp + 1, targets, bps);
        vm.stopPrank();
    }

    function test_setupPlan_revertsOnDuplicateTarget() public {
        address[] memory targets = new address[](2);
        uint16[]  memory bps     = new uint16[](2);

        targets[0] = address(weth); targets[1] = address(weth); // Duplikat!
        bps[0] = 5000; bps[1] = 5000;

        vm.startPrank(owner);
        usdc.approve(address(vault), TOTAL_AMOUNT);
        vm.expectRevert(DcaVault.DuplicateTarget.selector);
        vault.setupPlan(address(usdc), TOTAL_AMOUNT, DURATION, INTERVAL,
            block.timestamp + 1, targets, bps);
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

    // ─── setRouter Tests ─────────────────────────────────────────────────────

    function test_setRouter_success() public {
        address newRouter = makeAddr("newRouter");

        vm.prank(owner);
        vault.setRouter(newRouter, true);

        assertTrue(vault.approvedRouters(newRouter));
    }

    function test_setRouter_revertsIfNotOwner() public {
        vm.prank(hacker);
        vm.expectRevert(DcaVault.NotOwner.selector);
        vault.setRouter(makeAddr("newRouter"), true);
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

        // Vault-Wert vor dem Step lesen — dieser ist eine feste Zahl aus Storage
        // und wird vom Optimizer nicht via block.timestamp re-evaluiert.
        uint256 nextTsBefore = vault.nextExecutionTimestamp();

        (address[] memory routers, uint256[] memory minOut, bytes[] memory callData) =
            _executeStepArgs(TRANCHE_AMOUNT, 1e18, 1e18);

        vm.prank(owner);
        vault.executeStep(routers, minOut, callData);

        assertEq(vault.currentStep(), 1);
        assertEq(vault.nextExecutionTimestamp(), nextTsBefore + INTERVAL);
        assertEq(vault.remainingSteps(), DURATION - 1);
    }

    function test_executeStep_revertsIfTooEarly() public {
        uint256 firstExecution = block.timestamp + 1 days;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);

        (address[] memory routers, uint256[] memory minOut, bytes[] memory callData) =
            _executeStepArgs(TRANCHE_AMOUNT, 1e18, 1e18);

        vm.prank(owner);
        vm.expectRevert(DcaVault.TooEarly.selector);
        vault.executeStep(routers, minOut, callData);
    }

    function test_executeStep_revertsIfNotExecutor() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        (address[] memory routers, uint256[] memory minOut, bytes[] memory callData) =
            _executeStepArgs(TRANCHE_AMOUNT, 1e18, 1e18);

        vm.prank(hacker);
        vm.expectRevert(DcaVault.NotExecutor.selector);
        vault.executeStep(routers, minOut, callData);
    }

    function test_executeStep_keeperCanExecute() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        vm.prank(owner);
        vault.setKeeper(keeper, true);

        (address[] memory routers, uint256[] memory minOut, bytes[] memory callData) =
            _executeStepArgs(TRANCHE_AMOUNT, 1e18, 1e18);

        vm.prank(keeper);
        vault.executeStep(routers, minOut, callData);

        assertEq(vault.currentStep(), 1);
    }

    function test_executeStep_lastStepUsesFullBalance() public {
        // Nur 1 Schritt — gesamtes Guthaben wird verwendet
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, 1, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        (address[] memory routers, uint256[] memory minOut, bytes[] memory callData) =
            _executeStepArgs(TOTAL_AMOUNT, 1e18, 1e18);

        vm.prank(owner);
        vault.executeStep(routers, minOut, callData);

        assertEq(vault.currentStep(), 1);
        assertEq(vault.remainingSteps(), 0);
    }

    function test_executeStep_revertsAfterComplete() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, 1, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        (address[] memory routers, uint256[] memory minOut, bytes[] memory callData) =
            _executeStepArgs(TOTAL_AMOUNT, 1e18, 1e18);

        vm.startPrank(owner);
        vault.executeStep(routers, minOut, callData);

        vm.expectRevert(DcaVault.PlanComplete.selector);
        vault.executeStep(routers, minOut, callData);
        vm.stopPrank();
    }

    function test_executeStep_revertsIfRouterNotApproved() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        (address[] memory routers, uint256[] memory minOut, bytes[] memory callData) =
            _executeStepArgs(TRANCHE_AMOUNT, 1e18, 1e18);
        routers[0] = makeAddr("unapprovedRouter"); // nie via setRouter freigegeben

        vm.prank(owner);
        vm.expectRevert(DcaVault.RouterNotApproved.selector);
        vault.executeStep(routers, minOut, callData);
    }

    function test_executeStep_revertsOnSlippage() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        // Mock liefert 1 wei WETH, aber minAmountsOut verlangt 1e18
        uint256 amountIn0 = TRANCHE_AMOUNT / 2;
        uint256 amountIn1 = TRANCHE_AMOUNT - amountIn0;

        address[] memory routers = new address[](2);
        routers[0] = address(router);
        routers[1] = address(router);

        uint256[] memory minOut = new uint256[](2);
        minOut[0] = 1e18; // verlangt viel
        minOut[1] = 1;

        bytes[] memory callData = new bytes[](2);
        callData[0] = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(usdc), amountIn0, address(weth), 1, owner // liefert nur 1 wei
        );
        callData[1] = abi.encodeWithSelector(
            MockSquidRouter.swap.selector, address(usdc), amountIn1, address(celo), 1, owner
        );

        vm.prank(owner);
        vm.expectRevert(DcaVault.SlippageExceeded.selector);
        vault.executeStep(routers, minOut, callData);
    }

    function test_executeStep_revertsOnSwapFailed() public {
        uint256 firstExecution = block.timestamp + 1 hours;
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, firstExecution);
        vm.warp(firstExecution);

        router.setShouldFail(true);

        (address[] memory routers, uint256[] memory minOut, bytes[] memory callData) =
            _executeStepArgs(TRANCHE_AMOUNT, 1e18, 1e18);

        vm.prank(owner);
        vm.expectRevert(DcaVault.SwapFailed.selector);
        vault.executeStep(routers, minOut, callData);
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
        emit PlanCancelled(TOTAL_AMOUNT);

        vm.prank(owner);
        vault.cancelPlan();
    }

    function test_cancelPlan_revertsIfAlreadyCancelled() public {
        _approveAndSetup(TOTAL_AMOUNT, DURATION, INTERVAL, block.timestamp + 1 hours);

        vm.startPrank(owner);
        vault.cancelPlan();

        vm.expectRevert(DcaVault.PlanAlreadyCancelled.selector);
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
        assertEq(configs.length,   2);
        assertEq(configs[0].token, address(weth));
        assertEq(configs[0].bps,   5000);
        assertEq(configs[1].token, address(celo));
        assertEq(configs[1].bps,   5000);
    }

    // ─── Fuzz Tests ──────────────────────────────────────────────────────────

    /// @notice Testet dass trancheAmount immer ≤ totalAmount / duration ist.
    function testFuzz_trancheAmount(uint32 duration) public {
        vm.assume(duration >= 1 && duration <= 365);
        uint256 amount = uint256(duration) * 1e6; // Mindestbetrag: 1 USDC pro Tranche

        address[] memory targets = new address[](1);
        uint16[]  memory bps     = new uint16[](1);
        targets[0] = address(weth); bps[0] = 10000;

        usdc.mint(owner, amount);

        vm.startPrank(owner);
        usdc.approve(address(vault), amount);
        vault.setupPlan(address(usdc), amount, duration, INTERVAL,
            block.timestamp + 1, targets, bps);
        vm.stopPrank();

        assertEq(vault.trancheAmount(), amount / duration);
        assertLe(vault.trancheAmount() * duration, amount);
    }
    event PlanCancelled(uint256 remainingBalance);
}
