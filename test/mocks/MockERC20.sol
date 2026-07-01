// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimaler ERC-20 Mock für Tests und Celo-Sepolia-Deployment.
/// @dev    Jeder kann sich beliebig viele Token minten (nur für Tests!).
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals_
    ) ERC20(name, symbol) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint beliebige Menge an eine Adresse (nur Testnet!).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
