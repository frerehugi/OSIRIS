// ABI-Ausschnitt für ConditionalSellOrder — nur createOrder(), das Einzige,
// was das Frontend selbst aufruft (siehe contracts/ConditionalSellOrder.sol).
// Eigene, unabhängige Kopie statt eines Imports aus apis/keeper — dieses
// Package hat bewusst kein eigenes package.json-übergreifendes Sharing (siehe
// Gesamtplan §22, "eigenes package.json statt npm-Workspaces").

export const CONDITIONAL_SELL_ORDER_ABI = [
  {
    type: "function", name: "createOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sellToken",     type: "address" },
      { name: "targetToken",   type: "address" },
      { name: "bps",           type: "uint16" },
      { name: "maxExecutions", type: "uint32" },
      { name: "triggerAbove",  type: "bool" },
      { name: "triggerPrice",  type: "uint256" },
    ],
    outputs: [{ name: "orderId", type: "uint256" }],
  },
] as const;
