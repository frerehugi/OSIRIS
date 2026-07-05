// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Simuliert das Verhalten eines Squid-Routers für Tests:
///         zieht `fromAmount` von `msg.sender` (= Vault, per Allowance) und
///         schickt `toAmount` von `toToken` an `to` (= Owner).
contract MockSquidRouter {
    bool public shouldFail;

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function swap(
        address fromToken,
        uint256 fromAmount,
        address toToken,
        uint256 toAmount,
        address to
    ) external {
        require(!shouldFail, "MockSquidRouter: forced failure");
        IERC20(fromToken).transferFrom(msg.sender, address(this), fromAmount);
        IERC20(toToken).transfer(to, toAmount);
    }
}
