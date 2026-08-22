// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ─── Architektur ──────────────────────────────────────────────────────────────
//
// Teil von Apis, nicht Teil von OSIRIS — bewusst additiv und unabhängig von
// DcaVault/DcaVaultFactory (die dadurch komplett unberührt bleiben). Bildet
// eine einfache, bedingte Sell-Order für beliebig gehaltene Token ab:
// "verkaufe bps% meines aktuellen Bestands an sellToken gegen targetToken,
// höchstens maxExecutions mal". Die Preisbedingung selbst lebt off-chain im
// Apis-Keeper (Soft-Lösung) — dieser Contract kennt nur "wann jemand mit
// Keeper-Erlaubnis execute() aufruft", nicht "warum".
//
// Kein Clone-Pattern nötig (anders als DcaVault): Sell-Orders sind leichtgewichtig
// genug, um als einfache Structs in einem einzigen, gemeinsam genutzten Contract
// zu leben statt einem Contract pro Nutzer.
//
// Sicherheitsmuster bewusst 1:1 von DcaVault.executeStep() übernommen: nur
// freigegebene Router, Erfolg wird am tatsächlichen Balance-Zuwachs von
// `order.owner` gemessen (nicht am Rückgabewert des Router-Calls), minAmountOut
// zwingend > 0.

