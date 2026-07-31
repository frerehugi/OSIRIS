// Einmalige Diagnose: Gas-Kosten vs. Gebühreneinnahmen des Keepers.
//
// Rein lesend (keine Transaktionen, kein Private Key nötig). Beantwortet:
// "Macht das Protokoll netto Gewinn, oder blutet der CELO-Vorrat aus?"
//
// Methodik (nur Standard-eth_getLogs/getBalance/getTransactionReceipt, keine
// Indexer/Explorer-API nötig):
//   - Jede executeStep()-Ausführung zieht die Gebühr per ERC20 Transfer(vault
//     -> globalKeeper) ab (siehe DcaVault.sol Zeile ~351) -> Summe aller
//     eingehenden USDC/USDT-Transfers an globalKeeper = Brutto-Gebühreneinnahme.
//   - Jeder Auto-Refuel-Swap sendet USDC/USDT vom Keeper an den Squid-Router
//     (Transfer(globalKeeper -> router)) -> Summe aller ausgehenden Transfers
//     = bereits in CELO umgetauschter Anteil.
//   - CELO ist nativ, hat keine Transfer-Logs. Der tatsächlich erhaltene
//     CELO-Betrag pro Refuel-Swap wird daher aus der Bilanzänderung über den
//     Swap-Block hinweg berechnet (Saldo danach - Saldo davor + Gaskosten
//     dieser Tx = erhaltenes CELO), woraus sich zugleich ein exakter,
//     projekteigener CELO/USD-Kurs ergibt (keine externe Preisquelle nötig).
//   - Gaskosten = Summe aus gasUsed * effectiveGasPrice über alle Tx-Hashes
//     der beiden obigen Log-Mengen (deckt executeStep- und Refuel-Swap-Tx ab;
//     reine approve()-Tx ohne Transfer-Event werden nicht separat erfasst —
//     kleiner, bekannter Unterschätzungs-Fehler, siehe Report-Ausgabe).

import { createPublicClient, http, fallback, parseAbiItem, formatUnits, formatEther } from "viem";
import { celo } from "viem/chains";
import { FACTORY_ADDRESS, INPUT_TOKENS } from "../src/config";

const GLOBAL_KEEPER = "0x02069c8AfceC69622c0F1C5316735042A86BC6fA" as const;

const RPC_URLS = [
  "https://forno.celo.org",
  "https://rpc.ankr.com/celo",
];

const publicClient = createPublicClient({
  chain: celo,
  transport: fallback(RPC_URLS.map((url) => http(url))),
});

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
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

async function findDeploymentBlock(address: `0x${string}`): Promise<bigint> {
  const latest = await publicClient.getBlockNumber();
  let lo = 0n;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await withRetry(() => publicClient.getCode({ address, blockNumber: mid }));
    if (code && code !== "0x") {
      hi = mid;
    } else {
      lo = mid + 1n;
    }
  }
  return lo;
}

