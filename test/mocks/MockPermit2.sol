// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockPermit2 {
    uint256 public approveCallCount;
    function approve(address, address, uint160, uint48) external {
        approveCallCount++;
    }
}
