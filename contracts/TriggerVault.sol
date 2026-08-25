// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal-Interface auf die Factory — nur der für die Gebühr
///         benötigte Wert, exakt wie IDcaVaultFactory in DcaVault.sol.
interface ITriggerVaultFactory {
    function feeInfo() external view returns (uint16 feeBps, uint256 minFee, address treasury);
}

// ─── Architektur ──────────────────────────────────────────────────────────────
//
// OSIRIS' Price-Trigger-Erweiterung neben dem bestehenden DcaVault — ein
// eigener Vault-Typ für einmalige, preisgetriggerte Käufe/Verkäufe statt
// zeitgetakteter DCA-Tranchen. Ein TriggerVault ist ein EIP-1167-Clone
// (identisches Muster wie DcaVault) für GENAU EINEN Plan: hält bei
// setupPlan() einen festen Betrag eines Tokens in Verwahrung (echter
// Transfer, kein bloßes Allowance-Pull-Modell), wartet auf eine vom Keeper
// beobachtete Preisbedingung, tauscht bei Auslösung den KOMPLETTEN
// verwahrten Betrag einmalig und sendet das Ergebnis an den Owner.
// Funktioniert für beide Richtungen — "Buy Plan" (heldToken=Stablecoin,
// outputToken=Zieltoken) und "Sell Plan" (heldToken=Zieltoken,
// outputToken=Stablecoin) sind derselbe Contract, nur mit vertauschten Token.
//
// triggerAbove/triggerPrice/watchToken sind wie bei ConditionalSellOrder rein
// informativ — der Contract kennt nur "wann ein freigegebener Keeper
// execute() aufruft", nicht "warum". expiresAt dagegen ist ECHT on-chain
// durchgesetzt (einfache Zeitprüfung, kein Orakel nötig).
//
// Sicherheitsmuster identisch zu DcaVault.executeStep()/ConditionalSellOrder.
// execute(): nur freigegebene Router, Erfolg wird am tatsächlichen
// Balance-Zuwachs von `owner` gemessen, forceApprove-Musters (0-dann-N) für
// USDT-artige Token.

