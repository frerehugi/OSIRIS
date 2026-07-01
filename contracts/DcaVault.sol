// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ─── Uniswap V4: UniversalRouter ─────────────────────────────────────────────
//
// Der UniversalRouter ist der offizielle Einstiegspunkt für alle Uniswap-Swaps
// (V2, V3, V4) ab 2024/2025 und ist auf Celo Sepolia + Mainnet deployed.
// Adresse Celo Sepolia : 0x8891A0A682cC7f0bda7912E79C80167403d96103
// Adresse Celo Mainnet : 0xcb695bc5d3aa22cad1e6df07801b061a05a0233a
//
// Interface: execute(bytes commands, bytes[] inputs, uint256 deadline)
// - commands : 1 Byte pro Aktion, hier 0x10 = V4_SWAP
// - inputs   : ABI-codierter V4-Kontext (V4-Actions + Params)

interface IUniversalRouter {
    /// @param commands  Packed byte-string, 1 byte = 1 Befehl.
    /// @param inputs    ABI-encodierte Parameter pro Befehl.
    /// @param deadline  Unix-Timestamp; Transaktion revertiert danach.
    function execute(
        bytes  calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable;
}

// ─── Permit2 ─────────────────────────────────────────────────────────────────
//
// Permit2 ermöglicht es dem UniversalRouter, Token aus diesem Contract zu ziehen,
// ohne dass für jeden Swap eine neue ERC-20-Allowance gesetzt werden muss.
// Adresse: 0x000000000022D473030F116dDEE9F6B43aC78BA3 (alle EVM-Chains)

interface IPermit2 {
    /// @notice Setzt eine zeitlich begrenzte Allowance für einen Spender.
    /// @param token      Das Token, das freigegeben wird.
    /// @param spender    Der Spender (= UniversalRouter).
    /// @param amount     Maximaler Betrag (uint160, max ~1.46e30).
    /// @param expiration Unix-Timestamp der Ablaufzeit (uint48).
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48  expiration
    ) external;
}

// ─── V4 UniversalRouter Command ───────────────────────────────────────────────
// Quelle: github.com/Uniswap/universal-router — CommandType enum
uint8 constant CMD_V4_SWAP = 0x10;

// ─── V4 Actions (innerhalb des V4_SWAP-Inputs) ────────────────────────────────
// Quelle: docs.uniswap.org/contracts/v4/reference/periphery/libraries/Actions
uint8 constant ACT_SWAP_EXACT_IN_SINGLE = 0x06; // Exact-In-Swap über einen Pool
uint8 constant ACT_SETTLE_ALL           = 0x0c; // Schickt Eingabe-Token zum PoolManager
uint8 constant ACT_TAKE                 = 0x0e; // Holt Output-Token zu explizitem Empfänger

// ─── Standard TickSpacings für V4-Pool-Tiers ─────────────────────────────────
// fee 500   (0,05 %) → tickSpacing 10
// fee 3000  (0,30 %) → tickSpacing 60
// fee 10000 (1,00 %) → tickSpacing 200

// ─── Hauptcontract ────────────────────────────────────────────────────────────

