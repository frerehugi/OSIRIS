// ABI-Ausschnitte für TriggerVault + TriggerVaultFactory — nur die Funktionen,
// die der Apis-Keeper tatsächlich braucht (siehe contracts/TriggerVault.sol /
// TriggerVaultFactory.sol). Ersetzt conditionalSellOrderAbi.ts (siehe Chat:
// "eigener Vault pro Plan" ersetzt den geteilten ConditionalSellOrder-Contract).

export const TRIGGER_VAULT_FACTORY_ABI = [
  {
    type: "function", name: "getAllVaults",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function", name: "feeInfo",
    stateMutability: "view", inputs: [],
    outputs: [
      { name: "_feeBps",   type: "uint16"  },
      { name: "_minFee",   type: "uint256" },
      { name: "_treasury", type: "address" },
    ],
  },
] as const;

export const TRIGGER_VAULT_ABI = [
  {
    type: "function", name: "owner",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "heldToken",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "outputToken",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "watchToken",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "amount",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "triggerAbove",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "triggerPrice",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "expiresAt",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "canExecute",
    stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "isKeeper",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "router",       type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "swapCalldata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface TriggerVaultState {
  address:      `0x${string}`;
  owner:        `0x${string}`;
  heldToken:    `0x${string}`;
  outputToken:  `0x${string}`;
  watchToken:   `0x${string}`;
  amount:       bigint;
  triggerAbove: boolean;
  triggerPrice: bigint;
  expiresAt:    bigint;
}