contract ConditionalSellOrder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Konstanten ──────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint16  public constant MAX_FEE_BPS      = 500; // 5 % Hard-Cap, wie DcaVaultFactory

    // ── Order ────────────────────────────────────────────────────────────────

    struct SellOrder {
        address owner;
        address sellToken;
        address targetToken;
        uint16  bps;             // Anteil des *aktuellen* sellToken-Bestands je Ausführung
        uint32  maxExecutions;   // meist 1 ("einmalig")
        uint32  executedCount;
        bool    cancelled;
    }

    // ── State ────────────────────────────────────────────────────────────────

    mapping(uint256 => SellOrder) public orders;
    uint256 public nextOrderId;

    // Keeper-Freigabe ist pro Order-Owner, nicht pro Order — ein setKeeper()-Aufruf
    // gilt für alle eigenen Orders (analog DcaVault.isKeeper, aber Owner-statt
    // Vault-skopiert, weil dieser Contract mehrere Nutzer gemeinsam bedient).
    mapping(address => mapping(address => bool)) public isKeeperFor;

    // Zusätzliche, pro Owner freigegebene Router — der defaultRouter (Squid) ist
    // für alle Owner automatisch freigegeben, siehe _isRouterApproved().
    mapping(address => mapping(address => bool)) public approvedRoutersFor;
    address public immutable defaultRouter;

    address public admin;
    address public treasury;
    uint16  public feeBps;
    uint256 public minFee;

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error NotExecutor();
    error NotAdmin();
    error InvalidAddress();
    error InvalidBps();
    error SameToken();
    error OrderAlreadyCancelled();
    error RouterNotApproved();
    error NothingToSell();
    error MinOutRequired();
    error SwapFailed();
    error SlippageExceeded();
    error FeeExceedsAmount();
    error FeeTooHigh();

    // ── Events ───────────────────────────────────────────────────────────────

    event OrderCreated(uint256 indexed orderId, address indexed owner, address sellToken, address targetToken, uint16 bps, uint32 maxExecutions);
    event OrderCancelled(uint256 indexed orderId);
    event OrderExecuted(uint256 indexed orderId, uint32 executionNumber, uint256 amountIn, uint256 amountOut);
    event FeeCharged(uint256 indexed orderId, uint256 feeAmount, address treasury);
    event KeeperUpdated(address indexed owner, address indexed keeper, bool allowed);
    event RouterUpdated(address indexed owner, address indexed router, bool allowed);
    event FeeUpdated(uint16 feeBps, uint256 minFee);
    event AdminUpdated(address indexed admin);
    event TreasuryUpdated(address indexed treasury);

    // ── Modifier ─────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    //
    // feeBps/minFee starten identisch zum aktuellen OSIRIS-Live-Wert (99 bps,
    // 0,035 USDC/USDT-Floor bei 6 Decimals = 35_000) — bewusst konsistente
    // Startgröße, keine technische Notwendigkeit, jederzeit per setFee() änderbar.

    constructor(address _defaultRouter, address _admin, address _treasury) {
        if (_defaultRouter == address(0) || _admin == address(0) || _treasury == address(0))
            revert InvalidAddress();

        defaultRouter = _defaultRouter;
        admin         = _admin;
        treasury      = _treasury;
        feeBps        = 99;
        minFee        = 35_000;
    }

    // ── Admin-Funktionen ─────────────────────────────────────────────────────

    function setFee(uint16 _feeBps, uint256 _minFee) external onlyAdmin {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = _feeBps;
        minFee = _minFee;
        emit FeeUpdated(_feeBps, _minFee);
    }

    function setAdmin(address _admin) external onlyAdmin {
        if (_admin == address(0)) revert InvalidAddress();
        admin = _admin;
        emit AdminUpdated(_admin);
    }

    function setTreasury(address _treasury) external onlyAdmin {
        if (_treasury == address(0)) revert InvalidAddress();
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    // ── Owner-Funktionen (pro Order-Owner, nicht Contract-weit) ────────────────

    function setKeeper(address keeper, bool allowed) external {
        if (keeper == address(0)) revert InvalidAddress();
        isKeeperFor[msg.sender][keeper] = allowed;
        emit KeeperUpdated(msg.sender, keeper, allowed);
    }

    function setRouter(address router, bool allowed) external {
        if (router == address(0)) revert InvalidAddress();
        approvedRoutersFor[msg.sender][router] = allowed;
        emit RouterUpdated(msg.sender, router, allowed);
    }

    // ── Order erstellen ─────────────────────────────────────────────────────
    //
    // Zieht KEIN Token ein — die Order ist nur eine Absichtserklärung. Der
    // eigentliche Zugriff läuft über eine normale ERC20-Approve auf diesen
    // Contract, die der Owner separat setzt (wie bei DcaVault.setupPlan(),
    // nur hier vom Owner selbst statt vom Contract initiiert).

    function createOrder(
        address sellToken,
        address targetToken,
        uint16  bps,
        uint32  maxExecutions
    ) external returns (uint256 orderId) {
        if (sellToken == address(0) || targetToken == address(0)) revert InvalidAddress();
        if (sellToken == targetToken) revert SameToken();
        if (bps == 0 || bps > BPS_DENOMINATOR) revert InvalidBps();
        if (maxExecutions == 0) revert InvalidBps();

        orderId = nextOrderId++;
        orders[orderId] = SellOrder({
            owner:         msg.sender,
            sellToken:     sellToken,
            targetToken:   targetToken,
            bps:           bps,
            maxExecutions: maxExecutions,
            executedCount: 0,
            cancelled:     false
        });

        emit OrderCreated(orderId, msg.sender, sellToken, targetToken, bps, maxExecutions);
    }

    // ── Order canceln ────────────────────────────────────────────────────────

    function cancelOrder(uint256 orderId) external {
        SellOrder storage order = orders[orderId];
        if (order.owner != msg.sender) revert NotOwner();
        if (order.cancelled) revert OrderAlreadyCancelled();
        order.cancelled = true;
        emit OrderCancelled(orderId);
    }

    // ── Router-Freigabe prüfen ───────────────────────────────────────────────

    function _isRouterApproved(address owner, address router) internal view returns (bool) {
        return router == defaultRouter || approvedRoutersFor[owner][router];
    }

    // ── Order ausführen ──────────────────────────────────────────────────────
    //
    // Aufrufbar vom Order-Owner selbst oder einem für ihn freigegebenen Keeper
    // (siehe isKeeperFor). Betrag wird bei JEDER Ausführung frisch aus dem
    // *aktuellen* Bestand berechnet (nicht beim Order-Erstellen eingefroren) —
    // "verkaufe 50 % meiner dann gehaltenen wBTC" statt eines fixen Betrags.

    function execute(
        uint256 orderId,
        address router,
        uint256 minAmountOut,
        bytes calldata swapCalldata
    ) external nonReentrant {
        SellOrder storage order = orders[orderId];

        if (msg.sender != order.owner && !isKeeperFor[order.owner][msg.sender]) revert NotExecutor();
        // `cancelled` ist die alleinige Quelle der Wahrheit dafür, ob eine Order
        // noch ausführbar ist — sie wird unten automatisch gesetzt, sobald
        // executedCount maxExecutions erreicht, ein separater Complete-Check
        // wäre daher unerreichbarer Code.
        if (order.cancelled) revert OrderAlreadyCancelled();
        if (!_isRouterApproved(order.owner, router)) revert RouterNotApproved();
        if (minAmountOut == 0) revert MinOutRequired();

        IERC20 sellToken = IERC20(order.sellToken);

        uint256 amount = (sellToken.balanceOf(order.owner) * order.bps) / BPS_DENOMINATOR;
        if (amount == 0) revert NothingToSell();

        sellToken.safeTransferFrom(order.owner, address(this), amount);

        // ── Gebühr abziehen ─────────────────────────────────────────────────
        // Gleiches Muster wie DcaVault.executeStep(): prozentual auf den
        // gezogenen Betrag, mindestens minFee, geht direkt an die Treasury
        // (Apis-Keeper-Wallet — deckt deren Gas-Kosten, siehe Gesamtplan §21).
        uint256 feeAmount = (amount * feeBps) / BPS_DENOMINATOR;
        if (feeAmount < minFee) feeAmount = minFee;
        if (feeAmount >= amount) revert FeeExceedsAmount();

        sellToken.safeTransfer(treasury, feeAmount);
        uint256 amountIn = amount - feeAmount;
        emit FeeCharged(orderId, feeAmount, treasury);

        // ── Swap ──────────────────────────────────────────────────────────────
        sellToken.forceApprove(router, amountIn);

        uint256 balanceBefore = IERC20(order.targetToken).balanceOf(order.owner);
        (bool ok, ) = router.call(swapCalldata);
        if (!ok) revert SwapFailed();

        sellToken.forceApprove(router, 0);

        uint256 amountOut = IERC20(order.targetToken).balanceOf(order.owner) - balanceBefore;
        if (amountOut < minAmountOut) revert SlippageExceeded();

        order.executedCount += 1;
        if (order.executedCount >= order.maxExecutions) {
            order.cancelled = true; // abgeschlossen — verhindert weitere execute()-Aufrufe
        }

        emit OrderExecuted(orderId, order.executedCount, amountIn, amountOut);
    }

    // ── View-Funktionen ──────────────────────────────────────────────────────

    function getOrder(uint256 orderId) external view returns (SellOrder memory) {
        return orders[orderId];
    }

    function canExecute(uint256 orderId) external view returns (bool) {
        SellOrder storage order = orders[orderId];
        return !order.cancelled && order.executedCount < order.maxExecutions;
    }
}
