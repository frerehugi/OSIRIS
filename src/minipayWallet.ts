import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  parseUnits,
  parseEventLogs,
} from "viem";
import { celo } from "viem/chains";
import { DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI, ERC20_ABI } from "./dcaVaultAbi";
import {
  FACTORY_ADDRESS,
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

export function getClients() {
  const provider = getMiniPayProvider();
  const walletClient = createWalletClient({ chain: celo, transport: custom(provider) });
  const publicClient = createPublicClient({ chain: celo, transport: http() });
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

// ─── Factory: Vaults eines Nutzers lesen ──────────────────────────────────────

export async function getUserVaults(ownerAddress: `0x${string}`): Promise<`0x${string}`[]> {
  const { publicClient } = getClients();
  return publicClient.readContract({
    address: FACTORY_ADDRESS,
    abi:     DCA_VAULT_FACTORY_ABI,
    functionName: "getVaults",
    args: [ownerAddress],
  }) as Promise<`0x${string}`[]>;
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
// ausschließlich in den DcaSwapExecuted-Events. fromBlock: 0n ist bewusst
// simpel gehalten (kein Chunking über einen Block-Range-Cap) — bei sehr vielen
// Vaults/sehr langer Historie ggf. später auf Batches umstellen, falls der
// RPC-Provider eth_getLogs für so große Ranges ablehnt.

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

function resolveInputTokenSymbol(address: `0x${string}`): string {
  const lower = address.toLowerCase();
  for (const token of Object.values(INPUT_TOKENS)) {
    if (token.address.toLowerCase() === lower) return token.symbol;
  }
  return "input token";
}

export async function getUserPurchases(vaultAddresses: `0x${string}`[]): Promise<PurchaseEvent[]> {
  if (vaultAddresses.length === 0) return [];
  const { publicClient } = getClients();

  const perVault = await Promise.all(
    vaultAddresses.map(async (vaultAddress) => {
      const [logs, inputTokenAddress] = await Promise.all([
        publicClient.getContractEvents({
          address:   vaultAddress,
          abi:       DCA_VAULT_ABI,
          eventName: "DcaSwapExecuted",
          fromBlock: 0n,
          toBlock:   "latest",
        }),
        publicClient.readContract({
          address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "inputToken",
        }) as Promise<`0x${string}`>,
      ]);
      const inputTokenSymbol = resolveInputTokenSymbol(inputTokenAddress);

      return logs.map((log) => ({
        vaultAddress,
        step:             Number(log.args.step),
        targetToken:      log.args.targetToken as `0x${string}`,
        amountIn:         log.args.amountIn as bigint,
        amountOut:        log.args.amountOut as bigint,
        inputTokenSymbol,
        txHash:            log.transactionHash as `0x${string}`,
        blockNumber:       log.blockNumber as bigint,
        timestamp:         null as number | null,
      }));
    }),
  );

  const flat = perVault.flat();

  // Block-Timestamps nachladen — ein getBlock() pro einzigartigem Block,
  // nicht pro Event (mehrere Swaps eines Schritts landen im selben Block).
  const uniqueBlocks = [...new Set(flat.map((p) => p.blockNumber))];
  const blocks = await Promise.all(uniqueBlocks.map((bn) => publicClient.getBlock({ blockNumber: bn })));
  const timestampByBlock = new Map(uniqueBlocks.map((bn, i) => [bn, Number(blocks[i].timestamp)]));

  return flat
    .map((p) => ({ ...p, timestamp: timestampByBlock.get(p.blockNumber) ?? null }))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

// ─── Plan-Status lesen ────────────────────────────────────────────────────────

export async function readPlanStatus(contractAddress: `0x${string}`) {
  const { publicClient } = getClients();
  const [
    initialized, cancelled, currentStep, totalSteps,
    nextExecTs, remainingBalance, trancheAmt, interval,
  ] = await Promise.all([
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "initialized" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "cancelled" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "currentStep" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "totalSteps" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "nextExecutionTimestamp" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "remainingInputBalance" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "trancheAmount" }),
    publicClient.readContract({ address: contractAddress, abi: DCA_VAULT_ABI, functionName: "interval" }),
  ]);
  return { initialized, cancelled, currentStep, totalSteps,
           nextExecutionTimestamp: nextExecTs, remainingBalance, trancheAmount: trancheAmt,
           interval };
}
