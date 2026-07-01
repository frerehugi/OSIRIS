import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  parseUnits,
} from "viem";
import { celo } from "viem/chains";
import { DCA_VAULT_ABI, ERC20_ABI } from "./dcaVaultAbi";
import {
  VAULT_ADDRESS,
  UNIVERSAL_ROUTER,
  INPUT_TOKENS,
  TARGET_TOKENS,
  INTERVAL_SECONDS,
} from "./config";
import type { DcaPlanState } from "./types";

// ─── Provider ─────────────────────────────────────────────────────────────────

function getMiniPayProvider() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("Kein Wallet-Provider gefunden. Öffne die App in MiniPay.");
  }
  return window.ethereum;
}

export function getClients() {
  const provider = getMiniPayProvider();
  const walletClient = createWalletClient({ chain: celo, transport: custom(provider) });
  const publicClient = createPublicClient({ chain: celo, transport: http() });
  return { walletClient, publicClient };
}

export async function connectWallet(): Promise<`0x${string}`> {
  const { walletClient } = getClients();
  const [address] = await walletClient.getAddresses();
  if (!address) throw new Error("Wallet-Verbindung abgelehnt oder fehlgeschlagen.");
  return address;
}

// ─── Target-Arrays bauen ──────────────────────────────────────────────────────
// NEU: gibt jetzt auch tickSpacings[] und hooks[] zurück.

function buildTargetArrays(percentages: Record<string, number>): {
  targetTokens: `0x${string}`[];
  targetBps:    number[];   // uint16[]
  poolFees:     number[];   // uint24[]
  tickSpacings: number[];   // int24[]
  hooks:        `0x${string}`[]; // address[] — address(0) = kein Hook
} {
  const targetTokens:  `0x${string}`[] = [];
  const targetBps:     number[]        = [];
  const poolFees:      number[]        = [];
  const tickSpacings:  number[]        = [];
  const hooks:         `0x${string}`[] = [];

  for (const [symbol, pct] of Object.entries(percentages)) {
    if (pct <= 0) continue;
    const token = TARGET_TOKENS[symbol as keyof typeof TARGET_TOKENS];
    if (!token) throw new Error(`Unbekanntes Zieltoken: ${symbol}`);

    targetTokens.push(token.address);
    targetBps.push(Math.round(pct * 100));    // 1 % → 100 bps (uint16)
    poolFees.push(token.poolFee);             // uint24
    tickSpacings.push(token.tickSpacing);     // int24 — NEU
    hooks.push("0x0000000000000000000000000000000000000000"); // kein Hook — NEU
  }

  const sum = targetBps.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) {
    throw new Error(`Allokation ergibt ${sum / 100} % statt 100 %.`);
  }
  return { targetTokens, targetBps, poolFees, tickSpacings, hooks };
}

// ─── Execution Timestamp ──────────────────────────────────────────────────────

function nextExecutionTimestamp(executionTimeLocal: string): bigint {
  const [hours, minutes] = executionTimeLocal.split(":").map(Number);
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= now.getTime() + 60_000) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return BigInt(Math.floor(candidate.getTime() / 1000));
}

// ─── DCA-Plan submitten ────────────────────────────────────────────────────────
// setupPlan bekommt jetzt 10 Parameter (statt 8) — tickSpacings + hooks neu.

export async function submitDcaPlan(
  formData: DcaPlanState,
  ownerAddress: `0x${string}`
) {
  if (!formData.interval) throw new Error("Intervall fehlt.");

  const inputToken     = INPUT_TOKENS[formData.inputToken];
  const totalAmountRaw = parseUnits(formData.totalAmount, inputToken.decimals);
  const duration       = parseInt(formData.duration, 10);
  const interval       = BigInt(INTERVAL_SECONDS[formData.interval]);
  const firstExecution = nextExecutionTimestamp(formData.executionTime);

  if (totalAmountRaw <= 0n) throw new Error("Gesamtbetrag muss > 0 sein.");
  if (duration <= 0)        throw new Error("Dauer muss > 0 sein.");

  const { targetTokens, targetBps, poolFees, tickSpacings, hooks } =
    buildTargetArrays(formData.percentages);

  const { walletClient, publicClient } = getClients();

  // ERC-20 Approve: Vault darf Token ziehen (für setupPlan / safeTransferFrom)
  const approveTx = await walletClient.writeContract({
    account: ownerAddress,
    address: inputToken.address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [VAULT_ADDRESS, totalAmountRaw],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  // setupPlan mit allen 10 Parametern aufrufen
  const hash = await walletClient.writeContract({
    account:  ownerAddress,
    address:  VAULT_ADDRESS,
    abi:      DCA_VAULT_ABI,
    functionName: "setupPlan",
    args: [
      inputToken.address,  // _inputToken
      totalAmountRaw,      // _totalAmount
      duration,            // _duration  (uint32)
      interval,            // _interval  (uint256)
      firstExecution,      // _firstExecutionTimestamp (uint256)
      targetTokens,        // _targetTokens  (address[])
      targetBps,           // _targetBps     (uint16[])
      poolFees,            // _poolFees      (uint24[])
      tickSpacings,        // _tickSpacings  (int24[])  ← NEU
      hooks,               // _hooks         (address[]) ← NEU
    ],
  });

  return publicClient.waitForTransactionReceipt({ hash });
}

// ─── Plan-Status lesen ────────────────────────────────────────────────────────

export async function readPlanStatus(contractAddress: `0x${string}`) {
  const { publicClient } = getClients();
  const [
    initialized, cancelled, currentStep, totalSteps,
    nextExecTs, remainingBalance, trancheAmt,
  ] = await Promise.all([
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "initialized" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "cancelled" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "currentStep" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "totalSteps" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "nextExecutionTimestamp" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "remainingInputBalance" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "trancheAmount" }),
  ]);
  return { initialized, cancelled, currentStep, totalSteps,
           nextExecutionTimestamp: nextExecTs, remainingBalance, trancheAmount: trancheAmt };
}
