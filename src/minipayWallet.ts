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
import { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI } from "./triggerVaultAbi";
import {
  FACTORY_ADDRESS,
  OLD_FACTORY_ADDRESS,
  TRIGGER_VAULT_FACTORY_ADDRESS,
  INPUT_TOKENS,
  TARGET_TOKENS,
  INTERVAL_SECONDS,
  CELO_CHAIN_ID,
} from "./config";
import { TIME_LIMIT_SECONDS, type DcaPlanState, type Interval, type TriggerPlanState } from "./types";

// ─── Provider ─────────────────────────────────────────────────────────────────

function getMiniPayProvider() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("No wallet provider found. Open the app in the in-app browser of MiniPay or Trust Wallet.");
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

// Manche Wallets lassen requestAddresses()/getChainId() nach einem manuellen
// "Disconnect" in der Wallet-UI selbst einfach unbegrenzt hängen (weder
// Erfolg noch Fehler) — beobachtet nach Disconnect+Neuöffnen in MiniPay. Da
// die App laut Vorgabe automatisch verbindet und OHNE manuellen Connect-
// Button auskommen muss, würde das sonst zu einem für den Nutzer nicht mehr
// verlassbaren, leeren Bildschirm führen. Timeout sorgt dafür, dass immer
// spätestens nach CONNECT_TIMEOUT_MS ein Fehler (+ Retry-Möglichkeit in der
// UI) auftaucht, egal was der Provider tatsächlich tut.
const CONNECT_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(timeoutMessage), { name: "TimeoutError" }));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function connectWallet(): Promise<`0x${string}`> {
  const { walletClient } = getClients();
  // requestAddresses() -> eth_requestAccounts: löst den Connect-Dialog der
  // Wallet aus. getAddresses() (eth_accounts) würde bei einer Seite, die noch
  // nie autorisiert wurde, still ein leeres Array liefern, OHNE irgendeinen
  // Dialog zu zeigen — das sah wie eine abgelehnte Verbindung aus, obwohl nie
  // gefragt wurde.
  // Eine echte Ablehnung durch die Wallet wirft üblicherweise (statt ein
  // leeres Array zurückzugeben) — deshalb hier abfangen und über
  // describeConnectionError() nach Code/Name auswerten, nicht nach Message-Text.
  let address: `0x${string}` | undefined;
  try {
    [address] = await withTimeout(
      walletClient.requestAddresses(),
      CONNECT_TIMEOUT_MS,
      "Connection timed out. Please try again."
    );
  } catch (error) {
    throw new Error(describeConnectionError(error));
  }
  if (!address) throw new Error("Wallet connection failed.");

  // MiniPay unterstützt ausschließlich Celo (Mainnet/Sepolia) — programmatisches
  // Chain-Switching ist dort nicht möglich (wagmis useSwitchChain funktioniert
  // nicht), die App darf es also nicht versuchen. Stattdessen nur erkennen und
  // klar kommunizieren, falls eine andere Wallet (z.B. MetaMask) auf einer
  // fremden Chain hängt.
  let chainId: number;
  try {
    chainId = await withTimeout(
      walletClient.getChainId(),
      CONNECT_TIMEOUT_MS,
      "Connection timed out. Please try again."
    );
  } catch (error) {
    throw new Error(describeConnectionError(error));
  }
  if (chainId !== Number(CELO_CHAIN_ID)) {
    throw new Error(
      `Wrong network detected. Please switch to Celo (Chain ID ${CELO_CHAIN_ID}) in your wallet, then reopen the app.`
    );
  }

  return address;
}

// Provider-Fehler nach Code/Name statt Message-Text unterscheiden — Wallets
// ändern Fehlermeldungstexte gelegentlich, Codes/Namen sind stabiler.
// Deckt sowohl viem-eigene Fehlernamen als auch rohe JSON-RPC-Fehlercodes ab
// (MiniPay nutzt die Standard-Codes, -32604 = "Permission denied"/Ablehnung).
interface ProviderLikeError {
  code?: number;
  name?: string;
}

function describeConnectionError(error: unknown): string {
  const providerError = error as ProviderLikeError;
  // Eigener Timeout-Fehler (siehe withTimeout) — Message unverändert
  // durchreichen statt auf die generische Fallback-Meldung zu mappen.
  if (providerError?.name === "TimeoutError") {
    return error instanceof Error ? error.message : "Connection timed out. Please try again.";
  }
  if (providerError?.code === -32604 || providerError?.name === "UserRejectedRequestError") {
    return "Connection was cancelled.";
  }
  return "Wallet connection failed.";
}

