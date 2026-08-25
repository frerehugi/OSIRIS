// ABI für TriggerVault + TriggerVaultFactory — OSIRIS' Price-Trigger-
// Erweiterung neben DcaVault/DcaVaultFactory (siehe dcaVaultAbi.ts).
// Abgeleitet aus TriggerVault.sol/TriggerVaultFactory.sol (pragma ^0.8.20).
//
// Buy-Plan (heldToken=Stablecoin, outputToken=Zieltoken) und Sell-Plan
// (heldToken=Zieltoken, outputToken=Stablecoin) sind derselbe Contract, nur
// mit vertauschten Token — siehe TriggerVault.sol-Architekturkommentar.

export const TRIGGER_VAULT_ABI = [

  // ─── Constructor ────────────────────────────────────────────────────────────
  // Parameterlos — TriggerVault ist die Clone-Implementation, echte Instanzen
  // entstehen über TriggerVaultFactory.createVault() + initialize().
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
      { name: "_squidRouter",  type: "address" },
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
    type: "function", name: "executed",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "heldToken",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "outputToken",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "watchToken",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "amount",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "triggerAbove",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "triggerPrice",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "expiresAt",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "isKeeper",
    stateMutability: "view",
    inputs:  [{ name: "keeper", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "approvedRouters",
    stateMutability: "view",
    inputs:  [{ name: "router", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ─── Write Functions ─────────────────────────────────────────────────────────
  {
    type: "function",
    name: "setupPlan",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_heldToken",    type: "address" },
      { name: "_outputToken",  type: "address" },
      { name: "_watchToken",   type: "address" },
      { name: "_amount",       type: "uint256" },
      { name: "_triggerAbove", type: "bool"    },
      { name: "_triggerPrice", type: "uint256" },
      { name: "_expiresAt",    type: "uint256" },
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
    name: "setRouter",
    stateMutability: "nonpayable",
    inputs: [
      { name: "router",  type: "address" },
      { name: "allowed", type: "bool"    },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "router",       type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "swapCalldata", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
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

  // ─── Events ──────────────────────────────────────────────────────────────────
  {
    type: "event", name: "TriggerPlanCreated",
    inputs: [
      { name: "owner",        type: "address", indexed: true  },
      { name: "heldToken",    type: "address", indexed: true  },
      { name: "outputToken",  type: "address", indexed: false },
      { name: "watchToken",   type: "address", indexed: false },
      { name: "amount",       type: "uint256", indexed: false },
      { name: "triggerAbove", type: "bool",    indexed: false },
      { name: "triggerPrice", type: "uint256", indexed: false },
      { name: "expiresAt",    type: "uint256", indexed: false },
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
    type: "event", name: "RouterUpdated",
    inputs: [
      { name: "router",  type: "address", indexed: true  },
      { name: "allowed", type: "bool",    indexed: false },
    ],
  },
  {
    type: "event", name: "TriggerExecuted",
    inputs: [
      { name: "amountIn",  type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "PlanCancelled",
    inputs: [{ name: "remainingBalance", type: "uint256", indexed: false }],
  },
  {
    type: "event", name: "FeeCharged",
    inputs: [
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
  { type: "error", name: "PlanAlreadyExecuted",      inputs: [] },
  { type: "error", name: "InvalidAmount",            inputs: [] },
  { type: "error", name: "InvalidTriggerPrice",      inputs: [] },
  { type: "error", name: "InvalidTimestamp",         inputs: [] },
  { type: "error", name: "SameToken",                inputs: [] },
  { type: "error", name: "FeeOnTransferUnsupported", inputs: [] },
  { type: "error", name: "MinOutRequired",           inputs: [] },
  { type: "error", name: "RouterNotApproved",        inputs: [] },
  { type: "error", name: "SwapFailed",               inputs: [] },
  { type: "error", name: "SlippageExceeded",         inputs: [] },
  { type: "error", name: "FeeExceedsAmount",         inputs: [] },
  { type: "error", name: "Expired",                  inputs: [] },
] as const;

// ─── TriggerVaultFactory ABI ──────────────────────────────────────────────────
// Abgeleitet aus TriggerVaultFactory.sol — erzeugt pro Plan einen eigenen
// TriggerVault-Clone (EIP-1167) über createVault().

export const TRIGGER_VAULT_FACTORY_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "_vaultImplementation", type: "address" },
      { name: "_squidRouter",         type: "address" },
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
    type: "function", name: "squidRouter",
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
    inputs: [],
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
    inputs: [
      { name: "_feeBps", type: "uint16"  },
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
    inputs: [
      { name: "feeBps", type: "uint16",  indexed: false },
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
