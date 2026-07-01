// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockUniversalRouter {
    uint256 public executeCallCount;
    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        executeCallCount++;
    }
}
