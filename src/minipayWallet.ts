import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  fallback,
  parseUnits,
  parseEventLogs,
} from "viem";
import { celo } from "viem/chains";
import { DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI, ERC20_ABI } from "./dcaVaultAbi";
import {
  FACTORY_ADDRESS,
  OLD_FACTORY_ADDRESS,
  INPUT_TOKENS,
  TARGET_TOKENS,
  INTERVAL_SECONDS,
} from "./config";
import type { DcaPlanState, Interval } from "./types";

// ─── Provider ─────────────────────────────────────────────────────────────────

function getMiniPayProvider() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("Kein Wallet-Provider gefunden. Öffne die App in MiniPay.");
  }
  return window.ethereum;
}

// forno.celo.org (viems Default-Endpunkt für Celo) fällt unter Last öfter mit
// einem undifferenzierten "Load failed" aus, insbesondere bei eth_getLogs —
// die withRetry()-Wrapper unten helfen da nicht, weil sie denselben kaputten
// Knoten erneut anfragen. fallback() wechselt bei einem Fehler stattdessen
// automatisch auf den nächsten Endpunkt in der Liste.
// celo.drpc.org bewusst NICHT mehr dabei: lehnt eth_getLogs teils hart mit
// "method does not exist/is not available" ab (kein Netzwerkfehler, den ein
// Retry beheben könnte) — genau die Methode, die "My Purchases" braucht.
const RPC_URLS = [
  "https://forno.celo.org",
  "https://rpc.ankr.com/celo",
];

export function getClients() {
  const provider = getMiniPayProvider();
  const walletClient = createWalletClient({ chain: celo, transport: custom(provider) });
  const publicClient = createPublicClient({
    chain: celo,
    transport: fallback(RPC_URLS.map((url) => http(url))),
  });
  return { walletClient, publicClient };
}

export async function connectWallet(): Promise<`0x${string}`> {
  const { walletClient } = getClients();
  // requestAddresses() -> eth_requestAccounts: löst den Connect-Dialog der
  // Wallet aus. getAddresses() (eth_accounts) würde bei einer Seite, die noch
  // nie autorisiert wurde, still ein leeres Array liefern, OHNE irgendeinen
  // Dialog zu zeigen — das sah wie eine abgelehnte Verbindung aus, obwohl nie
  // gefragt wurde.
  const [address] = await walletClient.requestAddresses();
  if (!address) throw new Error("Wallet-Verbindung abgelehnt oder fehlgeschlagen.");
  return address;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── RPC-Zuverlässigkeit ──────────────────────────────────────────────────────
//
// Der öffentliche forno.celo.org-Knoten bricht bei vielen gleichzeitigen
// Requests wiederholt mit einem generischen "Load failed" ab (Netzwerk-
// Abbruch, kein strukturierter RPC-Fehler). Jeder einzelne RPC-Call in
// dieser Datei läuft deshalb über withRetry(), und Aufrufe über mehrere
// Vaults hinweg laufen gebatcht statt komplett parallel (runInBatches).

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RPC_RETRY_COUNT = 5;
const RPC_RETRY_DELAY_MS = 1_000;

// isNonRetryable: für Fehler, bei denen ein erneuter Versuch mit denselben
// Parametern garantiert wieder scheitert (z.B. "Block range zu groß" — siehe
// getSwapLogsChunked), damit withRetry() dort nicht nutzlos Zeit verbrennt,
// sondern die Fehlerbehandlung sofort beim Aufrufer landet.
async function withRetry<T>(fn: () => Promise<T>, isNonRetryable?: (error: unknown) => boolean): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (isNonRetryable?.(error) || attempt >= RPC_RETRY_COUNT) throw error;
      await sleep(RPC_RETRY_DELAY_MS * attempt);
    }
  }
}

// Wie viele Vaults/Blöcke gleichzeitig verarbeitet werden dürfen — bei voller
// Parallelität über viele Vaults hinweg hat der RPC-Knoten unter Last
// wiederholt abgebrochen, selbst mit obigem Retry.
export const RPC_BATCH_SIZE = 3;

export async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(worker))));
  }
  return results;
}

// ─── Factory: Vaults eines Nutzers lesen ──────────────────────────────────────

