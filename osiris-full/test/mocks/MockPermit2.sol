// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Mock des Permit2-Contracts für Unit-Tests.
/// @dev    Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3) ist auf
///         Celo Sepolia deployed. Für lokale Tests simulieren wir nur
///         die approve()-Funktion die DcaVault aufruft.
contract MockPermit2 {
    struct Allowance {
        uint160 amount;
        uint48  expiration;
    }

    // token → owner → spender → allowance
    mapping(address => mapping(address => mapping(address => Allowance)))
        public allowances;

    uint256 public approveCallCount;

    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48  expiration
    ) external {
        allowances[token][msg.sender][spender] = Allowance(amount, expiration);
        approveCallCount++;
    }

    function getAllowance(
        address token,
        address owner,
        address spender
    ) external view returns (uint160 amount, uint48 expiration) {
        Allowance memory a = allowances[token][owner][spender];
        return (a.amount, a.expiration);
    }
}