function describeError(error: unknown): string {
  const providerError = error as ProviderLikeError;
  if (providerError?.code === -32604 || providerError?.name === "UserRejectedRequestError") {
    return "Transaction was cancelled.";
  }
  return error instanceof Error ? error.message : String(error);
}

// ─── MiniPay-Deeplinks ────────────────────────────────────────────────────────
//
// link.minipay.xyz ignoriert die App, falls MiniPay nicht installiert/eingeloggt
// ist (führt dann zur Installation) — kein Fallback auf unserer Seite nötig.

export function getAddCashDeeplink(tokens: readonly string[] = ["USDC", "USDT"]): string {
  return `https://link.minipay.xyz/add_cash?tokens=${tokens.join(",")}`;
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
    if (!token) throw new Error(`Unknown target token: ${symbol}`);

    targetTokens.push(token.address);
    targetBps.push(Math.round(pct * 100)); // 1 % → 100 bps (uint16)
  }

  const sum = targetBps.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) {
    throw new Error(`Allocation totals ${sum / 100}% instead of 100%.`);
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
  if (!formData.interval) throw new Error("Interval is missing.");

  const inputToken     = INPUT_TOKENS[formData.inputToken];
  const totalAmountRaw = parseUnits(formData.totalAmount, inputToken.decimals);
  const duration       = parseInt(formData.duration, 10);
  const interval       = BigInt(INTERVAL_SECONDS[formData.interval]);
  const firstExecution = nextExecutionTimestamp(formData.interval, formData.executionTime);

  if (totalAmountRaw <= 0n) throw new Error("Total amount must be > 0.");
  if (duration <= 0)        throw new Error("Duration must be > 0.");

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
    throw new Error(`Vault creation failed: ${describeError(error)}`);
  }

  if (!vaultAddress) {
    throw new Error("Vault was created, but its address could not be read from the VaultCreated event.");
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
    throw new Error(`USDC approval failed: ${describeError(error)}`);
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
    throw new Error(`Plan setup failed: ${describeError(error)}`);
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
    throw new Error(`Cancel failed: ${describeError(error)}`);
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
  onBlocksScanned?: (count: bigint) => void,
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
      onBlocksScanned?.(end - start + 1n);
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

// onProgress meldet 0..1 über den gesamten Ladevorgang: 0-0.9 für den
// eth_getLogs-Scan (der dominante Kostenfaktor, siehe getSwapLogsChunked),
// 0.9-1.0 fürs Nachladen der Block-Timestamps. Rein additiv/optional — ohne
// Callback verhält sich die Funktion exakt wie zuvor.
export async function getUserPurchases(
  vaultAddresses: `0x${string}`[],
  onProgress?: (fraction: number) => void,
): Promise<PurchaseEvent[]> {
  if (vaultAddresses.length === 0) { onProgress?.(1); return []; }
  const { publicClient } = getClients();

  const [deployBlock, latestBlock] = await Promise.all([
    getFactoryDeployBlock(publicClient),
    withRetry(() => publicClient.getBlockNumber()),
  ]);

  // Scan-Umfang pro Vault vorab (synchron, aus dem Cache) ermitteln, damit
  // der Fortschritt über alle Vaults hinweg aggregiert werden kann, statt
  // pro Vault bei 0 % neu anzufangen (loadPurchasesCache ist reiner
  // localStorage-Zugriff, kein RPC-Call, daher hier ohne await möglich).
  const scanPlans = vaultAddresses.map((vaultAddress) => {
    const cached = loadPurchasesCache(vaultAddress);
    const cachedLastBlock = cached ? BigInt(cached.lastScannedBlock) : null;
    const scanFrom = cachedLastBlock !== null ? cachedLastBlock + 1n : deployBlock;
    const blocksToScan = scanFrom <= latestBlock ? latestBlock - scanFrom + 1n : 0n;
    return { vaultAddress, cached, scanFrom, blocksToScan };
  });
  const totalBlocksToScan = scanPlans.reduce((sum, p) => sum + p.blocksToScan, 0n);
  let blocksScannedSoFar = 0n;

  function reportScanProgress() {
    if (!onProgress) return;
    const fraction = totalBlocksToScan > 0n ? Number(blocksScannedSoFar) / Number(totalBlocksToScan) : 1;
    onProgress(Math.min(fraction, 1) * 0.9);
  }
  reportScanProgress();

  const perVault = await runInBatches(scanPlans, RPC_BATCH_SIZE, async ({ vaultAddress, cached, scanFrom }) => {
    const [newLogs, inputTokenSymbol] = await Promise.all([
      scanFrom <= latestBlock
        ? getSwapLogsChunked(publicClient, vaultAddress, scanFrom, latestBlock, (count) => {
            blocksScannedSoFar += count;
            reportScanProgress();
          })
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

  onProgress?.(0.9); // Scan-Phase fertig, egal ob es überhaupt etwas zu scannen gab

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
  let blocksResolved = 0;
  const blocks = await runInBatches(uniqueBlocks, RPC_BATCH_SIZE, async (bn) => {
    const block = await withRetry(() => publicClient.getBlock({ blockNumber: bn }));
    blocksResolved += 1;
    onProgress?.(uniqueBlocks.length > 0 ? 0.9 + (blocksResolved / uniqueBlocks.length) * 0.1 : 1);
    return block;
  });
  const timestampByBlock = new Map(uniqueBlocks.map((bn, i) => [bn.toString(), Number(blocks[i].timestamp)]));

  onProgress?.(1);

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

// ─── Trigger-Vaults eines Nutzers lesen ────────────────────────────────────────

export async function getUserTriggerVaults(ownerAddress: `0x${string}`): Promise<`0x${string}`[]> {
  const { publicClient } = getClients();
  return await withRetry(() => publicClient.readContract({
    address: TRIGGER_VAULT_FACTORY_ADDRESS,
    abi:     TRIGGER_VAULT_FACTORY_ABI,
    functionName: "getVaults",
    args: [ownerAddress],
  })) as `0x${string}`[];
}

// ─── Trigger-Plan submitten ─────────────────────────────────────────────────────
//
// Läuft über die Factory statt über einen fest hinterlegten Vault — 3 separate
// Transaktionen, aus demselben Grund wie submitDcaPlan() (siehe dort):
//   1. factory.createVault()             → neue Vault-Adresse
//   2. token.approve(vaultAddress, ...)  → Freigabe für den NEUEN Vault
//   3. vault.setupPlan(...)              → Plan aufsetzen (zieht das Held-Token)
//
// Buy-Plan (heldToken=Stablecoin, outputToken=Zieltoken) und Sell-Plan
// (heldToken=Zieltoken, outputToken=Stablecoin) sind derselbe Ablauf, nur mit
// vertauschten Token — siehe TriggerVault.sol. "Buy" löst als Dip-Kauf aus
// (Preis fällt AUF/UNTER den Trigger, triggerAbove=false), "Sell" als
// Take-Profit (Preis steigt AUF/ÜBER den Trigger, triggerAbove=true).
//
// Erwartet bereits validierte Eingaben (siehe parseStrictDecimal-Validierung
// in App.tsx, analog zu validateAmount/validateDuration für den DCA-Wizard) —
// diese Funktion parst nur noch, validiert nicht mehr.

export interface SubmitTriggerPlanResult {
  vaultAddress:       `0x${string}`;
  createVaultReceipt: Awaited<ReturnType<ReturnType<typeof getClients>["publicClient"]["waitForTransactionReceipt"]>>;
  approveReceipt:     Awaited<ReturnType<ReturnType<typeof getClients>["publicClient"]["waitForTransactionReceipt"]>>;
  setupPlanReceipt:   Awaited<ReturnType<ReturnType<typeof getClients>["publicClient"]["waitForTransactionReceipt"]>>;
}

export type SubmitTriggerPlanPhase = 'creating-vault' | 'approving' | 'setting-up-plan';

export async function submitTriggerPlan(
  draft: TriggerPlanState,
  ownerAddress: `0x${string}`,
  onProgress?: (phase: SubmitTriggerPlanPhase) => void,
): Promise<SubmitTriggerPlanResult> {
  const isBuy       = draft.direction === 'buy';
  const cryptoToken = TARGET_TOKENS[draft.cryptoSymbol];
  const stableToken = INPUT_TOKENS[draft.stableSymbol];

  const heldToken    = isBuy ? stableToken : cryptoToken;
  const outputToken  = isBuy ? cryptoToken : stableToken;
  const watchToken   = cryptoToken;
  const triggerAbove = !isBuy;

  const amountRaw       = parseUnits(draft.amountHuman, heldToken.decimals);
  const triggerPriceRaw = parseUnits(draft.priceUsd, 8); // 8 Dezimalstellen wie Chainlink/Squid
  const limitSeconds    = TIME_LIMIT_SECONDS[draft.timeLimit];
  const expiresAt       = limitSeconds === 0 ? 0n : BigInt(Math.floor(Date.now() / 1000) + limitSeconds);

  if (amountRaw <= 0n) throw new Error("Amount must be > 0.");
  if (triggerPriceRaw <= 0n) throw new Error("Trigger price must be > 0.");

  const { walletClient, publicClient } = getClients();

  // ── Phase 1: Vault über die Factory erstellen ─────────────────────────────
  onProgress?.('creating-vault');
  let createVaultReceipt;
  let vaultAddress: `0x${string}` | undefined;
  try {
    const hash = await walletClient.writeContract({
      account: ownerAddress,
      address: TRIGGER_VAULT_FACTORY_ADDRESS,
      abi:     TRIGGER_VAULT_FACTORY_ABI,
      functionName: "createVault",
    });
    createVaultReceipt = await publicClient.waitForTransactionReceipt({ hash });

    // Adresse direkt aus dem VaultCreated-Event dieser Transaktion lesen —
    // gleicher Grund wie in submitDcaPlan() (RPC-Load-Balancer-Replikations-Lag).
    const [vaultCreatedEvent] = parseEventLogs({
      abi: TRIGGER_VAULT_FACTORY_ABI,
      eventName: "VaultCreated",
      logs: createVaultReceipt.logs,
    });
    vaultAddress = vaultCreatedEvent?.args.vault;
  } catch (error) {
    throw new Error(`Vault creation failed: ${describeError(error)}`);
  }

  if (!vaultAddress) {
    throw new Error("Vault was created, but its address could not be read from the VaultCreated event.");
  }

  // ── Phase 2: Held-Token an den NEUEN Vault freigeben ──────────────────────
  onProgress?.('approving');
  let approveReceipt;
  try {
    const approveTx = await walletClient.writeContract({
      account: ownerAddress,
      address: heldToken.address,
      abi:     ERC20_ABI,
      functionName: "approve",
      args: [vaultAddress, amountRaw],
    });
    approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
  } catch (error) {
    throw new Error(`${heldToken.symbol} approval failed: ${describeError(error)}`);
  }

  // ── Phase 3: Plan aufsetzen ────────────────────────────────────────────────
  onProgress?.('setting-up-plan');
  let setupPlanReceipt;
  try {
    const hash = await walletClient.writeContract({
      account:  ownerAddress,
      address:  vaultAddress,
      abi:      TRIGGER_VAULT_ABI,
      functionName: "setupPlan",
      args: [
        heldToken.address,   // _heldToken
        outputToken.address, // _outputToken
        watchToken.address,  // _watchToken
        amountRaw,           // _amount
        triggerAbove,        // _triggerAbove
        triggerPriceRaw,     // _triggerPrice
        expiresAt,           // _expiresAt
      ],
    });
    setupPlanReceipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    throw new Error(`Plan setup failed: ${describeError(error)}`);
  }

  return { vaultAddress, createVaultReceipt, approveReceipt, setupPlanReceipt };
}

// ─── Trigger-Plan canceln ───────────────────────────────────────────────────────
//
// Nur der Owner darf canceln (onlyOwner in TriggerVault.cancel()). Gibt den
// vollen verwahrten Restbestand automatisch an den Owner zurück — jederzeit
// möglich, unabhängig von expiresAt.

export async function cancelTriggerPlan(
  vaultAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
): Promise<Awaited<ReturnType<ReturnType<typeof getClients>["publicClient"]["waitForTransactionReceipt"]>>> {
  const { walletClient, publicClient } = getClients();
  try {
    const hash = await walletClient.writeContract({
      account: ownerAddress,
      address: vaultAddress,
      abi:     TRIGGER_VAULT_ABI,
      functionName: "cancel",
    });
    return await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    throw new Error(`Cancel failed: ${describeError(error)}`);
  }
}

// ─── Trigger-Vault-Status lesen ──────────────────────────────────────────────────

type TriggerVaultStatusField =
  | "heldToken" | "outputToken" | "watchToken" | "amount"
  | "triggerAbove" | "triggerPrice" | "expiresAt"
  | "initialized" | "cancelled" | "executed";

export async function readTriggerVaultStatus(contractAddress: `0x${string}`) {
  const { publicClient } = getClients();
  const read = <F extends TriggerVaultStatusField>(functionName: F) => withRetry(() => publicClient.readContract({
    address: contractAddress, abi: TRIGGER_VAULT_ABI, functionName,
  }));
  const [
    heldToken, outputToken, watchToken, amount,
    triggerAbove, triggerPrice, expiresAt,
    initialized, cancelled, executed,
  ] = await Promise.all([
    read("heldToken"),
    read("outputToken"),
    read("watchToken"),
    read("amount"),
    read("triggerAbove"),
    read("triggerPrice"),
    read("expiresAt"),
    read("initialized"),
    read("cancelled"),
    read("executed"),
  ]);
  return { heldToken, outputToken, watchToken, amount,
           triggerAbove, triggerPrice, expiresAt,
           initialized, cancelled, executed };
}