export async function getUserVaults(ownerAddress: `0x${string}`): Promise<`0x${string}`[]> {
  const { publicClient } = getClients();
  // Beide Factories abfragen (siehe OLD_FACTORY_ADDRESS in config.ts) — sonst
  // verschwinden Vaults, die vor dem Gebuehren-Deploy ueber die alte Factory
  // erstellt wurden, komplett aus der App (My Plans, My Purchases), obwohl
  // sie on-chain weiter existieren.
  const [current, legacy] = await Promise.all(
    [FACTORY_ADDRESS, OLD_FACTORY_ADDRESS].map((factoryAddress) =>
      withRetry(() => publicClient.readContract({
        address: factoryAddress,
        abi:     DCA_VAULT_FACTORY_ABI,
        functionName: "getVaults",
        args: [ownerAddress],
      })) as Promise<`0x${string}`[]>
    )
  );
  return [...new Set([...current, ...legacy])];
}

// ─── Target-Arrays bauen ──────────────────────────────────────────────────────
// Seit dem Umstieg auf Squid-Routing braucht der Vault keine Pool-Parameter
// (Fee-Tier/TickSpacing/Hooks) mehr — nur Zieltoken + Allokation.

function buildTargetArrays(percentages: Record<string, number>): {
  targetTokens: `0x${string}`[];
  targetBps:    number[]; // uint16[]
} {
  const targetTokens: `0x${string}`[] = [];
  const targetBps:    number[]        = [];

  for (const [symbol, pct] of Object.entries(percentages)) {
    if (pct <= 0) continue;
    const token = TARGET_TOKENS[symbol as keyof typeof TARGET_TOKENS];
    if (!token) throw new Error(`Unbekanntes Zieltoken: ${symbol}`);

    targetTokens.push(token.address);
    targetBps.push(Math.round(pct * 100)); // 1 % → 100 bps (uint16)
  }

  const sum = targetBps.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) {
    throw new Error(`Allokation ergibt ${sum / 100} % statt 100 %.`);
  }
  return { targetTokens, targetBps };
}

// ─── Execution Timestamp ──────────────────────────────────────────────────────

