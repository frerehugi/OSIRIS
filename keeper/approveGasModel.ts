// Erweiterung von feeAnalysis.ts: bezieht echte approve()-Gaskosten von einer
// Test-Wallet ein (der Keeper selbst hat noch NIE approve() aufgerufen, da
// noch kein Auto-Refuel-Swap ausgelöst wurde — feeAnalysis.ts Ergebnis:
// 0 ausgehende Transfers). approve() ist aber Teil jedes künftigen Refuel-
// Zyklus (refuelFromToken() in squidKeeper.ts: approve() + Swap-Tx), daher
// hier eine reale Stichprobe von einer Wallet, die approve() auf denselben
// Stablecoin-Contracts bereits ausgeführt hat (User-Flow: submitDcaPlan()
// Phase 2 approved USDC/USDT an die eigene Vault).
//
// Baut daraus ein Modell für die künftigen, noch nicht eingetretenen Refuel-
// Zyklen und rechnet den Break-even-CELO-Preis unter realistischeren
// Annahmen neu.

import { createPublicClient, http, fallback, parseAbiItem, formatUnits, formatEther } from "viem";
import { celo } from "viem/chains";
import { INPUT_TOKENS } from "../src/config";

const TEST_WALLET = "0xea40040538bde54cdfc97e1f0cd90da2aab0c453" as const;

const RPC_URLS = [
  "https://forno.celo.org",
  "https://rpc.ankr.com/celo",
];

const publicClient = createPublicClient({
  chain: celo,
  transport: fallback(RPC_URLS.map((url) => http(url))),
});

const APPROVAL_EVENT = parseAbiItem(
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
);

const INITIAL_LOG_BLOCK_RANGE = 5_000n;
const MIN_LOG_BLOCK_RANGE = 1n;

function isBlockRangeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("block range") ||
    message.includes("range is too large") ||
    message.includes("exceeds range") ||
    message.includes("query returned more than") ||
    message.includes("limit exceeded") ||
    message.includes("too many blocks")
  );
}

async function withRetry<T>(fn: () => Promise<T>, isNonRetryable?: (e: unknown) => boolean): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isNonRetryable?.(error)) throw error;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

// Findet per Binärsuche den ersten Block, in dem die Wallet bereits eine
// Nonce > 0 hat (also mindestens eine Transaktion gesendet hat) — spart uns
// das Scannen der kompletten Chain-Historie (>70 Mio. Blöcke) für die
// Approval-Logs weiter unten.
async function findFirstActivityBlock(address: `0x${string}`): Promise<bigint> {
  const latest = await publicClient.getBlockNumber();
  const latestCount = await withRetry(() => publicClient.getTransactionCount({ address, blockNumber: latest }));
  if (latestCount === 0) return latest; // Wallet noch nie aktiv
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const count = await withRetry(() => publicClient.getTransactionCount({ address, blockNumber: mid }));
    if (count > 0) {
      hi = mid;
    } else {
      lo = mid + 1n;
    }
  }
  return lo;
}

async function getApprovalLogsChunked(
  tokenAddress: `0x${string}`,
  owner: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const allLogs = [];
  let start = fromBlock;
  let range = INITIAL_LOG_BLOCK_RANGE;

  while (start <= toBlock) {
    const end = start + range - 1n > toBlock ? toBlock : start + range - 1n;
    try {
      const logs = await withRetry(() => publicClient.getLogs({
        address: tokenAddress,
        event: APPROVAL_EVENT,
        args: { owner },
        fromBlock: start,
        toBlock: end,
      }), isBlockRangeError);
      allLogs.push(...logs);
      start = end + 1n;
      if (range < INITIAL_LOG_BLOCK_RANGE) {
        range = range * 2n > INITIAL_LOG_BLOCK_RANGE ? INITIAL_LOG_BLOCK_RANGE : range * 2n;
      }
    } catch (error) {
      if (!isBlockRangeError(error) || range <= MIN_LOG_BLOCK_RANGE) throw error;
      range = range / 2n > MIN_LOG_BLOCK_RANGE ? range / 2n : MIN_LOG_BLOCK_RANGE;
    }
  }
  return allLogs;
}

// Aus dem vorherigen feeAnalysis.ts-Lauf (Block 72_414_977 bis 73_568_685):
const PRIOR_EXECUTE_STEP_TX_COUNT = 58;
const PRIOR_EXECUTE_STEP_GAS_COST_WEI = 10_390430000000000000n; // ~10.390430 CELO (aus vorigem Lauf, hier neu aus Gaskosten-Summe abgeleitet — siehe unten Neuberechnung
const PRIOR_TOTAL_FEE_REVENUE_USD = 1.317; // $1.297 USDC + $0.02 USDT
const REFUEL_THRESHOLD_USD = 5; // pro Token, siehe KEEPER_REFUEL_THRESHOLD Default in squidKeeper.ts

