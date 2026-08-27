// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal-Interface auf die Factory. Anders als DcaVault/TriggerVault
///         nimmt feeInfo() hier das zu versendende Token entgegen: SendVault
///         unterstützt beliebige MiniPay-Token mit unterschiedlichen Decimals
///         (6/8/18), ein einzelner roher minFee-Wert ließe sich nicht über
///         alle hinweg auf denselben Dollar-Betrag übertragen (siehe
///         SendVaultFactory.minFeeByToken).
interface ISendVaultFactory {
    function feeInfo(address token) external view returns (uint16 feeBps, uint256 minFee, address treasury);
}

// ─── Architektur ──────────────────────────────────────────────────────────────
//
// Reiner Auszahlungs-Vault, kein Swap — anders als DcaVault/TriggerVault ruft
// SendVault nie einen Router auf. Der Nutzer hält das Token bereits; der Vault
// verwahrt es nur für die Laufzeit des Plans und zahlt es zeitgesteuert an
// mehrere Empfänger aus.
//
// Jeder Empfänger bekommt einen individuellen Gesamtbetrag (RecipientPlan.
// totalAmount), nicht einen gleichen Anteil wie bei Sterntalers
// SterntalerVault — der Gesamtbetrag wird gleichmäßig über `duration`
// Tranchen verteilt (trancheAmount = totalAmount / duration), Rundungsrest
// geht auf der letzten Tranche an genau diesen Empfänger, nicht an einen
// global "letzten" Empfänger — jeder Empfänger bekommt am Ende exakt seinen
// eigenen totalAmount, unabhängig von den anderen.
//
// ─── Kein Router, kein externer Call in executeStep() ───────────────────────
//
// Da nichts geswapped wird, braucht executeStep() weder Router-Parameter noch
// minAmountOut noch Calldata vom Keeper — nur der Aufruf selbst. Das macht
// diesen Vault-Typ einfacher und günstiger als DcaVault/TriggerVault, und der
// Keeper-Zyklus dafür (siehe keeper/squidKeeper.ts) braucht keine
// Squid-Route.
//
// ─── Empfänger-Obergrenze ─────────────────────────────────────────────────────
//
// MAX_RECIPIENTS = 10, bewusst niedriger als Sterntalers MAX_RECIPIENTS (100):
// jeder Empfänger hier trägt einen eigenen individuellen uint256 totalAmount
// statt nur einer Adresse in einem Gleichverteilungs-Array — mehr Gas pro
// Empfänger, und 10 ist mehr als genug für die realistischen Fälle (siehe
// Chat: "Die Recipient Obergrenze kappen wir auf 10 um Fehler zu vermeiden").
// Es gibt keine zweite Cap-Dimension wie Sterntalers MAX_TOTAL_TRANSFERS,
// weil es hier kein Zieltoken-Array gibt (kein Swap-Fan-out) — nur
// recipients.length zählt.
//
// ─── Clone-Pattern (EIP-1167) — identisches Muster wie DcaVault/TriggerVault ─
//
// Deployt als Implementation hinter SendVaultFactory: jeder Plan bekommt
// seinen eigenen Minimal-Proxy-Clone. Clones durchlaufen den Constructor nie,
// `owner` kann daher nicht immutable sein — Setup läuft über initialize().

