// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Zieht bei jedem transfer()/transferFrom() zusätzlich feeBps vom
///         Empfänger ab (an burnSink) — reicht aus, um SendVault/DcaVault/
///         TriggerVaults FeeOnTransferUnsupported-Schutz (balanceBefore/
///         -After-Delta-Check in setupPlan()) auszulösen.
contract MockFeeOnTransferERC20 is ERC20 {
    uint16 public feeBps;
    address public burnSink = address(0xdead);

    constructor(string memory name, string memory symbol, uint16 _feeBps) ERC20(name, symbol) {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, to, value - fee);
            super._update(from, burnSink, fee);
        } else {
            super._update(from, to, value);
        }
    }
}
