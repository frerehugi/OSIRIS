// ABI für SendVault + SendVaultFactory — OSIRIS' Auszahlungs-Erweiterung
// neben DcaVault/TriggerVault (siehe dcaVaultAbi.ts/triggerVaultAbi.ts).
// Abgeleitet aus SendVault.sol/SendVaultFactory.sol (pragma ^0.8.20).
//
// Reiner Multi-Empfänger-Payout, kein Swap — kein Router/Calldata-Parameter
// irgendwo in diesem ABI, anders als bei DcaVault/TriggerVault.

export const SEND_VAULT_ABI = [

  // ─── Constructor ────────────────────────────────────────────────────────────
  {
    type: "constructor",
    inputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner",        type: "address" },
      { name: "_globalKeeper", type: "address" },
    ],
    outputs: [],
  },

  // ─── Immutables / Public State ──────────────────────────────────────────────
  {
    type: "function", name: "owner",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "factory",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "initialized",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "cancelled",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "token",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "totalSteps",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function", name: "currentStep",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function", name: "interval",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "nextExecutionTimestamp",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "isKeeper",
    stateMutability: "view",
    inputs:  [{ name: "keeper", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ─── Write Functions ─────────────────────────────────────────────────────────
  {
    type: "function",
    name: "setupPlan",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_token", type: "address" },
      {
        name: "_recipients", type: "tuple[]",
        components: [
          { name: "wallet",      type: "address" },
          { name: "totalAmount", type: "uint256" },
        ],
      },
      { name: "_duration",               type: "uint32"  },
      { name: "_interval",               type: "uint256" },
      { name: "_firstExecutionTimestamp", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setKeeper",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keeper",  type: "address" },
      { name: "allowed", type: "bool"    },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeStep",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelPlan",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },

  // ─── View Functions ──────────────────────────────────────────────────────────
  {
    type: "function",
    name: "canExecute",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "amountForRecipientAtStep",
    stateMutability: "view",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "step",  type: "uint32"  },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getRecipients",
    stateMutability: "view",
    inputs: [],
    outputs: [{
      name: "", type: "tuple[]",
      components: [
        { name: "wallet",      type: "address" },
        { name: "totalAmount", type: "uint256" },
      ],
    }],
  },
  {
    type: "function",
    name: "recipientCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "remainingSteps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "remainingBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ─── Events ──────────────────────────────────────────────────────────────────
  {
    type: "event", name: "PlanCreated",
    inputs: [
      { name: "owner",                    type: "address", indexed: true  },
      { name: "token",                    type: "address", indexed: true  },
      { name: "totalAmount",              type: "uint256", indexed: false },
      { name: "totalSteps",               type: "uint32",  indexed: false },
      { name: "interval",                 type: "uint256", indexed: false },
      { name: "firstExecutionTimestamp",  type: "uint256", indexed: false },
      { name: "recipientCount",           type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "KeeperUpdated",
    inputs: [
      { name: "keeper",  type: "address", indexed: true  },
      { name: "allowed", type: "bool",    indexed: false },
    ],
  },
  {
    type: "event", name: "StepExecuted",
    inputs: [
      { name: "step",           type: "uint32",  indexed: true  },
      { name: "totalAmountOut", type: "uint256", indexed: false },
      { name: "feeAmount",      type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "RecipientPaid",
    inputs: [
      { name: "step",      type: "uint32",  indexed: true  },
      { name: "recipient", type: "address", indexed: true  },
      { name: "amount",    type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "PlanCancelled",
    inputs: [{ name: "remainingBalance", type: "uint256", indexed: false }],
  },
  {
    type: "event", name: "FeeCharged",
    inputs: [
      { name: "step",      type: "uint32",  indexed: true  },
      { name: "feeAmount", type: "uint256", indexed: false },
      { name: "treasury",  type: "address", indexed: false },
    ],
  },

  // ─── Custom Errors ────────────────────────────────────────────────────────────
  { type: "error", name: "NotOwner",                 inputs: [] },
  { type: "error", name: "NotExecutor",              inputs: [] },
  { type: "error", name: "InvalidAddress",           inputs: [] },
  { type: "error", name: "AlreadyInitialized",       inputs: [] },
  { type: "error", name: "NotInitialized",           inputs: [] },
  { type: "error", name: "PlanAlreadyCancelled",     inputs: [] },
  { type: "error", name: "PlanComplete",             inputs: [] },
  { type: "error", name: "TooEarly",                 inputs: [] },
  { type: "error", name: "InvalidAmount",            inputs: [] },
  { type: "error", name: "InvalidDuration",          inputs: [] },
  { type: "error", name: "InvalidInterval",          inputs: [] },
  { type: "error", name: "InvalidTimestamp",         inputs: [] },
  { type: "error", name: "NoRecipients",             inputs: [] },
  { type: "error", name: "TooManyRecipients",        inputs: [] },
  { type: "error", name: "FeeOnTransferUnsupported", inputs: [] },
  { type: "error", name: "FeeExceedsAmount",         inputs: [] },
  { type: "error", name: "NothingToExecute",         inputs: [] },
] as const;

// ─── SendVaultFactory ABI ──────────────────────────────────────────────────────
// Abgeleitet aus SendVaultFactory.sol — erzeugt pro Plan einen eigenen
// SendVault-Clone (EIP-1167) über createVault(). Kein squidRouter-Immutable
// (anders als DcaVaultFactory/TriggerVaultFactory), und feeInfo() nimmt das
// Token entgegen statt parameterlos zu sein (siehe SendVaultFactory.sol,
// minFeeByToken-Kommentar).

export const SEND_VAULT_FACTORY_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "_vaultImplementation", type: "address" },
      { name: "_globalKeeper",        type: "address" },
      { name: "_admin",               type: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function", name: "vaultImplementation",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "globalKeeper",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "admin",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "feeBps",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function", name: "minFeeByToken",
    stateMutability: "view",
    inputs:  [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "createVault",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "function",
    name: "getVaults",
    stateMutability: "view",
    inputs:  [{ name: "_owner", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getAllVaults",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "vaultCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "feeInfo",
    stateMutability: "view",
    inputs: [{ name: "_token", type: "address" }],
    outputs: [
      { name: "_feeBps",   type: "uint16"  },
      { name: "_minFee",   type: "uint256" },
      { name: "_treasury", type: "address" },
    ],
  },
  {
    type: "function",
    name: "setFee",
    stateMutability: "nonpayable",
    inputs: [{ name: "_feeBps", type: "uint16" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setMinFee",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_token",  type: "address" },
      { name: "_minFee", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setAdmin",
    stateMutability: "nonpayable",
    inputs: [{ name: "_admin", type: "address" }],
    outputs: [],
  },
  {
    type: "event", name: "VaultCreated",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "vault", type: "address", indexed: true },
    ],
  },
  {
    type: "event", name: "FeeUpdated",
    inputs: [{ name: "feeBps", type: "uint16", indexed: false }],
  },
  {
    type: "event", name: "MinFeeUpdated",
    inputs: [
      { name: "token",  type: "address", indexed: true  },
      { name: "minFee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "AdminUpdated",
    inputs: [{ name: "admin", type: "address", indexed: true }],
  },
  { type: "error", name: "InvalidAddress", inputs: [] },
  { type: "error", name: "NotAdmin",       inputs: [] },
  { type: "error", name: "FeeTooHigh",     inputs: [] },
] as const;
