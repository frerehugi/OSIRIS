// ABI für DcaVault — Squid-Router-Architektur
// Abgeleitet aus DcaVault.sol (pragma ^0.8.20).
//
// Der Vault ruft keinen DEX-Router mehr selbst fest verdrahtet auf. Der
// Keeper holt off-chain eine fertige Route von der Squid-API und übergibt
// Router-Adresse + Calldata pro Zieltoken an executeStep(). Nur vom Owner via
// setRouter() freigegebene Router-Adressen dürfen dabei als Ziel genutzt
// werden.

export const DCA_VAULT_ABI = [

  // ─── Constructor ────────────────────────────────────────────────────────────
  // Parameterlos — DcaVault ist die Clone-Implementation, echte Instanzen
  // entstehen über DcaVaultFactory.createVault() + initialize().
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
      { name: "_owner",       type: "address" },
      { name: "_squidRouter", type: "address" },
    ],
    outputs: [],
  },

  // ─── Constants ──────────────────────────────────────────────────────────────
  {
    type: "function", name: "BPS_DENOMINATOR",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "MAX_TARGETS",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ─── Immutables / Public State ──────────────────────────────────────────────
  {
    type: "function", name: "owner",
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
    type: "function", name: "inputToken",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function", name: "totalDeposited",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "trancheAmount",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "interval",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
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
      { name: "_inputToken",              type: "address"   },
      { name: "_totalAmount",             type: "uint256"   },
      { name: "_duration",                type: "uint32"    },
      { name: "_interval",                type: "uint256"   },
      { name: "_firstExecutionTimestamp", type: "uint256"   },
      { name: "_targetTokens",            type: "address[]" },
      { name: "_targetBps",               type: "uint16[]"  },
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
    name: "executeStep",
    stateMutability: "nonpayable",
    inputs: [
      { name: "routers",       type: "address[]" },
      { name: "minAmountsOut", type: "uint256[]" },
      { name: "squidCallData", type: "bytes[]"   },
    ],
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
    name: "getTargetConfigs",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "bps",   type: "uint16"  },
        ],
      },
    ],
  },
  {
    type: "function", name: "targetConfigCount",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "remainingSteps",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function", name: "remainingInputBalance",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ─── Events ──────────────────────────────────────────────────────────────────
  {
    type: "event", name: "DcaPlanCreated",
    inputs: [
      { name: "owner",                   type: "address", indexed: true  },
      { name: "inputToken",              type: "address", indexed: true  },
      { name: "totalAmount",             type: "uint256", indexed: false },
      { name: "trancheAmount",           type: "uint256", indexed: false },
      { name: "totalSteps",              type: "uint32",  indexed: false },
      { name: "interval",                type: "uint256", indexed: false },
      { name: "firstExecutionTimestamp", type: "uint256", indexed: false },
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
    type: "event", name: "DcaSwapExecuted",
    inputs: [
      { name: "step",        type: "uint32",  indexed: true  },
      { name: "targetToken", type: "address", indexed: true  },
      { name: "amountIn",    type: "uint256", indexed: false },
      { name: "amountOut",   type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "DcaStepExecuted",
    inputs: [
      { name: "step",          type: "uint32",  indexed: true  },
      { name: "totalAmountIn", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "PlanCancelled",
    inputs: [{ name: "remainingBalance", type: "uint256", indexed: false }],
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
  { type: "error", name: "InvalidTargets",           inputs: [] },
  { type: "error", name: "DuplicateTarget",          inputs: [] },
  { type: "error", name: "AllocationInvalid",        inputs: [] },
  { type: "error", name: "LengthMismatch",           inputs: [] },
  { type: "error", name: "FeeOnTransferUnsupported", inputs: [] },
  { type: "error", name: "MinOutRequired",           inputs: [] },
  { type: "error", name: "InsufficientVaultBalance", inputs: [] },
  { type: "error", name: "NothingToExecute",         inputs: [] },
  { type: "error", name: "RouterNotApproved",        inputs: [] },
  { type: "error", name: "SwapFailed",               inputs: [] },
  { type: "error", name: "SlippageExceeded",         inputs: [] },
] as const;

// ─── DcaVaultFactory ABI ──────────────────────────────────────────────────────
// Abgeleitet aus DcaVaultFactory.sol — erzeugt pro Nutzer einen eigenen
// DcaVault-Clone (EIP-1167) über createVault().

export const DCA_VAULT_FACTORY_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "_vaultImplementation", type: "address" },
      { name: "_squidRouter",         type: "address" },
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
    type: "event", name: "VaultCreated",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "vault", type: "address", indexed: true },
    ],
  },
  { type: "error", name: "InvalidAddress", inputs: [] },
] as const;

// ─── ERC-20 ABI ───────────────────────────────────────────────────────────────
export const ERC20_ABI = [
  {
    type: "function", name: "approve",
    stateMutability: "nonpayable",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "allowance",
    stateMutability: "view",
    inputs:  [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "balanceOf",
    stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "decimals",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function", name: "symbol",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;