contract DcaVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Konstanten ──────────────────────────────────────────────────────────

    uint256 public constant BPS_DENOMINATOR    = 10_000;
    uint256 public constant MAX_TARGETS        = 10;
    uint256 public constant SWAP_DEADLINE_BUFFER = 10 minutes;

    /// Permit2 ist auf allen EVM-Chains unter derselben Adresse deployed.
    address public constant PERMIT2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ── Immutables ──────────────────────────────────────────────────────────

    address           public immutable owner;
    IUniversalRouter  public immutable universalRouter;

    // ── TargetConfig ────────────────────────────────────────────────────────
    //
    // NEU gegenüber V3-Version:
    //   tickSpacing : benötigt für den V4-PoolKey (V3 kannte nur poolFee).
    //   hooks       : V4-Hook-Adresse; address(0) = kein Hook (Standard).

    struct TargetConfig {
        address token;
        uint16  bps;
        uint24  poolFee;
        int24   tickSpacing; // z.B. 10 für 0,05 %-Pool, 60 für 0,3 %-Pool
        address hooks;       // address(0) für hooklosen Pool
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

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error NotExecutor();
    error InvalidAddress();
    error AlreadyInitialized();
    error NotInitialized();
    error PlanCancelled();
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
    error InvalidTickSpacing();   // NEU: tickSpacing muss > 0 sein

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
        if (!initialized)            revert NotInitialized();
        if (cancelled)               revert PlanCancelled();
        if (currentStep >= totalSteps) revert PlanComplete();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _universalRouter, address _owner) {
        if (_universalRouter == address(0) || _owner == address(0))
            revert InvalidAddress();
        universalRouter = IUniversalRouter(_universalRouter);
        owner = _owner;
    }

    // ── setupPlan ────────────────────────────────────────────────────────────
    //
    // NEU: _tickSpacings (int24[]) und _hooks (address[]) als Parameter.
    // Sie sind Teil des V4-PoolKey und müssen zu einem existierenden Pool passen.

    function setupPlan(
        address   _inputToken,
        uint256   _totalAmount,
        uint32    _duration,
        uint256   _interval,
        uint256   _firstExecutionTimestamp,
        address[] calldata _targetTokens,
        uint16[]  calldata _targetBps,
        uint24[]  calldata _poolFees,
        int24[]   calldata _tickSpacings,   // NEU
        address[] calldata _hooks           // NEU (address(0) = kein Hook)
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

        if (
            targetsLength != _targetBps.length     ||
            targetsLength != _poolFees.length      ||
            targetsLength != _tickSpacings.length  ||
            targetsLength != _hooks.length
        ) revert LengthMismatch();

        if (_totalAmount < _duration) revert InvalidAmount();

        uint256 totalBps;

        for (uint256 i = 0; i < targetsLength; ) {
            address target      = _targetTokens[i];
            uint16  bps         = _targetBps[i];
            uint24  poolFee     = _poolFees[i];
            int24   tickSpacing = _tickSpacings[i];
            address hooks       = _hooks[i];

            if (target == address(0) || target == _inputToken)
                revert InvalidAddress();
            if (bps == 0)         revert AllocationInvalid();
            if (poolFee == 0)     revert InvalidAmount();
            if (tickSpacing <= 0) revert InvalidTickSpacing();

            for (uint256 j = 0; j < i; ) {
                if (_targetTokens[j] == target) revert DuplicateTarget();
                unchecked { ++j; }
            }

            targetConfigs.push(TargetConfig({
                token:       target,
                bps:         bps,
                poolFee:     poolFee,
                tickSpacing: tickSpacing,
                hooks:       hooks
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
    // Für jeden Zieltoken:
    //   1. Permit2-Allowance setzen (inputToken → Permit2 → universalRouter)
    //   2. V4-PoolKey aus TargetConfig bauen
    //   3. V4_SWAP-Command für den UniversalRouter kodieren
    //   4. universalRouter.execute(...) aufrufen
    //   5. Output-Token gehen direkt an `owner` (via ACT_TAKE)

    function executeStep(
        uint256[] calldata minAmountsOut
    ) external onlyExecutor activePlan nonReentrant {
        if (block.timestamp < nextExecutionTimestamp) revert TooEarly();

        uint256 configsLength = targetConfigs.length;
        if (minAmountsOut.length != configsLength) revert LengthMismatch();

        uint32 step = currentStep + 1;
        currentStep            = step;
        nextExecutionTimestamp += interval;

        uint256 vaultBalance      = inputToken.balanceOf(address(this));
        uint256 amountForThisStep = step == totalSteps
            ? vaultBalance
            : trancheAmount;

        if (amountForThisStep == 0)             revert NothingToExecute();
        if (vaultBalance < amountForThisStep)   revert InsufficientVaultBalance();

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

            // ── Permit2-Allowance setzen ─────────────────────────────────
            //
            // Schritt 1: ERC-20 Allowance vom Vault auf Permit2 setzen.
            //            forceApprove setzt zuerst auf 0, dann auf amountIn,
            //            um das USDT-Double-Approve-Problem zu umgehen.
            inputToken.forceApprove(PERMIT2, amountIn);

            // Schritt 2: Permit2 erlaubt dem UniversalRouter, den Token zu ziehen.
            //            Expiration = aktuelle Zeit + Deadline-Buffer (reicht für
            //            diese Transaktion, hinterlässt keine offene Allowance).
            IPermit2(PERMIT2).approve(
                address(inputToken),
                address(universalRouter),
                uint160(amountIn),
                uint48(block.timestamp + SWAP_DEADLINE_BUFFER)
            );

            // ── V4 PoolKey bauen ─────────────────────────────────────────
            //
            // V4 verlangt currency0 < currency1 (address-sortiert).
            // zeroForOne = true  → inputToken ist currency0 (swap 0→1)
            // zeroForOne = false → inputToken ist currency1 (swap 1→0)

            address inputAddr  = address(inputToken);
            address outputAddr = config.token;

            bool    zeroForOne;
            address currency0;
            address currency1;

            if (inputAddr < outputAddr) {
                zeroForOne = true;
                currency0  = inputAddr;
                currency1  = outputAddr;
            } else {
                zeroForOne = false;
                currency0  = outputAddr;
                currency1  = inputAddr;
            }

            // ── V4-Swap-Input kodieren ───────────────────────────────────
            //
            // Aufbau des V4_SWAP-Inputs für den UniversalRouter:
            //
            //   bytes v4Input = abi.encode(
            //       bytes  actions,   // packed: [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE]
            //       bytes[] params    // params[0] = SwapParams, params[1] = SettleParams, params[2] = TakeParams
            //   )
            //
            // ACT_SETTLE_ALL (0x0c): schickt amountIn aus Permit2 in den PoolManager.
            // ACT_TAKE       (0x0e): sendet amountOut direkt an `owner` (kein Extra-Transfer nötig).

            bytes memory v4Actions = abi.encodePacked(
                ACT_SWAP_EXACT_IN_SINGLE, // 0x06
                ACT_SETTLE_ALL,           // 0x0c
                ACT_TAKE                  // 0x0e
            );

            bytes[] memory v4Params = new bytes[](3);

            // params[0]: ExactInputSingleParams
            // (PoolKey wird als Tuple inline kodiert — kein Import von V4-Typen nötig)
            v4Params[0] = abi.encode(
                // PoolKey
                currency0,           // currency0 (address, wird als Currency interpretiert)
                currency1,           // currency1
                config.poolFee,      // uint24 fee
                config.tickSpacing,  // int24 tickSpacing
                config.hooks,        // address hooks (IHooks)
                // ExactInputSingleParams Felder
                zeroForOne,          // bool zeroForOne
                uint128(amountIn),   // uint128 amountIn
                uint128(minAmountOut), // uint128 amountOutMinimum
                bytes("")            // hookData (leer = kein Hook-Kontext)
            );

            // params[1]: SETTLE_ALL — welcher Token, wie viel maximal
            v4Params[1] = abi.encode(
                inputAddr,  // Currency (= address des Input-Tokens)
                amountIn    // maxAmount
            );

            // params[2]: TAKE — Output-Token direkt an owner senden
            v4Params[2] = abi.encode(
                outputAddr,    // Currency (= address des Output-Tokens)
                owner,         // to: direkt an den Plan-Owner, kein Extra-Transfer
                minAmountOut   // minAmount (Slippage-Schutz on-chain)
            );

            bytes memory v4SwapInput = abi.encode(v4Actions, v4Params);

            // ── UniversalRouter aufrufen ─────────────────────────────────

            uint256 balanceBefore = IERC20(outputAddr).balanceOf(owner);

            bytes memory commands = abi.encodePacked(CMD_V4_SWAP); // 0x10
            bytes[] memory inputs = new bytes[](1);
            inputs[0] = v4SwapInput;

            universalRouter.execute(
                commands,
                inputs,
                block.timestamp + SWAP_DEADLINE_BUFFER
            );

            // Permit2-Allowance auf 0 zurücksetzen (Sicherheit)
            inputToken.forceApprove(PERMIT2, 0);

            uint256 amountOut = IERC20(outputAddr).balanceOf(owner) - balanceBefore;

            emit DcaSwapExecuted(step, config.token, amountIn, amountOut);

            unchecked { ++i; }
        }

        emit DcaStepExecuted(step, amountForThisStep);
    }

    // ── cancelPlan ───────────────────────────────────────────────────────────

    function cancelPlan() external onlyOwner nonReentrant {
        if (!initialized) revert NotInitialized();
        if (cancelled)    revert PlanCancelled();
        cancelled = true;

        // Offene Permit2-Allowance sicherheitshalber schließen
        inputToken.forceApprove(PERMIT2, 0);

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