async function main() {
  console.info(`Test-Wallet: ${TEST_WALLET}`);
  const latestBlock = await publicClient.getBlockNumber();
  console.info(`Suche ersten Aktivitätsblock der Test-Wallet...`);
  const firstActivityBlock = await findFirstActivityBlock(TEST_WALLET);
  console.info(`Erste Aktivität ab Block ${firstActivityBlock} (aktuell: ${latestBlock})\n`);

  const approveTxHashes = new Set<string>();

  for (const token of [INPUT_TOKENS.USDC, INPUT_TOKENS.USDT]) {
    console.info(`--- ${token.symbol} (${token.address}) ---`);
    const logs = await getApprovalLogsChunked(token.address, TEST_WALLET, firstActivityBlock, latestBlock);
    console.info(`  ${logs.length} Approval-Event(s) gefunden.`);
    for (const log of logs) {
      approveTxHashes.add(log.transactionHash);
      console.info(`    Tx: ${log.transactionHash}, Betrag: ${formatUnits(log.args.value ?? 0n, token.decimals)} ${token.symbol}`);
    }
  }

  if (approveTxHashes.size === 0) {
    console.info("\nKeine approve()-Transaktionen auf USDC/USDT für diese Wallet gefunden. Kein Modell möglich.");
    return;
  }

  console.info(`\nErmittle Gaskosten für ${approveTxHashes.size} approve()-Transaktion(en)...`);
  let totalApproveGasWei = 0n;
  const perTxGas: bigint[] = [];
  for (const hash of approveTxHashes) {
    const receipt = await withRetry(() => publicClient.getTransactionReceipt({ hash: hash as `0x${string}` }));
    const gasCost = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
    totalApproveGasWei += gasCost;
    perTxGas.push(gasCost);
    console.info(`  ${hash.slice(0, 10)}...: gasUsed=${receipt.gasUsed}, effectiveGasPrice=${receipt.effectiveGasPrice}, Kosten=${formatEther(gasCost)} CELO`);
  }
  const avgApproveGasWei = totalApproveGasWei / BigInt(perTxGas.length);

  console.info(`\nDurchschnittliche approve()-Gaskosten: ${formatEther(avgApproveGasWei)} CELO (aus ${perTxGas.length} echten Tx)`);

  // ─── Modell: künftige Refuel-Zyklen ──────────────────────────────────────
  const avgExecuteStepGasWei = PRIOR_EXECUTE_STEP_GAS_COST_WEI / BigInt(PRIOR_EXECUTE_STEP_TX_COUNT);
  const avgFeePerTxUsd = PRIOR_TOTAL_FEE_REVENUE_USD / PRIOR_EXECUTE_STEP_TX_COUNT;

  // Swap-Tx-Gaskosten sind nicht real gemessen (noch kein Refuel passiert) —
  // als Näherung wird die durchschnittliche executeStep-Gas verwendet, da
  // beide Operationen strukturell gleich sind (Aufruf an Squid Router,
  // Ausführung eines Swaps).
  const modeledRefuelCycleGasWei = avgApproveGasWei + avgExecuteStepGasWei;

  // Wie viele executeStep-Ausführungen bis die 5-$-Schwelle (pro Token)
  // erreicht ist, bei aktueller Durchschnittsgebühr pro Tx:
  const executionsPerRefuelCycle = REFUEL_THRESHOLD_USD / avgFeePerTxUsd;

  const modeledGasPerExecutionWei = avgExecuteStepGasWei + modeledRefuelCycleGasWei / BigInt(Math.round(executionsPerRefuelCycle));
  const modeledGasPerExecutionCelo = Number(formatEther(modeledGasPerExecutionWei));

  const breakEvenPriceOldModel = PRIOR_TOTAL_FEE_REVENUE_USD / Number(formatEther(PRIOR_EXECUTE_STEP_GAS_COST_WEI));
  const breakEvenPriceNewModel = avgFeePerTxUsd / modeledGasPerExecutionCelo;

  console.info("\n================ MODELL MIT APPROVE-KOSTEN ================");
  console.info(`Ø approve()-Gaskosten (echt, Test-Wallet):     ${formatEther(avgApproveGasWei)} CELO`);
  console.info(`Ø executeStep-Gaskosten (echt, Keeper):        ${formatEther(avgExecuteStepGasWei)} CELO`);
  console.info(`Modellierte Refuel-Zyklus-Kosten (approve+Swap-Näherung): ${formatEther(modeledRefuelCycleGasWei)} CELO`);
  console.info(`Ausführungen bis Refuel-Schwelle erreicht:     ~${executionsPerRefuelCycle.toFixed(0)}`);
  console.info(`Ø modellierte Gaskosten pro Ausführung (inkl. anteiliger Refuel-Kosten): ${modeledGasPerExecutionCelo.toFixed(6)} CELO`);
  console.info(`Ø Gebühr pro Ausführung:                       $${avgFeePerTxUsd.toFixed(4)}`);
  console.info(`\nBreak-even CELO-Preis, altes Modell (ohne approve): $${breakEvenPriceOldModel.toFixed(4)}`);
  console.info(`Break-even CELO-Preis, neues Modell (mit approve):  $${breakEvenPriceNewModel.toFixed(4)}`);
  console.info("=============================================================");
}

main().catch((err) => {
  console.error("Approve-Gas-Modell fehlgeschlagen:", err);
  process.exit(1);
});
