// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Mock des Uniswap V4 UniversalRouters für Unit-Tests.
/// @dev    Simuliert einen 1:1-Swap (ohne Slippage) zwischen zwei Token.
///         Für realistische Tests: Mock mit konfigurierbarer Rate erweitern.
contract MockUniversalRouter {
    using SafeERC20 for IERC20;

    // Konfigurierbare Output-Rate: outputAmount = inputAmount * rate / 1e18
    // Default: 1:1 (rate = 1e18)
    uint256 public swapRate = 1e18;

    // Letzter empfangener Output-Token (für Test-Assertions)
    address public lastOutputToken;
    uint256 public lastAmountOut;
    uint256 public executeCallCount;

    /// @notice Setzt die Swap-Rate für Tests (z.B. 0.95e18 = 5% Slippage).
    function setSwapRate(uint256 rate) external {
        swapRate = rate;
    }

    /// @notice Simuliert execute() des echten UniversalRouters.
    ///         Zieht inputToken via Permit2 (hier vereinfacht: direkt vom Caller)
    ///         und sendet outputToken an den im V4-Input kodierten Empfänger.
    ///
    ///         Für Tests dekodieren wir den Input nicht vollständig —
    ///         stattdessen erwarten wir, dass der Test die Token vorab
    ///         an den Router überweist und die Ausgabe-Token bereitstellt.
    function execute(
        bytes calldata,          // commands — ignoriert im Mock
        bytes[] calldata,        // inputs   — ignoriert im Mock
        uint256                  // deadline — ignoriert im Mock
    ) external payable {
        executeCallCount++;
        // Echte Swap-Logik wird in Integrationstests gegen Celo Sepolia getestet.
        // Im Unit-Test steuert der Test die Token-Bewegungen manuell.
    }

    /// @notice Hilfsfunktion: simuliert Swap-Output direkt an eine Adresse.
    ///         Wird vom Test aufgerufen um den Router-Output zu simulieren.
    function simulateSwapOutput(
        address outputToken,
        address recipient,
        uint256 amountOut
    ) external {
        lastOutputToken = outputToken;
        lastAmountOut   = amountOut;
        IERC20(outputToken).safeTransfer(recipient, amountOut);
    }
}