async function getTransferLogsChunked(
  tokenAddress: `0x${string}`,
  filter: "from" | "to",
  keeper: `0x${string}`,
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
        event: TRANSFER_EVENT,
        args: filter === "to" ? { to: keeper } : { from: keeper },
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

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  console.info(`Global Keeper / Treasury: ${GLOBAL_KEEPER}`);
  console.info(`Suche Deploy-Block der aktiven Factory (${FACTORY_ADDRESS})...`);
  const feeStartBlock = await findDeploymentBlock(FACTORY_ADDRESS);
  const latestBlock = await publicClient.getBlockNumber();
  console.info(`Fee-Mechanismus aktiv seit Block ${feeStartBlock} (aktuell: ${latestBlock}, Spanne: ${latestBlock - feeStartBlock} Blöcke)\n`);

  const celoBalanceAtStart = await publicClient.getBalance({ address: GLOBAL_KEEPER, blockNumber: feeStartBlock });
  const celoBalanceNow = await publicClient.getBalance({ address: GLOBAL_KEEPER });

  let totalFeeRevenueRaw = 0n;   // eingehende USDC+USDT an keeper (6 Decimals je Token)
  let totalConvertedRaw = 0n;    // ausgehende USDC+USDT vom keeper (Refuel-Swaps)
  let totalGasCostWei = 0n;
  let totalCeloReceivedFromRefuel = 0n;
  const gasTxHashes = new Set<string>();

  for (const token of [INPUT_TOKENS.USDC, INPUT_TOKENS.USDT]) {
    console.info(`--- ${token.symbol} (${token.address}) ---`);

    const incoming = await getTransferLogsChunked(token.address, "to", GLOBAL_KEEPER, feeStartBlock, latestBlock);
    const outgoing = await getTransferLogsChunked(token.address, "from", GLOBAL_KEEPER, feeStartBlock, latestBlock);

    const incomingSum = incoming.reduce((sum, log) => sum + (log.args.value ?? 0n), 0n);
    const outgoingSum = outgoing.reduce((sum, log) => sum + (log.args.value ?? 0n), 0n);
    totalFeeRevenueRaw += incomingSum;
    totalConvertedRaw += outgoingSum;

    console.info(`  Eingehend (Gebühren):  ${incoming.length} Tx, ${formatUnits(incomingSum, token.decimals)} ${token.symbol}`);
    console.info(`  Ausgehend (Refuel):    ${outgoing.length} Tx, ${formatUnits(outgoingSum, token.decimals)} ${token.symbol}`);

    for (const log of incoming) gasTxHashes.add(log.transactionHash);

    // Für jeden Refuel-Swap: erhaltenes CELO + impliziter Kurs ermitteln.
    for (const log of outgoing) {
      gasTxHashes.add(log.transactionHash);
      const blockNum = log.blockNumber;
      const receipt = await withRetry(() => publicClient.getTransactionReceipt({ hash: log.transactionHash }));
      const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
      const [balBefore, balAfter] = await Promise.all([
        withRetry(() => publicClient.getBalance({ address: GLOBAL_KEEPER, blockNumber: blockNum - 1n })),
        withRetry(() => publicClient.getBalance({ address: GLOBAL_KEEPER, blockNumber: blockNum })),
      ]);
      const celoReceived = balAfter - balBefore + gasCostWei;
      if (celoReceived > 0n) {
        totalCeloReceivedFromRefuel += celoReceived;
        const impliedPrice = Number(log.args.value ?? 0n) / 1e6 / (Number(celoReceived) / 1e18);
        console.info(`  Refuel-Swap ${log.transactionHash.slice(0, 10)}...: ${formatUnits(log.args.value ?? 0n, token.decimals)} ${token.symbol} -> ${formatEther(celoReceived)} CELO (impliziter Kurs: $${impliedPrice.toFixed(4)}/CELO)`);
      }
    }
    console.info("");
  }

  console.info(`Ermittle Gaskosten für ${gasTxHashes.size} Keeper-Transaktionen (executeStep + Refuel-Swaps)...`);
  const receipts = await mapWithConcurrency(Array.from(gasTxHashes), 5, (hash) =>
    withRetry(() => publicClient.getTransactionReceipt({ hash: hash as `0x${string}` }))
  );
  for (const receipt of receipts) {
    totalGasCostWei += receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
  }

  const totalFeeRevenueUsd = Number(formatUnits(totalFeeRevenueRaw, 6));
  const totalConvertedUsd = Number(formatUnits(totalConvertedRaw, 6));
  const unconvertedUsd = totalFeeRevenueUsd - totalConvertedUsd;
  const totalGasCostCelo = Number(formatEther(totalGasCostWei));
  const totalCeloReceived = Number(formatEther(totalCeloReceivedFromRefuel));
  const avgImpliedPrice = totalCeloReceived > 0 ? totalConvertedUsd / totalCeloReceived : null;
  const totalGasCostUsd = avgImpliedPrice !== null ? totalGasCostCelo * avgImpliedPrice : null;
  const celoTreasuryDeltaCelo = Number(formatEther(celoBalanceNow - celoBalanceAtStart));

  console.info("\n================ ZUSAMMENFASSUNG ================");
  console.info(`Zeitraum:                        Block ${feeStartBlock} bis ${latestBlock} (seit Fee-Mechanismus live)`);
  console.info(`Brutto-Gebühreneinnahme:          $${totalFeeRevenueUsd.toFixed(4)} (USDC+USDT)`);
  console.info(`  davon in CELO umgetauscht:      $${totalConvertedUsd.toFixed(4)} -> ${totalCeloReceived.toFixed(4)} CELO`);
  console.info(`  davon noch als Stablecoin:      $${unconvertedUsd.toFixed(4)}`);
  if (avgImpliedPrice !== null) {
    console.info(`Impliziter Ø CELO/USD-Kurs:       $${avgImpliedPrice.toFixed(4)}`);
  }
  console.info(`Gesamt-Gaskosten:                 ${totalGasCostCelo.toFixed(6)} CELO${totalGasCostUsd !== null ? ` (~$${totalGasCostUsd.toFixed(4)})` : " (kein impliziter Kurs verfügbar, da noch kein Refuel-Swap stattfand)"}`);
  console.info(`  (deckt executeStep- + Refuel-Swap-Tx ab; reine approve()-Tx ohne`);
  console.info(`   Transfer-Event sind NICHT enthalten -> leichte Unterschätzung)`);
  if (totalGasCostUsd !== null) {
    console.info(`\nNetto (Gebühren - Gaskosten):     $${(totalFeeRevenueUsd - totalGasCostUsd).toFixed(4)}`);
  }
  console.info(`\nCELO-Bestand Keeper-Wallet:       ${formatEther(celoBalanceAtStart)} CELO (Start) -> ${formatEther(celoBalanceNow)} CELO (jetzt)`);
  console.info(`  Veränderung:                    ${celoTreasuryDeltaCelo >= 0 ? "+" : ""}${celoTreasuryDeltaCelo.toFixed(6)} CELO`);
  console.info(`  ACHTUNG: enthält auch eventuelle manuelle CELO-Einzahlungen/-Abhebungen`);
  console.info(`  im Zeitraum, die diese Zahl verzerren, falls es welche gab.`);
  console.info("===================================================");
}

main().catch((err) => {
  console.error("Fee-Analyse fehlgeschlagen:", err);
  process.exit(1);
});
