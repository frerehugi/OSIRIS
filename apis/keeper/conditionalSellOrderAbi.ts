// ABI-Ausschnitt für ConditionalSellOrder — nur die Funktionen, die der
// Apis-Keeper tatsächlich braucht (siehe contracts/ConditionalSellOrder.sol).
// Kein Full-ABI-Export nötig, der Contract wird ausschließlich hier gelesen/
// ausgeführt, nicht vom Frontend (das nur createOrder()/cancelOrder() selbst
// über MiniPay signiert, siehe apis/backend/src/planCompiler.ts).

export const CONDITIONAL_SELL_ORDER_ABI = [
  {
    type: "function", name: "nextOrderId",
    stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "owner",         type: "address" },
        { name: "sellToken",     type: "address" },
        { name: "targetToken",   type: "address" },
        { name: "bps",           type: "uint16" },
        { name: "maxExecutions", type: "uint32" },
        { name: "executedCount", type: "uint32" },
        { name: "cancelled",     type: "bool" },
        { name: "triggerAbove",  type: "bool" },
        { name: "triggerPrice",  type: "uint256" },
      ],
    }],
  },
  {
    type: "function", name: "isKeeperFor",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "keeper", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId",      type: "uint256" },
      { name: "router",       type: "address" },
      { name: "minAmountOut", type: "uint256" },
      { name: "swapCalldata", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface SellOrderStruct {
  owner:         `0x${string}`;
  sellToken:     `0x${string}`;
  targetToken:   `0x${string}`;
  bps:           number;
  maxExecutions: number;
  executedCount: number;
  cancelled:     boolean;
  triggerAbove:  boolean;
  triggerPrice:  bigint;
}