function nextExecutionTimestamp(interval: Interval, executionTimeLocal: string): bigint {
  // Stündliche Pläne haben keine feste Tageszeit — der Keeper pollt ohnehin
  // stündlich, daher startet die erste Ausführung einfach beim nächsten
  // Keeper-Durchlauf statt auf eine bestimmte Uhrzeit zu warten.
  if (interval === "hourly") {
    return BigInt(Math.floor(Date.now() / 1000) + 60);
  }

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
//
// Läuft über die Factory statt über einen fest hinterlegten Vault — 3 separate
// Transaktionen, da der Nutzer den neuen Vault erst approven kann, NACHDEM
// dessen Adresse bekannt ist (siehe DcaVaultFactory.sol):
//   1. factory.createVault()           → neue Vault-Adresse
//   2. usdc.approve(vaultAddress, ...) → Freigabe für den NEUEN Vault
//   3. vault.setupPlan(...)            → Plan aufsetzen (zieht das Input-Token)

export interface SubmitDcaPlanResult {
  vaultAddress:       `0x${string}`;
  createVaultReceipt: Awaited<ReturnType<ReturnType<typeof getClients>["publicClient"]["waitForTransactionReceipt"]>>;
  approveReceipt:     Awaited<ReturnType<ReturnType<typeof getClients>["publicClient"]["waitForTransactionReceipt"]>>;
  setupPlanReceipt:   Awaited<ReturnType<ReturnType<typeof getClients>["publicClient"]["waitForTransactionReceipt"]>>;
}

export type SubmitDcaPlanPhase = 'creating-vault' | 'approving' | 'setting-up-plan';

export async function submitDcaPlan(
  formData: DcaPlanState,
  ownerAddress: `0x${string}`,
  onProgress?: (phase: SubmitDcaPlanPhase) => void,
): Promise<SubmitDcaPlanResult> {
  if (!formData.interval) throw new Error("Intervall fehlt.");

  const inputToken     = INPUT_TOKENS[formData.inputToken];
  const totalAmountRaw = parseUnits(formData.totalAmount, inputToken.decimals);
  const duration       = parseInt(formData.duration, 10);
  const interval       = BigInt(INTERVAL_SECONDS[formData.interval]);
  const firstExecution = nextExecutionTimestamp(formData.interval, formData.executionTime);

  if (totalAmountRaw <= 0n) throw new Error("Gesamtbetrag muss > 0 sein.");
  if (duration <= 0)        throw new Error("Dauer muss > 0 sein.");

  const { targetTokens, targetBps } = buildTargetArrays(formData.percentages);

  const { walletClient, publicClient } = getClients();

  // ── Phase 1: Vault über die Factory erstellen ─────────────────────────────
  onProgress?.('creating-vault');
  let createVaultReceipt;
  let vaultAddress: `0x${string}` | undefined;
  try {
    const hash = await walletClient.writeContract({
      account: ownerAddress,
      address: FACTORY_ADDRESS,
      abi:     DCA_VAULT_FACTORY_ABI,
      functionName: "createVault",
    });
    createVaultReceipt = await publicClient.waitForTransactionReceipt({ hash });

    // Adresse direkt aus dem VaultCreated-Event dieser Transaktion lesen statt
    // erneut factory.getVaults() abzufragen — ein separater Read direkt nach
    // der Bestätigung kann bei manchen RPC-Knoten (Load-Balancer-Replikations-
    // Lag) noch den Stand VOR dieser Transaktion liefern und dadurch versehentlich
    // einen alten, bereits existierenden Vault statt des gerade neu erstellten
    // zurückgeben.
    const [vaultCreatedEvent] = parseEventLogs({
      abi: DCA_VAULT_FACTORY_ABI,
      eventName: "VaultCreated",
      logs: createVaultReceipt.logs,
    });
    vaultAddress = vaultCreatedEvent?.args.vault;
  } catch (error) {
    throw new Error(`Vault-Erstellung fehlgeschlagen: ${describeError(error)}`);
  }

  if (!vaultAddress) {
    throw new Error("Vault wurde erstellt, aber die Adresse konnte nicht aus dem VaultCreated-Event gelesen werden.");
  }

  // ── Phase 2: USDC an den NEUEN Vault freigeben ────────────────────────────
  onProgress?.('approving');
  let approveReceipt;
  try {
    const approveTx = await walletClient.writeContract({
      account: ownerAddress,
      address: inputToken.address,
      abi:     ERC20_ABI,
      functionName: "approve",
      args: [vaultAddress, totalAmountRaw],
    });
    approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
  } catch (error) {
    throw new Error(`USDC-Freigabe fehlgeschlagen: ${describeError(error)}`);
  }

  // ── Phase 3: Plan aufsetzen ────────────────────────────────────────────────
  onProgress?.('setting-up-plan');
  let setupPlanReceipt;
  try {
    const hash = await walletClient.writeContract({
      account:  ownerAddress,
      address:  vaultAddress,
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
      ],
    });
    setupPlanReceipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    throw new Error(`Plan-Einrichtung fehlgeschlagen: ${describeError(error)}`);
  }

  return { vaultAddress, createVaultReceipt, approveReceipt, setupPlanReceipt };
}

// ─── DCA-Plan canceln ──────────────────────────────────────────────────────────
//
// Nur der Owner darf canceln (onlyOwner in DcaVault.cancelPlan()). Gibt den
// verbleibenden Restbestand des Input-Tokens automatisch an den Owner zurück.

export async function cancelDcaPlan(
  vaultAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
): Promise<Awaited<ReturnType<ReturnType<typeof getClients>["publicClient"]["waitForTransactionReceipt"]>>> {
  const { walletClient, publicClient } = getClients();
  try {
    const hash = await walletClient.writeContract({
      account: ownerAddress,
      address: vaultAddress,
      abi:     DCA_VAULT_ABI,
      functionName: "cancelPlan",
    });
    return await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    throw new Error(`Cancel fehlgeschlagen: ${describeError(error)}`);
  }
}