contract SendVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Konstanten ───────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_RECIPIENTS  = 10;

    // ── State (nicht immutable — siehe Clone-Pattern-Hinweis oben) ───────────

    address public owner;
    address public factory;
    bool    private _cloneInitialized;

    // ── RecipientPlan ─────────────────────────────────────────────────────────

    struct RecipientPlan {
        address wallet;
        uint256 totalAmount; // über die gesamte Laufzeit, individuell pro Empfänger
    }

    // ── State ────────────────────────────────────────────────────────────────

    bool    public initialized;
    bool    public cancelled;
    IERC20  public token;
    uint32  public totalSteps;
    uint32  public currentStep;
    uint256 public interval;
    uint256 public nextExecutionTimestamp;

    RecipientPlan[]           private recipientPlans;
    mapping(address => bool)  public  isKeeper;

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error NotExecutor();
    error InvalidAddress();
    error AlreadyInitialized();
    error NotInitialized();
    error PlanAlreadyCancelled();
    error PlanComplete();
    error TooEarly();
    error InvalidAmount();
    error InvalidDuration();
    error InvalidInterval();
    error InvalidTimestamp();
    error NoRecipients();
    error TooManyRecipients();
    error FeeOnTransferUnsupported();
    error FeeExceedsAmount();
    error NothingToExecute();

    // ── Events ───────────────────────────────────────────────────────────────

    event PlanCreated(
        address indexed owner,
        address indexed token,
        uint256 totalAmount,
        uint32  totalSteps,
        uint256 interval,
        uint256 firstExecutionTimestamp,
        uint256 recipientCount
    );

    event KeeperUpdated(address indexed keeper, bool allowed);
    event StepExecuted(uint32 indexed step, uint256 totalAmountOut, uint256 feeAmount);
    event RecipientPaid(uint32 indexed step, address indexed recipient, uint256 amount);
    event PlanCancelled(uint256 remainingBalance);
    event FeeCharged(uint32 indexed step, uint256 feeAmount, address treasury);

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != owner && !isKeeper[msg.sender]) revert NotExecutor();
        _;
    }

    modifier activePlan() {
        if (!initialized)              revert NotInitialized();
        if (cancelled)                 revert PlanAlreadyCancelled();
        if (currentStep >= totalSteps) revert PlanComplete();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    //
    // Sperrt nur die Implementation selbst gegen initialize() — Clones
    // durchlaufen diesen Code nie, ihr eigener `_cloneInitialized`-Slot
    // startet unabhängig bei `false`.

    constructor() {
        _cloneInitialized = true;
    }

    // ── initialize ───────────────────────────────────────────────────────────
    //
    // Ersetzt den Constructor für Clones. Wird von SendVaultFactory.
    // createVault() unmittelbar nach Clones.clone() in derselben Transaktion
    // aufgerufen — kein Front-Running-Fenster.
    //
    // Anders als DcaVault/TriggerVault gibt es hier keinen Router zum
    // Freischalten, da SendVault nie einen Swap ausführt.

    function initialize(address _owner, address _globalKeeper) external {
        if (_cloneInitialized) revert AlreadyInitialized();
        _cloneInitialized = true;

        if (_owner == address(0) || _globalKeeper == address(0))
            revert InvalidAddress();

        owner   = _owner;
        factory = msg.sender;

        isKeeper[_globalKeeper] = true;
        emit KeeperUpdated(_globalKeeper, true);
    }

    // ── setupPlan ────────────────────────────────────────────────────────────

    function setupPlan(
        address              _token,
        RecipientPlan[] calldata _recipients,
        uint32               _duration,
        uint256               _interval,
        uint256               _firstExecutionTimestamp
    ) external onlyOwner nonReentrant {
        if (initialized)                                 revert AlreadyInitialized();
        if (_token == address(0))                        revert InvalidAddress();
        if (_duration == 0)                               revert InvalidDuration();
        if (_interval == 0)                               revert InvalidInterval();
        if (_firstExecutionTimestamp < block.timestamp)   revert InvalidTimestamp();

        uint256 recipientsLength = _recipients.length;
        if (recipientsLength == 0)             revert NoRecipients();
        if (recipientsLength > MAX_RECIPIENTS) revert TooManyRecipients();

        uint256 totalAmount;
        for (uint256 i = 0; i < recipientsLength; ) {
            address wallet = _recipients[i].wallet;
            uint256 amount = _recipients[i].totalAmount;

            if (wallet == address(0)) revert InvalidAddress();
            if (amount == 0)          revert InvalidAmount();
            if (amount < _duration)   revert InvalidAmount(); // sonst rundet trancheAmount auf 0

            recipientPlans.push(RecipientPlan({wallet: wallet, totalAmount: amount}));
            totalAmount += amount;
            unchecked { ++i; }
        }

        token                   = IERC20(_token);
        totalSteps              = _duration;
        interval                = _interval;
        nextExecutionTimestamp  = _firstExecutionTimestamp;
        initialized             = true;

        // Fee-on-Transfer-Schutz, identisch zu DcaVault/TriggerVault/
        // SterntalerVault.setupPlan().
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(owner, address(this), totalAmount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received != totalAmount) revert FeeOnTransferUnsupported();

        emit PlanCreated(owner, _token, totalAmount, _duration, _interval, _firstExecutionTimestamp, recipientsLength);
    }

    // ── setKeeper ────────────────────────────────────────────────────────────

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert InvalidAddress();
        isKeeper[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    // ── canExecute ───────────────────────────────────────────────────────────

    function canExecute() public view returns (bool) {
        return (
            initialized &&
            !cancelled &&
            currentStep < totalSteps &&
            block.timestamp >= nextExecutionTimestamp
        );
    }

    // ── amountForRecipientAtStep ─────────────────────────────────────────────
    //
    // Rein arithmetisch aus dem gespeicherten totalAmount abgeleitet, kein
    // Balance-Read nötig: trancheAmount = totalAmount / duration (Floor),
    // auf der letzten Tranche (step == totalSteps) der komplette Rest
    // (totalAmount - trancheAmount * (duration - 1)) statt trancheAmount —
    // fängt den Rundungsrest pro Empfänger einzeln ab, unabhängig von den
    // anderen Empfängern (anders als Sterntalers "Rest an den letzten
    // Empfänger"-Muster, das hier nicht passt, weil jeder Empfänger einen
    // eigenen Gesamtbetrag statt eines gleichen Anteils hat).

    function amountForRecipientAtStep(uint256 index, uint32 step) public view returns (uint256) {
        RecipientPlan storage plan = recipientPlans[index];
        uint256 trancheAmount = plan.totalAmount / totalSteps;
        if (step == totalSteps) {
            return plan.totalAmount - trancheAmount * (totalSteps - 1);
        }
        return trancheAmount;
    }

    // ── executeStep ──────────────────────────────────────────────────────────
    //
    // Kein Router, keine Calldata, kein minAmountOut — reine Auszahlung. Die
    // Gebühr wird einmal auf die Summe aller diesen Schritt fälligen
    // Tranchen erhoben (wie bei DcaVault/TriggerVault), der Netto-Betrag dann
    // proportional zum Anteil jedes Empfängers an dieser Summe verteilt,
    // Rundungsrest der Gebühren-Anteile geht an den letzten Empfänger dieses
    // Schritts (gleiches Dust-Prinzip wie SterntalerVault's Swap-Output-Split).
    //
    // State (currentStep/nextExecutionTimestamp) wird VOR den externen Calls
    // aktualisiert, nonReentrant schützt die gesamte Funktion — Checks-
    // Effects-Interactions wie bei DcaVault/TriggerVault.

    function executeStep() external onlyExecutor activePlan nonReentrant {
        if (block.timestamp < nextExecutionTimestamp) revert TooEarly();

        uint32 step = currentStep + 1;
        currentStep             = step;
        nextExecutionTimestamp += interval;

        uint256 recipientsLength = recipientPlans.length;
        uint256[] memory amounts = new uint256[](recipientsLength);
        uint256 amountForThisStep;

        for (uint256 i = 0; i < recipientsLength; ) {
            uint256 amount = amountForRecipientAtStep(i, step);
            amounts[i] = amount;
            amountForThisStep += amount;
            unchecked { ++i; }
        }

        if (amountForThisStep == 0) revert NothingToExecute();

        // ── Gebühr ────────────────────────────────────────────────────────
        (uint16 feeBps, uint256 minFee, address treasury) = ISendVaultFactory(factory).feeInfo(address(token));
        uint256 feeAmount = (amountForThisStep * feeBps) / BPS_DENOMINATOR;
        if (feeAmount < minFee) feeAmount = minFee;
        if (feeAmount >= amountForThisStep) revert FeeExceedsAmount();

        token.safeTransfer(treasury, feeAmount);
        emit FeeCharged(step, feeAmount, treasury);

        // ── Auszahlung ────────────────────────────────────────────────────
        uint256 distributedFee;
        for (uint256 i = 0; i < recipientsLength; ) {
            uint256 feeShare = (i == recipientsLength - 1)
                ? (feeAmount - distributedFee) // Rundungsrest der Gebühr an den letzten Empfänger dieses Schritts
                : (feeAmount * amounts[i]) / amountForThisStep;
            distributedFee += feeShare;

            uint256 payout = amounts[i] - feeShare;
            if (payout > 0) {
                token.safeTransfer(recipientPlans[i].wallet, payout);
                emit RecipientPaid(step, recipientPlans[i].wallet, payout);
            }
            unchecked { ++i; }
        }

        emit StepExecuted(step, amountForThisStep - feeAmount, feeAmount);
    }

    // ── cancelPlan ───────────────────────────────────────────────────────────
    //
    // Refunded den noch nicht ausgezahlten Restbestand an `owner` — Empfänger
    // hatten nie Custody über nicht ausgezahlte Beträge.

    function cancelPlan() external onlyOwner nonReentrant {
        if (!initialized) revert NotInitialized();
        if (cancelled)    revert PlanAlreadyCancelled();
        cancelled = true;

        uint256 remaining = token.balanceOf(address(this));
        if (remaining > 0) {
            token.safeTransfer(owner, remaining);
        }

        emit PlanCancelled(remaining);
    }

    // ── View-Funktionen ──────────────────────────────────────────────────────

    function getRecipients() external view returns (RecipientPlan[] memory) {
        return recipientPlans;
    }

    function recipientCount() external view returns (uint256) {
        return recipientPlans.length;
    }

    function remainingSteps() external view returns (uint32) {
        return totalSteps - currentStep;
    }

    function remainingBalance() external view returns (uint256) {
        if (!initialized) return 0;
        return token.balanceOf(address(this));
    }
}
