// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SendVault} from "../contracts/SendVault.sol";
import {SendVaultFactory} from "../contracts/SendVaultFactory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";

/// @notice Test-Suite für SendVault (Auszahlungs-Vault, kein Swap).
///
/// Ausführen: forge test --match-contract SendVaultTest -vvv

contract SendVaultTest is Test {

    SendVault        implementation;
    SendVaultFactory factory;
    MockERC20        usdc;

    address owner  = makeAddr("owner");
    address keeper = makeAddr("keeper"); // == globalKeeper
    address hacker = makeAddr("hacker");
    address admin  = makeAddr("admin");
    address bob    = makeAddr("bob");
    address carol  = makeAddr("carol");

    uint16  constant DEFAULT_FEE_BPS = 49;
    uint256 constant DEFAULT_MIN_FEE = 9_000; // gesetzt in setUp() für usdc

    function setUp() public {
        usdc   = new MockERC20("USD Coin", "USDC", 6);
        implementation = new SendVault();
        factory = new SendVaultFactory(address(implementation), keeper, admin);

        vm.prank(admin);
        factory.setMinFee(address(usdc), DEFAULT_MIN_FEE);

        usdc.mint(owner, 1_000_000e6);
    }

    // ─── Hilfsfunktionen ─────────────────────────────────────────────────────

    function _feeFor(uint256 amt) internal pure returns (uint256) {
        uint256 fee = (amt * DEFAULT_FEE_BPS) / 10_000;
        return fee < DEFAULT_MIN_FEE ? DEFAULT_MIN_FEE : fee;
    }

    function _createVault() internal returns (SendVault vault) {
        vm.prank(owner);
        vault = SendVault(factory.createVault());
    }

    function _singleRecipient(address wallet, uint256 amount) internal pure returns (SendVault.RecipientPlan[] memory r) {
        r = new SendVault.RecipientPlan[](1);
        r[0] = SendVault.RecipientPlan({wallet: wallet, totalAmount: amount});
    }

    function _twoRecipients(address w1, uint256 a1, address w2, uint256 a2) internal pure returns (SendVault.RecipientPlan[] memory r) {
        r = new SendVault.RecipientPlan[](2);
        r[0] = SendVault.RecipientPlan({wallet: w1, totalAmount: a1});
        r[1] = SendVault.RecipientPlan({wallet: w2, totalAmount: a2});
    }

    function _createVaultWithPlan(SendVault.RecipientPlan[] memory recipients, uint32 duration, uint256 interval)
        internal returns (SendVault vault, uint256 totalAmount)
    {
        vault = _createVault();
        for (uint256 i = 0; i < recipients.length; i++) totalAmount += recipients[i].totalAmount;

        vm.prank(owner);
        usdc.approve(address(vault), totalAmount);
        vm.prank(owner);
        vault.setupPlan(address(usdc), recipients, duration, interval, block.timestamp);
    }

    // ─── initialize ──────────────────────────────────────────────────────────

    function test_createVault_clonesAndInitializes() public {
        SendVault vault = _createVault();
        assertEq(vault.owner(), owner);
        assertEq(vault.factory(), address(factory));
        assertTrue(vault.isKeeper(keeper));
    }

    function test_initialize_revertsIfAlreadyInitialized() public {
        SendVault vault = _createVault();
        vm.expectRevert(SendVault.AlreadyInitialized.selector);
        vault.initialize(owner, keeper);
    }

    function test_initialize_revertsOnImplementationDirectly() public {
        vm.expectRevert(SendVault.AlreadyInitialized.selector);
        implementation.initialize(owner, keeper);
    }

    // ─── setupPlan: happy path ───────────────────────────────────────────────

    function test_setupPlan_pullsFundsAndStoresFields() public {
        SendVault.RecipientPlan[] memory recipients = _twoRecipients(bob, 100e6, carol, 200e6);
        (SendVault vault, uint256 total) = _createVaultWithPlan(recipients, 10, 1 days);

        assertEq(total, 300e6);
        assertEq(usdc.balanceOf(address(vault)), 300e6);
        assertTrue(vault.initialized());
        assertFalse(vault.cancelled());
        assertEq(address(vault.token()), address(usdc));
        assertEq(vault.totalSteps(), 10);
        assertEq(vault.currentStep(), 0);
        assertEq(vault.interval(), 1 days);
        assertEq(vault.recipientCount(), 2);
    }

    function test_setupPlan_emitsPlanCreated() public {
        SendVault vault = _createVault();
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        vm.prank(owner);
        usdc.approve(address(vault), 100e6);

        vm.expectEmit(true, true, false, true);
        emit PlanCreated(owner, address(usdc), 100e6, 10, 1 days, block.timestamp, 1);

        vm.prank(owner);
        vault.setupPlan(address(usdc), recipients, 10, 1 days, block.timestamp);
    }

    event PlanCreated(
        address indexed owner, address indexed token, uint256 totalAmount,
        uint32 totalSteps, uint256 interval, uint256 firstExecutionTimestamp, uint256 recipientCount
    );

    function test_setupPlan_storesIndividualRecipientAmounts() public {
        SendVault.RecipientPlan[] memory recipients = _twoRecipients(bob, 100e6, carol, 250e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 5, 1 days);

        SendVault.RecipientPlan[] memory stored = vault.getRecipients();
        assertEq(stored.length, 2);
        assertEq(stored[0].wallet, bob);
        assertEq(stored[0].totalAmount, 100e6);
        assertEq(stored[1].wallet, carol);
        assertEq(stored[1].totalAmount, 250e6);
    }

    // ─── setupPlan: validation ───────────────────────────────────────────────

    function test_setupPlan_revertsIfAlreadyInitialized() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        vm.prank(owner);
        usdc.approve(address(vault), 100e6);
        vm.prank(owner);
        vm.expectRevert(SendVault.AlreadyInitialized.selector);
        vault.setupPlan(address(usdc), recipients, 10, 1 days, block.timestamp);
    }

    function test_setupPlan_revertsIfNotOwner() public {
        SendVault vault = _createVault();
        vm.prank(hacker);
        vm.expectRevert(SendVault.NotOwner.selector);
        vault.setupPlan(address(usdc), _singleRecipient(bob, 100e6), 10, 1 days, block.timestamp);
    }

    function test_setupPlan_revertsOnZeroTokenAddress() public {
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.InvalidAddress.selector);
        vault.setupPlan(address(0), _singleRecipient(bob, 100e6), 10, 1 days, block.timestamp);
    }

    function test_setupPlan_revertsOnZeroDuration() public {
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.InvalidDuration.selector);
        vault.setupPlan(address(usdc), _singleRecipient(bob, 100e6), 0, 1 days, block.timestamp);
    }

    function test_setupPlan_revertsOnZeroInterval() public {
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.InvalidInterval.selector);
        vault.setupPlan(address(usdc), _singleRecipient(bob, 100e6), 10, 0, block.timestamp);
    }

    function test_setupPlan_revertsOnPastTimestamp() public {
        vm.warp(1_000_000);
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.InvalidTimestamp.selector);
        vault.setupPlan(address(usdc), _singleRecipient(bob, 100e6), 10, 1 days, block.timestamp - 1);
    }

    function test_setupPlan_revertsOnEmptyRecipients() public {
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.NoRecipients.selector);
        vault.setupPlan(address(usdc), new SendVault.RecipientPlan[](0), 10, 1 days, block.timestamp);
    }

    function test_setupPlan_revertsAboveMaxRecipients() public {
        SendVault vault = _createVault();
        SendVault.RecipientPlan[] memory recipients = new SendVault.RecipientPlan[](11);
        for (uint256 i = 0; i < 11; i++) {
            recipients[i] = SendVault.RecipientPlan({wallet: makeAddr(string(abi.encodePacked("r", i))), totalAmount: 100e6});
        }
        vm.prank(owner);
        vm.expectRevert(SendVault.TooManyRecipients.selector);
        vault.setupPlan(address(usdc), recipients, 10, 1 days, block.timestamp);
    }

    function test_setupPlan_acceptsExactlyMaxRecipients() public {
        SendVault vault = _createVault();
        SendVault.RecipientPlan[] memory recipients = new SendVault.RecipientPlan[](10);
        uint256 total;
        for (uint256 i = 0; i < 10; i++) {
            recipients[i] = SendVault.RecipientPlan({wallet: makeAddr(string(abi.encodePacked("r", i))), totalAmount: 100e6});
            total += 100e6;
        }
        vm.prank(owner);
        usdc.approve(address(vault), total);
        vm.prank(owner);
        vault.setupPlan(address(usdc), recipients, 10, 1 days, block.timestamp);
        assertEq(vault.recipientCount(), 10);
    }

    function test_setupPlan_revertsOnZeroRecipientWallet() public {
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.InvalidAddress.selector);
        vault.setupPlan(address(usdc), _singleRecipient(address(0), 100e6), 10, 1 days, block.timestamp);
    }

    function test_setupPlan_revertsOnZeroRecipientAmount() public {
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.InvalidAmount.selector);
        vault.setupPlan(address(usdc), _singleRecipient(bob, 0), 10, 1 days, block.timestamp);
    }

    function test_setupPlan_revertsIfAmountBelowDuration() public {
        // amount < duration würde trancheAmount auf 0 runden lassen.
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.InvalidAmount.selector);
        vault.setupPlan(address(usdc), _singleRecipient(bob, 5), 10, 1 days, block.timestamp);
    }

    function test_setupPlan_revertsOnFeeOnTransferToken() public {
        MockFeeOnTransferERC20 feeToken = new MockFeeOnTransferERC20("Fee Token", "FEE", 100); // 1%
        feeToken.mint(owner, 1_000e18);

        SendVault vault = _createVault();
        vm.prank(owner);
        feeToken.approve(address(vault), 100e18);
        vm.prank(owner);
        vm.expectRevert(SendVault.FeeOnTransferUnsupported.selector);
        vault.setupPlan(address(feeToken), _singleRecipient(bob, 100e18), 10, 1 days, block.timestamp);
    }

    // ─── setKeeper ───────────────────────────────────────────────────────────

    function test_setKeeper_addsAndRemoves() public {
        SendVault vault = _createVault();
        address extra = makeAddr("extraKeeper");

        vm.prank(owner);
        vault.setKeeper(extra, true);
        assertTrue(vault.isKeeper(extra));

        vm.prank(owner);
        vault.setKeeper(extra, false);
        assertFalse(vault.isKeeper(extra));
    }

    function test_setKeeper_revertsIfNotOwner() public {
        SendVault vault = _createVault();
        vm.prank(hacker);
        vm.expectRevert(SendVault.NotOwner.selector);
        vault.setKeeper(hacker, true);
    }

    function test_setKeeper_revertsOnZeroAddress() public {
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.InvalidAddress.selector);
        vault.setKeeper(address(0), true);
    }

    // ─── canExecute ──────────────────────────────────────────────────────────

    function test_canExecute_falseBeforeInitialized() public {
        SendVault vault = _createVault();
        assertFalse(vault.canExecute());
    }

    function test_canExecute_trueAtFirstExecutionTime() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        assertTrue(vault.canExecute());
    }

    function test_canExecute_falseBeforeNextExecutionTimestamp() public {
        SendVault vault = _createVault();
        uint256 future = block.timestamp + 1 hours;
        vm.prank(owner);
        usdc.approve(address(vault), 100e6);
        vm.prank(owner);
        vault.setupPlan(address(usdc), _singleRecipient(bob, 100e6), 10, 1 days, future);
        assertFalse(vault.canExecute());
    }

    function test_canExecute_falseAfterCancel() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        vm.prank(owner);
        vault.cancelPlan();
        assertFalse(vault.canExecute());
    }

    // ─── amountForRecipientAtStep ────────────────────────────────────────────

    function test_amountForRecipientAtStep_evenSplit() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        assertEq(vault.amountForRecipientAtStep(0, 1), 10e6);
        assertEq(vault.amountForRecipientAtStep(0, 10), 10e6);
    }

    function test_amountForRecipientAtStep_lastStepAbsorbsRemainder() public {
        // 100 / 3 = 33 (Floor) pro Tranche, letzte Tranche bekommt 100 - 33*2 = 34.
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100);
        (SendVault vault,) = _createVaultWithPlan(recipients, 3, 1 days);

        assertEq(vault.amountForRecipientAtStep(0, 1), 33);
        assertEq(vault.amountForRecipientAtStep(0, 2), 33);
        assertEq(vault.amountForRecipientAtStep(0, 3), 34);
    }

    // ─── executeStep: happy path ─────────────────────────────────────────────

    function test_executeStep_paysRecipientsMinusFee() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        uint256 tranche = 10e6;
        uint256 fee = _feeFor(tranche);

        vm.prank(keeper);
        vault.executeStep();

        assertEq(vault.currentStep(), 1);
        assertEq(usdc.balanceOf(bob), tranche - fee);
        assertEq(usdc.balanceOf(keeper), fee); // treasury == globalKeeper
    }

    function test_setupPlan_snapshotsCurrentFactoryFee() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        assertEq(vault.snapshotFeeBps(), DEFAULT_FEE_BPS);
        assertEq(vault.snapshotMinFee(), DEFAULT_MIN_FEE);
    }

    function test_executeStep_ignoresFeeHikeAfterSetup() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        vm.startPrank(admin);
        factory.setFee(500);
        factory.setMinFee(address(usdc), 5_000_000);
        vm.stopPrank();

        uint256 tranche = 10e6;
        uint256 fee = _feeFor(tranche); // weiterhin auf Basis des Snapshots

        vm.prank(keeper);
        vault.executeStep();

        assertEq(usdc.balanceOf(bob), tranche - fee);
        assertEq(usdc.balanceOf(keeper), fee);
        assertEq(vault.snapshotFeeBps(), DEFAULT_FEE_BPS);
        assertEq(vault.snapshotMinFee(), DEFAULT_MIN_FEE);
    }

    function test_executeStep_sendsFeeToRotatedKeeper() public {
        address newKeeper = makeAddr("newKeeper");
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        vm.prank(admin);
        factory.setGlobalKeeper(newKeeper);

        uint256 tranche = 10e6;
        uint256 fee = _feeFor(tranche);

        vm.prank(owner);
        vault.executeStep();

        assertEq(usdc.balanceOf(newKeeper), fee);
        assertEq(usdc.balanceOf(keeper), 0);
    }

    function test_executeStep_advancesNextExecutionTimestamp() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        uint256 before = vault.nextExecutionTimestamp();

        vm.prank(keeper);
        vault.executeStep();

        assertEq(vault.nextExecutionTimestamp(), before + 1 days);
    }

    function test_executeStep_ownerCanExecuteDirectly() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        vm.prank(owner);
        vault.executeStep();
        assertEq(vault.currentStep(), 1);
    }

    function test_executeStep_splitsFeeProportionallyAcrossRecipients() public {
        // Ungleiche Anteile (100 vs 300 = 25%/75% dieser Tranche) — Gebühren-
        // Anteil muss proportional folgen, Rundungsrest an den letzten Empfänger.
        SendVault.RecipientPlan[] memory recipients = _twoRecipients(bob, 1_000e6, carol, 3_000e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        uint256 trancheTotal = 100e6 + 300e6; // Schritt-Summe beider Empfänger
        uint256 fee = _feeFor(trancheTotal);
        // bob: 25% Anteil an der Tranche -> 25% der Gebühr (floor)
        uint256 bobFeeShare = (fee * 100e6) / trancheTotal;
        uint256 carolFeeShare = fee - bobFeeShare; // Rest an carol (letzter Empfänger)

        vm.prank(keeper);
        vault.executeStep();

        assertEq(usdc.balanceOf(bob), 100e6 - bobFeeShare);
        assertEq(usdc.balanceOf(carol), 300e6 - carolFeeShare);
        assertEq(usdc.balanceOf(keeper), fee);
    }

    function test_executeStep_emitsRecipientPaidPerRecipient() public {
        SendVault.RecipientPlan[] memory recipients = _twoRecipients(bob, 100e6, carol, 200e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        uint256 trancheTotal = 10e6 + 20e6;
        uint256 fee = _feeFor(trancheTotal);
        uint256 bobFeeShare = (fee * 10e6) / trancheTotal;
        uint256 carolFeeShare = fee - bobFeeShare;

        vm.expectEmit(true, true, false, true);
        emit RecipientPaid(1, bob, 10e6 - bobFeeShare);
        vm.expectEmit(true, true, false, true);
        emit RecipientPaid(1, carol, 20e6 - carolFeeShare);

        vm.prank(keeper);
        vault.executeStep();
    }

    event RecipientPaid(uint32 indexed step, address indexed recipient, uint256 amount);

    function test_executeStep_fullPlanPaysExactTotalToEachRecipient() public {
        // Über die volle Laufzeit hinweg muss jeder Empfänger genau seinen
        // totalAmount abzüglich seines Gebührenanteils erhalten haben, ohne
        // Dust-Verlust in der letzten Tranche. Beträge bewusst groß genug
        // gewählt, dass die Gebühr (feeBps, nicht der minFee-Floor) greift —
        // sonst würde die erste Tranche mit FeeExceedsAmount() revertieren
        // (minFee=9_000 wäre größer als eine winzige Rohbetrag-Tranche).
        SendVault.RecipientPlan[] memory recipients = _twoRecipients(bob, 1_000e6, carol, 700e6);
        (SendVault vault, uint256 total) = _createVaultWithPlan(recipients, 3, 1 days);

        for (uint256 i = 0; i < 3; i++) {
            vm.prank(keeper);
            vault.executeStep();
            if (i < 2) vm.warp(block.timestamp + 1 days);
        }

        assertEq(vault.currentStep(), 3);
        assertEq(usdc.balanceOf(address(vault)), 0);
        // Summe aus Empfänger-Auszahlungen + Treasury-Gebühren muss exakt dem
        // eingezahlten Gesamtbetrag entsprechen (kein verlorener/erzeugter Wert).
        uint256 totalFeesPaid = usdc.balanceOf(keeper);
        assertEq(usdc.balanceOf(bob) + usdc.balanceOf(carol) + totalFeesPaid, total);
    }

    // ─── executeStep: guards ─────────────────────────────────────────────────

    function test_executeStep_revertsForUnauthorizedCaller() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        vm.prank(hacker);
        vm.expectRevert(SendVault.NotExecutor.selector);
        vault.executeStep();
    }

    function test_executeStep_revertsIfNotInitialized() public {
        SendVault vault = _createVault();
        vm.prank(keeper);
        vm.expectRevert(SendVault.NotInitialized.selector);
        vault.executeStep();
    }

    function test_executeStep_revertsIfCancelled() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        vm.prank(owner);
        vault.cancelPlan();
        vm.prank(keeper);
        vm.expectRevert(SendVault.PlanAlreadyCancelled.selector);
        vault.executeStep();
    }

    function test_executeStep_revertsIfPlanComplete() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 1, 1 days);

        vm.prank(keeper);
        vault.executeStep();

        vm.prank(keeper);
        vm.expectRevert(SendVault.PlanComplete.selector);
        vault.executeStep();
    }

    function test_executeStep_revertsIfTooEarly() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        vm.prank(keeper);
        vault.executeStep(); // Schritt 1, verschiebt nextExecutionTimestamp um 1 Tag

        vm.prank(keeper);
        vm.expectRevert(SendVault.TooEarly.selector);
        vault.executeStep(); // sofort nochmal, vor Ablauf des Intervalls
    }

    function test_executeStep_extraKeeperCanExecute() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        address extra = makeAddr("extraKeeper");

        vm.prank(extra);
        vm.expectRevert(SendVault.NotExecutor.selector);
        vault.executeStep();

        vm.prank(owner);
        vault.setKeeper(extra, true);

        vm.prank(extra);
        vault.executeStep();
        assertEq(vault.currentStep(), 1);
    }

    // ─── cancelPlan ──────────────────────────────────────────────────────────

    function test_cancelPlan_refundsFullBalance() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault, uint256 total) = _createVaultWithPlan(recipients, 10, 1 days);

        uint256 ownerBalanceBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.cancelPlan();

        assertTrue(vault.cancelled());
        assertEq(usdc.balanceOf(owner), ownerBalanceBefore + total);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_cancelPlan_refundsOnlyRemainderAfterPartialExecution() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);

        vm.prank(keeper);
        vault.executeStep(); // zahlt 1 von 10 Tranchen aus

        uint256 remainingInVault = usdc.balanceOf(address(vault));
        assertEq(remainingInVault, 90e6);

        uint256 ownerBalanceBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.cancelPlan();

        assertEq(usdc.balanceOf(owner), ownerBalanceBefore + remainingInVault);
    }

    function test_cancelPlan_revertsIfNotOwner() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        vm.prank(hacker);
        vm.expectRevert(SendVault.NotOwner.selector);
        vault.cancelPlan();
    }

    function test_cancelPlan_revertsIfNotInitialized() public {
        SendVault vault = _createVault();
        vm.prank(owner);
        vm.expectRevert(SendVault.NotInitialized.selector);
        vault.cancelPlan();
    }

    function test_cancelPlan_revertsIfAlreadyCancelled() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        vm.startPrank(owner);
        vault.cancelPlan();
        vm.expectRevert(SendVault.PlanAlreadyCancelled.selector);
        vault.cancelPlan();
        vm.stopPrank();
    }

    // ─── remainingSteps / remainingBalance ───────────────────────────────────

    function test_remainingSteps_decreasesPerStep() public {
        SendVault.RecipientPlan[] memory recipients = _singleRecipient(bob, 100e6);
        (SendVault vault,) = _createVaultWithPlan(recipients, 10, 1 days);
        assertEq(vault.remainingSteps(), 10);

        vm.prank(keeper);
        vault.executeStep();
        assertEq(vault.remainingSteps(), 9);
    }

    function test_remainingBalance_zeroBeforeInitialized() public {
        SendVault vault = _createVault();
        assertEq(vault.remainingBalance(), 0);
    }
}