contract TriggerVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── State (kann bei Clones nicht immutable sein, siehe DcaVault) ─────────

    address public owner;
    address public factory;
    bool private _cloneInitialized;

    bool public initialized;
    bool public cancelled;
    bool public executed;

    IERC20  public heldToken;
    address public outputToken;
    address public watchToken;
    uint256 public amount;
    bool    public triggerAbove;
    uint256 public triggerPrice;
    uint256 public expiresAt; // 0 = zeitlich unbegrenzt

    mapping(address => bool) public isKeeper;
    mapping(address => bool) public approvedRouters;

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error NotExecutor();
    error InvalidAddress();
    error AlreadyInitialized();
    error NotInitialized();
    error PlanAlreadyCancelled();
    error PlanAlreadyExecuted();
    error InvalidAmount();
    error InvalidTriggerPrice();
    error InvalidTimestamp();
    error SameToken();
    error FeeOnTransferUnsupported();
    error MinOutRequired();
    error RouterNotApproved();
    error SwapFailed();
    error SlippageExceeded();
    error FeeExceedsAmount();
    error Expired();

    // ── Events ───────────────────────────────────────────────────────────────

    event TriggerPlanCreated(
        address indexed owner,
        address indexed heldToken,
        address outputToken,
        address watchToken,
        uint256 amount,
        bool    triggerAbove,
        uint256 triggerPrice,
        uint256 expiresAt
    );
    event KeeperUpdated(address indexed keeper, bool allowed);
    event RouterUpdated(address indexed router, bool allowed);
    event TriggerExecuted(uint256 amountIn, uint256 amountOut);
    event PlanCancelled(uint256 remainingBalance);
    event FeeCharged(uint256 feeAmount, address treasury);

    // ── Modifier ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != owner && !isKeeper[msg.sender]) revert NotExecutor();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    //
    // Sperrt nur die Implementation selbst gegen initialize() — Clones
    // durchlaufen diesen Code nie (siehe DcaVault-Architekturkommentar).

    constructor() {
        _cloneInitialized = true;
    }

    // ── initialize ───────────────────────────────────────────────────────────
    //
    // Wird von TriggerVaultFactory.createVault() unmittelbar nach Clones.clone()
    // in derselben Transaktion aufgerufen — kein Front-Running-Fenster.

    function initialize(address _owner, address _squidRouter, address _globalKeeper) external {
        if (_cloneInitialized) revert AlreadyInitialized();
        _cloneInitialized = true;

        if (_owner == address(0) || _squidRouter == address(0) || _globalKeeper == address(0))
            revert InvalidAddress();

        owner   = _owner;
        factory = msg.sender;

        approvedRouters[_squidRouter] = true;
        emit RouterUpdated(_squidRouter, true);

        isKeeper[_globalKeeper] = true;
        emit KeeperUpdated(_globalKeeper, true);
    }

    // ── setupPlan ────────────────────────────────────────────────────────────
    //
    // Zieht `_amount` von `_heldToken` echt in den Vault (safeTransferFrom) —
    // anders als ConditionalSellOrder.createOrder() (das nichts einzieht) hält
    // dieser Vault die Mittel selbst in Verwahrung, bis execute() oder
    // cancel() aufgerufen wird.

    function setupPlan(
        address _heldToken,
        address _outputToken,
        address _watchToken,
        uint256 _amount,
        bool    _triggerAbove,
        uint256 _triggerPrice,
        uint256 _expiresAt
    ) external onlyOwner nonReentrant {
        if (initialized) revert AlreadyInitialized();
        if (_heldToken == address(0) || _outputToken == address(0) || _watchToken == address(0))
            revert InvalidAddress();
        if (_heldToken == _outputToken) revert SameToken();
        if (_amount == 0) revert InvalidAmount();
        if (_triggerPrice == 0) revert InvalidTriggerPrice();
        if (_expiresAt != 0 && _expiresAt < block.timestamp) revert InvalidTimestamp();

        heldToken    = IERC20(_heldToken);
        outputToken  = _outputToken;
        watchToken   = _watchToken;
        amount       = _amount;
        triggerAbove = _triggerAbove;
        triggerPrice = _triggerPrice;
        expiresAt    = _expiresAt;
        initialized  = true;

        // Token-Transfer mit Fee-on-Transfer-Schutz, wie DcaVault.setupPlan().
        uint256 balanceBefore = heldToken.balanceOf(address(this));
        heldToken.safeTransferFrom(owner, address(this), _amount);
        uint256 received = heldToken.balanceOf(address(this)) - balanceBefore;
        if (received != _amount) revert FeeOnTransferUnsupported();

        emit TriggerPlanCreated(owner, _heldToken, _outputToken, _watchToken, _amount, _triggerAbove, _triggerPrice, _expiresAt);
    }

    // ── setKeeper / setRouter ────────────────────────────────────────────────

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert InvalidAddress();
        isKeeper[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert InvalidAddress();
        approvedRouters[router] = allowed;
        emit RouterUpdated(router, allowed);
    }

    // ── canExecute ───────────────────────────────────────────────────────────

    function canExecute() public view returns (bool) {
        return initialized && !cancelled && !executed && (expiresAt == 0 || block.timestamp <= expiresAt);
    }

    // ── execute ──────────────────────────────────────────────────────────────
    //
    // Tauscht den KOMPLETTEN verwahrten Betrag (abzüglich Gebühr) einmalig via
    // Router und sendet das Ergebnis an `owner`. Erfolg wird — wie bei
    // DcaVault/ConditionalSellOrder — am tatsächlichen Balance-Zuwachs von
    // `owner` gemessen, nicht am Rückgabewert des Router-Calls.

    function execute(address router, uint256 minAmountOut, bytes calldata swapCalldata) external onlyExecutor nonReentrant {
        if (!initialized)      revert NotInitialized();
        if (cancelled)         revert PlanAlreadyCancelled();
        if (executed)          revert PlanAlreadyExecuted();
        if (expiresAt != 0 && block.timestamp > expiresAt) revert Expired();
        if (!approvedRouters[router]) revert RouterNotApproved();
        if (minAmountOut == 0) revert MinOutRequired();

        uint256 vaultBalance = heldToken.balanceOf(address(this));

        (uint16 feeBps, uint256 minFee, address treasury) = ITriggerVaultFactory(factory).feeInfo();
        uint256 feeAmount = (vaultBalance * feeBps) / 10_000;
        if (feeAmount < minFee) feeAmount = minFee;
        if (feeAmount >= vaultBalance) revert FeeExceedsAmount();

        heldToken.safeTransfer(treasury, feeAmount);
        uint256 amountIn = vaultBalance - feeAmount;
        emit FeeCharged(feeAmount, treasury);

        heldToken.forceApprove(router, amountIn);

        uint256 balanceBefore = IERC20(outputToken).balanceOf(owner);
        (bool ok, ) = router.call(swapCalldata);
        if (!ok) revert SwapFailed();

        heldToken.forceApprove(router, 0);

        uint256 amountOut = IERC20(outputToken).balanceOf(owner) - balanceBefore;
        if (amountOut < minAmountOut) revert SlippageExceeded();

        executed = true;
        emit TriggerExecuted(amountIn, amountOut);
    }

    // ── cancel ───────────────────────────────────────────────────────────────
    //
    // Jederzeit vor der Ausführung möglich (auch nach Ablauf von expiresAt) —
    // gibt den vollen verwahrten Restbetrag an den Owner zurück.

    function cancel() external onlyOwner nonReentrant {
        if (!initialized) revert NotInitialized();
        if (cancelled)    revert PlanAlreadyCancelled();
        if (executed)     revert PlanAlreadyExecuted();
        cancelled = true;

        uint256 remaining = heldToken.balanceOf(address(this));
        if (remaining > 0) {
            heldToken.safeTransfer(owner, remaining);
        }

        emit PlanCancelled(remaining);
    }
}