// ─── Purchases (DcaSwapExecuted-Events) ───────────────────────────────────────
//
// "My Purchases" braucht die komplette Swap-Historie aller Vaults eines
// Nutzers — das steht nicht im Contract-State (nur currentStep etc.), sondern
// ausschließlich in den DcaSwapExecuted-Events.
//
// Zwei RPC-Einschränkungen, die das naive "fromBlock: 0n" unbrauchbar machen:
//   1. eth_getLogs erlaubt nur eine begrenzte Blockspanne pro Anfrage ->
//      Chunking nötig. Das genaue Limit ist aber je nach RPC-Knoten
//      unterschiedlich UND undokumentiert (forno toleriert 5000, rpc.ankr.com
//      lehnt schon 2000 mit "Block range is too large" ab) — und kann sich
//      jederzeit ändern, ohne dass wir das mitbekommen. Eine feste Chunk-
//      Größe zu raten ist deshalb keine dauerhafte Lösung. Stattdessen startet
//      getSwapLogsChunked optimistisch groß und halbiert die Spanne bei genau
//      diesem Fehlertyp automatisch, bis sie beim jeweils antwortenden Knoten
//      durchgeht — funktioniert unabhängig davon, welcher der RPC_URLS-Knoten
//      gerade antwortet, und bleibt auch dann korrekt, wenn sich Limits in
//      Zukunft ändern.
//   2. Block 0 bis "latest" wäre auf Celo Mainnet >70 Mio. Blöcke, viel mehr
//      als nötig — getUserVaults() liefert ohnehin nur Vaults der aktuellen
//      FACTORY_ADDRESS (siehe dort), also reicht als unterer Rand deren
//      Deploy-Block. Der wird per Binärsuche auf getCode() einmalig ermittelt
//      und für die Dauer der Session gecacht (ändert sich nie).

const INITIAL_LOG_BLOCK_RANGE = 5_000n; // Startpunkt, orientiert an forno's bekanntem Limit
const MIN_LOG_BLOCK_RANGE     = 1n;      // Untergrenze — irgendwann muss auch 1 Block reichen

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

let factoryDeployBlockCache: bigint | null = null;

