// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ─── Architektur ──────────────────────────────────────────────────────────────
//
// Der Vault ruft selbst keinen DEX-Router mehr direkt auf (kein Uniswap V4 /
// UniversalRouter / Permit2 mehr). Stattdessen holt der Keeper off-chain eine
// fertige Route (Ziel-Router + Calldata) von der Squid-API und übergibt beides
// per executeStep() an den Vault. Der Vault prüft nur:
//   1. Der Ziel-Router ist vom Owner freigegeben (approvedRouters).
//   2. Nach dem Call hat `owner` mindestens minAmountsOut[i] des Zieltokens
//      mehr als vorher — unabhängig davon, was die Calldata im Detail tut.
// Das entkoppelt den Contract von einer festen DEX-Version (Squid routet über
// viele DEXs) und macht Pool-spezifische Parameter (Fee-Tier, TickSpacing,
// Hooks) überflüssig.

contract DcaVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Konstanten ──────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_TARGETS     = 10;

    // ── Immutables ──────────────────────────────────────────────────────────

    address public immutable owner;

    // ── TargetConfig ────────────────────────────────────────────────────────

    struct TargetConfig {
        address token;
        uint16  bps;
    }

    // ── State ────────────────────────────────────────────────────────────────

    bool    public initialized;
    bool    public cancelled;
    IERC20  public inputToken;
    uint256 public totalDeposited;
    uint256 public trancheAmount;
    uint256 public interval;
    uint32  public totalSteps;
    uint32  public currentStep;
    uint256 public nextExecutionTimestamp;

    TargetConfig[]           private targetConfigs;
    mapping(address => bool) public  isKeeper;
    mapping(address => bool) public  approvedRouters;

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
    error InvalidTargets();
    error DuplicateTarget();
    error AllocationInvalid();
    error LengthMismatch();
    error FeeOnTransferUnsupported();
    error MinOutRequired();
    error InsufficientVaultBalance();
    error NothingToExecute();
    error RouterNotApproved();
    error SwapFailed();
    error SlippageExceeded();

    // ── Events ───────────────────────────────────────────────────────────────

    event DcaPlanCreated(
        address indexed owner,
        address indexed inputToken,
        uint256 totalAmount,
        uint256 trancheAmount,
        uint32  totalSteps,
        uint256 interval,
        uint256 firstExecutionTimestamp
    );

    event KeeperUpdated(address indexed keeper, bool allowed);
    event RouterUpdated(address indexed router, bool allowed);

    event DcaSwapExecuted(
        uint32  indexed step,
        address indexed targetToken,
        uint256 amountIn,
        uint256 amountOut
    );

    event DcaStepExecuted(uint32 indexed step, uint256 totalAmountIn);
    event PlanCancelled(uint256 remainingBalance);

    // ── Modifier ─────────────────────────────────────────────────────────────

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

    constructor(address _owner) {
        if (_owner == address(0)) revert InvalidAddress();
        owner = _owner;
    }

    // ── setupPlan ────────────────────────────────────────────────────────────

    function setupPlan(
        address   _inputToken,
        uint256   _totalAmount,
        uint32    _duration,
        uint256   _interval,
        uint256   _firstExecutionTimestamp,
        address[] calldata _targetTokens,
        uint16[]  calldata _targetBps
    ) external onlyOwner nonReentrant {

        if (initialized)                                revert AlreadyInitialized();
        if (_inputToken == address(0))                  revert InvalidAddress();
        if (_totalAmount == 0)                          revert InvalidAmount();
        if (_duration == 0)                             revert InvalidDuration();
        if (_interval == 0)                             revert InvalidInterval();
        if (_firstExecutionTimestamp < block.timestamp) revert InvalidTimestamp();

        uint256 targetsLength = _targetTokens.length;
        if (targetsLength == 0 || targetsLength > MAX_TARGETS)
            revert InvalidTargets();

        if (targetsLength != _targetBps.length) revert LengthMismatch();

        if (_totalAmount < _duration) revert InvalidAmount();

        uint256 totalBps;

        for (uint256 i = 0; i < targetsLength; ) {
            address target = _targetTokens[i];
            uint16  bps    = _targetBps[i];

            if (target == address(0) || target == _inputToken)
                revert InvalidAddress();
            if (bps == 0) revert AllocationInvalid();

            for (uint256 j = 0; j < i; ) {
                if (_targetTokens[j] == target) revert DuplicateTarget();
                unchecked { ++j; }
            }

            targetConfigs.push(TargetConfig({
                token: target,
                bps:   bps
            }));

            totalBps += bps;
            unchecked { ++i; }
        }

        if (totalBps != BPS_DENOMINATOR) revert AllocationInvalid();

        inputToken             = IERC20(_inputToken);
        totalDeposited         = _totalAmount;
        trancheAmount          = _totalAmount / _duration;
        totalSteps             = _duration;
        interval               = _interval;
        nextExecutionTimestamp = _firstExecutionTimestamp;
        initialized            = true;

        // Token-Transfer mit Fee-on-Transfer-Schutz
        uint256 balanceBefore = inputToken.balanceOf(address(this));
        inputToken.safeTransferFrom(owner, address(this), _totalAmount);
        uint256 received = inputToken.balanceOf(address(this)) - balanceBefore;
        if (received != _totalAmount) revert FeeOnTransferUnsupported();

        emit DcaPlanCreated(
            owner,
            _inputToken,
            _totalAmount,
            trancheAmount,
            _duration,
            _interval,
            _firstExecutionTimestamp
        );
    }

    // ── setKeeper ────────────────────────────────────────────────────────────

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert InvalidAddress();
        isKeeper[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    // ── setRouter ────────────────────────────────────────────────────────────
    //
    // Nur vom Owner freigegebene Router-Adressen dürfen in executeStep als
    // Ziel für den Swap-Call genutzt werden (z.B. der Squid-Router).

    function setRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert InvalidAddress();
        approvedRouters[router] = allowed;
        emit RouterUpdated(router, allowed);
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

    // ── executeStep ──────────────────────────────────────────────────────────
    //
    // Für jeden Zieltoken i:
    //   1. routers[i] muss freigegeben sein (approvedRouters).
    //   2. inputToken wird für routers[i] in Höhe von amountIn freigegeben.
    //   3. routers[i].call(squidCallData[i]) — die Calldata kommt vom Keeper
    //      (off-chain von der Squid-API geholt) und bestimmt Route/Details.
    //   4. Erfolg wird NICHT am Rückgabewert festgemacht, sondern daran, dass
    //      `owner` danach mindestens minAmountsOut[i] mehr vom Zieltoken hält
    //      als vorher — das ist die eigentliche On-Chain-Sicherheitsgarantie.

    function executeStep(
        address[] calldata routers,
        uint256[] calldata minAmountsOut,
        bytes[]   calldata squidCallData
    ) external onlyExecutor activePlan nonReentrant {
        if (block.timestamp < nextExecutionTimestamp) revert TooEarly();

        uint256 configsLength = targetConfigs.length;
        if (routers.length       != configsLength) revert LengthMismatch();
        if (minAmountsOut.length != configsLength) revert LengthMismatch();
        if (squidCallData.length != configsLength) revert LengthMismatch();

        uint32 step = currentStep + 1;
        currentStep            = step;
        nextExecutionTimestamp += interval;

        uint256 vaultBalance      = inputToken.balanceOf(address(this));
        uint256 amountForThisStep = step == totalSteps
            ? vaultBalance
            : trancheAmount;

        if (amountForThisStep == 0)           revert NothingToExecute();
        if (vaultBalance < amountForThisStep) revert InsufficientVaultBalance();

        uint256 remainingForStep = amountForThisStep;

        for (uint256 i = 0; i < configsLength; ) {
            TargetConfig storage config = targetConfigs[i];

            // ── Anteiligen Betrag berechnen ──────────────────────────────
            uint256 amountIn;
            if (i == configsLength - 1) {
                amountIn = remainingForStep; // Rest-Dust dem letzten Token
            } else {
                amountIn = (amountForThisStep * config.bps) / BPS_DENOMINATOR;
                remainingForStep -= amountIn;
            }

            uint256 minAmountOut = minAmountsOut[i];
            if (amountIn     == 0) revert NothingToExecute();
            if (minAmountOut == 0) revert MinOutRequired();

            address router = routers[i];
            if (!approvedRouters[router]) revert RouterNotApproved();

            // forceApprove: setzt zuerst auf 0, dann auf amountIn, um das
            // USDT-Double-Approve-Problem zu umgehen.
            inputToken.forceApprove(router, amountIn);

            uint256 balanceBefore = IERC20(config.token).balanceOf(owner);

            (bool ok, ) = router.call(squidCallData[i]);
            if (!ok) revert SwapFailed();

            // Offene Allowance sicherheitshalber schließen, egal wie viel der
            // Router tatsächlich gezogen hat.
            inputToken.forceApprove(router, 0);

            uint256 amountOut = IERC20(config.token).balanceOf(owner) - balanceBefore;
            if (amountOut < minAmountOut) revert SlippageExceeded();

            emit DcaSwapExecuted(step, config.token, amountIn, amountOut);

            unchecked { ++i; }
        }

        emit DcaStepExecuted(step, amountForThisStep);
    }

    // ── cancelPlan ───────────────────────────────────────────────────────────

    function cancelPlan() external onlyOwner nonReentrant {
        if (!initialized) revert NotInitialized();
        if (cancelled)    revert PlanAlreadyCancelled();
        cancelled = true;

        uint256 remaining = inputToken.balanceOf(address(this));
        if (remaining > 0) {
            inputToken.safeTransfer(owner, remaining);
        }

        emit PlanCancelled(remaining);
    }

    // ── View-Funktionen ──────────────────────────────────────────────────────

    function getTargetConfigs() external view returns (TargetConfig[] memory) {
        return targetConfigs;
    }

    function targetConfigCount() external view returns (uint256) {
        return targetConfigs.length;
    }

    function remainingSteps() external view returns (uint32) {
        return totalSteps - currentStep;
    }

    function remainingInputBalance() external view returns (uint256) {
        if (!initialized) return 0;
        return inputToken.balanceOf(address(this));
    }
}