async function findDeploymentBlock(
  publicClient: ReturnType<typeof getClients>["publicClient"],
  address: `0x${string}`,
): Promise<bigint> {
  const latest = await withRetry(() => publicClient.getBlockNumber());
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

async function getFactoryDeployBlock(
  publicClient: ReturnType<typeof getClients>["publicClient"],
): Promise<bigint> {
  if (factoryDeployBlockCache === null) {
    factoryDeployBlockCache = await findDeploymentBlock(publicClient, FACTORY_ADDRESS);
  }
  return factoryDeployBlockCache;
}

async function getSwapLogsChunked(
  publicClient: ReturnType<typeof getClients>["publicClient"],
  vaultAddress: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const allLogs = [];
  let start = fromBlock;
  let range = INITIAL_LOG_BLOCK_RANGE;

  while (start <= toBlock) {
    const end = start + range - 1n > toBlock ? toBlock : start + range - 1n;

    try {
      const logs = await withRetry(() => publicClient.getContractEvents({
        address:   vaultAddress,
        abi:       DCA_VAULT_ABI,
        eventName: "DcaSwapExecuted",
        fromBlock: start,
        toBlock:   end,
      }), isBlockRangeError);

      allLogs.push(...logs);
      start = end + 1n;
      // Nach einem Erfolg vorsichtig wieder vergrößern (z.B. falls zuvor ein
      // strengerer Fallback-Knoten dran war, jetzt aber wieder forno
      // antwortet) — aber nie über den Startwert hinaus.
      if (range < INITIAL_LOG_BLOCK_RANGE) {
        range = range * 2n > INITIAL_LOG_BLOCK_RANGE ? INITIAL_LOG_BLOCK_RANGE : range * 2n;
      }
    } catch (error) {
      if (!isBlockRangeError(error) || range <= MIN_LOG_BLOCK_RANGE) throw error;
      // Spanne halbieren und denselben Bereich (start unverändert) im
      // nächsten Schleifendurchlauf mit kleinerer Chunk-Größe neu versuchen.
      range = range / 2n > MIN_LOG_BLOCK_RANGE ? range / 2n : MIN_LOG_BLOCK_RANGE;
    }
  }
  return allLogs;
}

export interface PurchaseEvent {
  vaultAddress:     `0x${string}`;
  step:             number;
  targetToken:      `0x${string}`;
  amountIn:         bigint; // im Input-Token des jeweiligen Vaults (6 Dezimalstellen)
  amountOut:        bigint; // im Zieltoken, dessen Dezimalstellen siehe TARGET_TOKENS
  inputTokenSymbol: string;
  txHash:           `0x${string}`;
  blockNumber:      bigint;
  timestamp:        number | null; // Unix-Sekunden, null falls Block-Lookup fehlschlägt
}

export function resolveInputTokenSymbol(address: `0x${string}`): string {
  const lower = address.toLowerCase();
  for (const token of Object.values(INPUT_TOKENS)) {
    if (token.address.toLowerCase() === lower) return token.symbol;
  }
  return "input token";
}

// ─── Purchases-Cache (localStorage) ────────────────────────────────────────
//
// Ein voller Re-Scan der Swap-Historie bei jedem Öffnen von "My Purchases"
// wird mit der Zeit immer langsamer (mehr Blöcke seit Factory-Deploy, mehr
// eth_getLogs-Chunks pro Vault). Der Cache merkt sich pro Vault den zuletzt
// gescannten Block und die schon aufgelösten Events (inkl. Timestamp) —
// beim nächsten Mal wird nur noch ab dem folgenden Block weitergescannt.
// Rein additiv und pro Vault-Adresse isoliert: geht der Cache verloren oder
// ist er beschädigt, scannt die Funktion einfach wieder komplett neu (siehe
// try/catch unten) — kein anderer Teil der App hängt daran.

const PURCHASES_CACHE_PREFIX  = "osiris_purchasesCache_v1_";
const PURCHASES_CACHE_VERSION = 1;

interface CachedPurchaseEntry {
  step:        number;
  targetToken: `0x${string}`;
  amountIn:    string; // bigint als String, JSON kennt kein bigint
  amountOut:   string;
  txHash:      `0x${string}`;
  blockNumber: string;
  logIndex:    number; // für Deduplizierung, falls sich Scan-Bereiche mal überlappen
  timestamp:   number | null;
}

interface PurchasesCache {
  version:          number;
  lastScannedBlock: string;
  inputTokenSymbol: string;
  entries:          CachedPurchaseEntry[];
}

function loadPurchasesCache(vaultAddress: `0x${string}`): PurchasesCache | null {
  try {
    const raw = localStorage.getItem(PURCHASES_CACHE_PREFIX + vaultAddress);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PurchasesCache;
    if (parsed.version !== PURCHASES_CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null; // localStorage blockiert oder Cache beschädigt — einfach neu scannen.
  }
}

function savePurchasesCache(vaultAddress: `0x${string}`, cache: PurchasesCache): void {
  try {
    localStorage.setItem(PURCHASES_CACHE_PREFIX + vaultAddress, JSON.stringify(cache));
  } catch {
    // Speichern optional — kein Blocker, dann wird beim nächsten Mal wieder alles gescannt.
  }
}

export async function getUserPurchases(vaultAddresses: `0x${string}`[]): Promise<PurchaseEvent[]> {
  if (vaultAddresses.length === 0) return [];
  const { publicClient } = getClients();

  const [deployBlock, latestBlock] = await Promise.all([
    getFactoryDeployBlock(publicClient),
    withRetry(() => publicClient.getBlockNumber()),
  ]);

  const perVault = await runInBatches(vaultAddresses, RPC_BATCH_SIZE, async (vaultAddress) => {
    const cached = loadPurchasesCache(vaultAddress);
    const cachedLastBlock = cached ? BigInt(cached.lastScannedBlock) : null;
    const scanFrom = cachedLastBlock !== null ? cachedLastBlock + 1n : deployBlock;

    const [newLogs, inputTokenSymbol] = await Promise.all([
      scanFrom <= latestBlock
        ? getSwapLogsChunked(publicClient, vaultAddress, scanFrom, latestBlock)
        : Promise.resolve([]),
      cached
        ? Promise.resolve(cached.inputTokenSymbol)
        : withRetry(() => publicClient.readContract({
            address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "inputToken",
          })).then((address) => resolveInputTokenSymbol(address as `0x${string}`)),
    ]);

    const newEntries: CachedPurchaseEntry[] = newLogs.map((log) => ({
      step:        Number(log.args.step),
      targetToken: log.args.targetToken as `0x${string}`,
      amountIn:    (log.args.amountIn as bigint).toString(),
      amountOut:   (log.args.amountOut as bigint).toString(),
      txHash:      log.transactionHash as `0x${string}`,
      blockNumber: (log.blockNumber as bigint).toString(),
      logIndex:    log.logIndex ?? 0,
      timestamp:   null,
    }));

    // Defensiv dedupliziert (txHash+logIndex) statt einfach anzuhängen, falls
    // sich Scan-Bereiche durch einen Cache-Bug mal überlappen sollten.
    const existingKeys = new Set((cached?.entries ?? []).map((e) => `${e.txHash}:${e.logIndex}`));
    const merged = [
      ...(cached?.entries ?? []),
      ...newEntries.filter((e) => !existingKeys.has(`${e.txHash}:${e.logIndex}`)),
    ];

    return { vaultAddress, inputTokenSymbol, entries: merged };
  });

  // Block-Timestamps nachladen — nur für Events, die noch keinen haben (neu
  // gescannte). Ein getBlock() pro einzigartigem Block, nicht pro Event
  // (mehrere Swaps eines Schritts landen im selben Block). Gebatcht statt
  // komplett parallel, aus demselben Grund wie beim Log-Scan oben.
  const blocksNeeded = new Set<bigint>();
  for (const { entries } of perVault) {
    for (const entry of entries) {
      if (entry.timestamp === null) blocksNeeded.add(BigInt(entry.blockNumber));
    }
  }
  const uniqueBlocks = [...blocksNeeded];
  const blocks = await runInBatches(uniqueBlocks, RPC_BATCH_SIZE, (bn) => withRetry(() => publicClient.getBlock({ blockNumber: bn })));
  const timestampByBlock = new Map(uniqueBlocks.map((bn, i) => [bn.toString(), Number(blocks[i].timestamp)]));

  const result: PurchaseEvent[] = [];
  for (const { vaultAddress, inputTokenSymbol, entries } of perVault) {
    const resolvedEntries = entries.map((entry) => ({
      ...entry,
      timestamp: entry.timestamp ?? timestampByBlock.get(entry.blockNumber) ?? null,
    }));

    savePurchasesCache(vaultAddress, {
      version: PURCHASES_CACHE_VERSION,
      lastScannedBlock: latestBlock.toString(),
      inputTokenSymbol,
      entries: resolvedEntries,
    });

    for (const entry of resolvedEntries) {
      result.push({
        vaultAddress,
        step:             entry.step,
        targetToken:      entry.targetToken,
        amountIn:         BigInt(entry.amountIn),
        amountOut:        BigInt(entry.amountOut),
        inputTokenSymbol,
        txHash:           entry.txHash,
        blockNumber:      BigInt(entry.blockNumber),
        timestamp:        entry.timestamp,
      });
    }
  }

  return result.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

// ─── Plan-Status lesen ────────────────────────────────────────────────────────

type PlanStatusField =
  | "initialized" | "cancelled" | "currentStep" | "totalSteps"
  | "nextExecutionTimestamp" | "remainingInputBalance" | "trancheAmount" | "interval"
  | "inputToken" | "totalDeposited";

export async function readPlanStatus(contractAddress: `0x${string}`) {
  const { publicClient } = getClients();
  const read = <F extends PlanStatusField>(functionName: F) => withRetry(() => publicClient.readContract({
    address: contractAddress, abi: DCA_VAULT_ABI, functionName,
  }));
  const [
    initialized, cancelled, currentStep, totalSteps,
    nextExecTs, remainingBalance, trancheAmt, interval,
    inputTokenAddress, totalDeposited, targetConfigs,
  ] = await Promise.all([
    read("initialized"),
    read("cancelled"),
    read("currentStep"),
    read("totalSteps"),
    read("nextExecutionTimestamp"),
    read("remainingInputBalance"),
    read("trancheAmount"),
    read("interval"),
    read("inputToken"),
    read("totalDeposited"),
    withRetry(() => publicClient.readContract({
      address: contractAddress, abi: DCA_VAULT_ABI, functionName: "getTargetConfigs",
    })),
  ]);
  return { initialized, cancelled, currentStep, totalSteps,
           nextExecutionTimestamp: nextExecTs, remainingBalance, trancheAmount: trancheAmt,
           interval, inputToken: inputTokenAddress, totalDeposited, targetConfigs };
}
