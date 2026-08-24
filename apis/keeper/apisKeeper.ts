// Apis-Keeper — plattformneutraler Kern.
//
// Eigener, von OSIRIS' keeper/squidKeeper.ts getrennter Keeper (siehe
// Gesamtplan §17: eigene Wallet, eigenes Deployment — Nonce-Konflikt,
// Treasury-Kopplung und Blast-Radius sprechen dagegen, denselben Keeper-
// Prozess/dieselbe Wallet wie OSIRIS zu nutzen). Läuft absichtlich nach
// demselben, bewährten Muster wie squidKeeper.ts, ist aber eine eigenständige
// Kopie — keine Änderung an keeper/squidKeeper.ts.
//
// Enthält sowohl den Auto-Refuel-Mechanismus (Apis-Keeper-Wallet hält aktuell
// 10 CELO Startguthaben, siehe Chat) — 1:1 nach OSIRIS-Vorbild, aber
// verallgemeinert auf fünf mögliche Gebühren-Token statt zwei, weil
// TriggerVault-Gebühren im jeweiligen heldToken anfallen (beliebig, nicht nur
// Stablecoins) — als auch den eigentlichen Ausführungs-Zyklus
// (runApisKeeperCycle): liest alle Vaults der TriggerVaultFactory, prüft ihre
// on-chain gespeicherte Preisbedingung gegen Squids `/token-price`, ruft bei
// erfüllter Bedingung execute() auf und refuelt am Ende. Läuft erst
// produktiv, sobald TRIGGER_VAULT_FACTORY_ADDRESS gesetzt ist (Contract ist
// noch nicht deployt, siehe script/DeployTriggerVaultFactory.s.sol).
//
// Ersetzt den früheren ConditionalSellOrder-basierten Zyklus (siehe Chat:
// "eigener Vault pro Plan" statt eines geteilten Contracts) — pro Vault gibt
// es GENAU EINEN Trigger, nicht mehr eine Liste von Orders auf einem
// gemeinsamen Contract.

import { createWalletClient, createPublicClient, http, fallback, parseUnits } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "../../src/dcaVaultAbi";
import { INPUT_TOKENS, TARGET_TOKENS } from "../../src/config";
import { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI, type TriggerVaultState } from "./triggerVaultAbi";

// ─── Konfiguration (plattformneutral) ─────────────────────────────────────────
//
// Env wird vom jeweiligen Entry-Point befüllt (worker.ts, Cloudflare Workers
// Secrets) — analog zu createKeeperContext() in squidKeeper.ts. Eigene
// Secrets, auch wenn SQUID_INTEGRATOR_ID aktuell denselben Wert wie OSIRIS
// trägt (bewusste Wiederverwendung der ID, siehe Gesamtplan §17 — trotzdem
// als eigenes, unabhängig konfigurierbares Secret in diesem Worker hinterlegt).

export interface ApisKeeperEnv {
  APIS_KEEPER_PRIVATE_KEY:        string;
  SQUID_INTEGRATOR_ID:            string;
  APIS_REFUEL_THRESHOLD?:         string;
  APIS_REFUEL_PCT_BPS?:           string;
  // Noch nicht deployt (siehe script/DeployTriggerVaultFactory.s.sol) —
  // solange dieses Secret fehlt, überspringt runApisKeeperCycle() den
  // Ausführungs-Zyklus komplett und macht nur den bereits fertigen
  // Refuel-Schritt.
  TRIGGER_VAULT_FACTORY_ADDRESS?: string;
}

function createApisKeeperContext(env: ApisKeeperEnv) {
  const privateKey = env.APIS_KEEPER_PRIVATE_KEY as `0x${string}`;
  if (!privateKey) {
    throw new Error("APIS_KEEPER_PRIVATE_KEY Umgebungsvariable fehlt.");
  }

  const integratorId = env.SQUID_INTEGRATOR_ID;
  if (!integratorId) {
    throw new Error("SQUID_INTEGRATOR_ID Umgebungsvariable fehlt.");
  }

  // Dieselbe RPC-Fallback-Strategie wie OSIRIS' Keeper (forno.celo.org fällt
  // unter Last öfter mit einem undifferenzierten Netzwerkfehler aus).
  const RPC_URLS = [
    "https://forno.celo.org",
    "https://rpc.ankr.com/celo",
  ];
  const rpcTransport = fallback(RPC_URLS.map((url) => http(url)));

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: celo, transport: rpcTransport });
  const publicClient = createPublicClient({ chain: celo, transport: rpcTransport });

  const refuelThreshold = parseUnits(env.APIS_REFUEL_THRESHOLD ?? "5", 6); // 5 USD-Äquivalent, wie OSIRIS
  const refuelPercentBps = BigInt(env.APIS_REFUEL_PCT_BPS ?? "4000");      // 40 %, wie OSIRIS
  const triggerVaultFactoryAddress = env.TRIGGER_VAULT_FACTORY_ADDRESS as `0x${string}` | undefined;

  return { account, walletClient, publicClient, integratorId, refuelThreshold, refuelPercentBps, triggerVaultFactoryAddress };
}

type ApisKeeperContext = ReturnType<typeof createApisKeeperContext>;

// ─── Squid-Route holen ────────────────────────────────────────────────────────
//
// Eigene Kopie statt Import aus squidKeeper.ts (dort nicht exportiert, und
// keeper/squidKeeper.ts wird bewusst nicht verändert) — inhaltlich identisch
// zum OSIRIS-Vorbild inkl. Rate-Limit-Handling.

interface SquidTransactionRequest {
  target: `0x${string}`;
  data:   `0x${string}`;
}
interface SquidEstimate {
  toAmountMin: string;
}
interface SquidRoute {
  transactionRequest: SquidTransactionRequest;
  estimate:            SquidEstimate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SQUID_REQUEST_SPACING_MS = 4_000;
const SQUID_MAX_RETRIES = 5;

async function getSquidRoute(integratorId: string, params: {
  fromToken:   `0x${string}`;
  toToken:     `0x${string}`;
  fromAmount:  string;
  fromAddress: `0x${string}`;
  toAddress:   `0x${string}`;
}): Promise<SquidRoute> {
  for (let attempt = 1; attempt <= SQUID_MAX_RETRIES; attempt++) {
    const response = await fetch("https://apiplus.squidrouter.com/v2/route", {
      method: "POST",
      headers: {
        "x-integrator-id": integratorId,
        "Content-Type":    "application/json",
      },
      body: JSON.stringify({
        fromChain:   "42220",
        toChain:     "42220",
        fromToken:   params.fromToken,
        toToken:     params.toToken,
        fromAmount:  params.fromAmount,
        fromAddress: params.fromAddress,
        toAddress:   params.toAddress,
        slippage:      5,
        quoteOnly:   false,
      }),
    });

    if (response.ok) {
      const data = await response.json() as { route: SquidRoute };
      return data.route;
    }

    const isRateLimit = response.status === 429;
    if (!isRateLimit || attempt === SQUID_MAX_RETRIES) {
      throw new Error(`Squid-Route fehlgeschlagen: ${response.status} ${await response.text()}`);
    }

    const backoffMs = SQUID_REQUEST_SPACING_MS * attempt;
    console.warn(`Apis-Keeper: Squid Rate-Limit (429) — warte ${backoffMs}ms (Versuch ${attempt}/${SQUID_MAX_RETRIES})`);
    await sleep(backoffMs);
  }
  throw new Error("Squid-Route: unerreichbar nach maximalen Versuchen.");
}

// ─── Auto-Refuel: Gebühren-Token → CELO ───────────────────────────────────────
//
// Anders als bei OSIRIS (Gebühren immer in USDC/USDT, siehe
// REFUEL_STABLE_TOKENS in squidKeeper.ts) können ConditionalSellOrder-
// Gebühren in JEDEM unterstützten sellToken anfallen — der User verkauft ja
// nicht zwangsläufig eine Stablecoin. Die Kandidatenliste deckt deshalb alle
// fünf Nicht-CELO-Token ab, die OSIRIS/Apis kennen (CELO selbst ausgenommen,
// da bereits das Refuel-Ziel — ein CELO-Gebührenanteil erhöht die Gasreserve
// direkt, ohne Swap).

const REFUEL_CANDIDATE_TOKENS: { symbol: string; address: `0x${string}` }[] = [
  { symbol: "USDC",  address: INPUT_TOKENS.USDC.address },
  { symbol: "USDT",  address: INPUT_TOKENS.USDT.address },
  { symbol: "wBTC",  address: TARGET_TOKENS.wBTC.address },
  { symbol: "wETH",  address: TARGET_TOKENS.wETH.address },
  { symbol: "XAUoT", address: TARGET_TOKENS.XAUoT.address },
];

async function refuelFromToken(ctx: ApisKeeperContext, token: { symbol: string; address: `0x${string}` }): Promise<void> {
  const balance = await ctx.publicClient.readContract({
    address: token.address, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.account.address],
  }) as bigint;

  if (balance <= ctx.refuelThreshold) return;

  const swapAmount = (balance * ctx.refuelPercentBps) / 10_000n;
  if (swapAmount === 0n) return;

  console.info(`Apis-Keeper: Auto-Refuel ${token.symbol} -> CELO, Betrag ${swapAmount}`);

  const route = await getSquidRoute(ctx.integratorId, {
    fromToken:   token.address,
    toToken:     TARGET_TOKENS.CELO.address,
    fromAmount:  swapAmount.toString(),
    fromAddress: ctx.account.address,
    toAddress:   ctx.account.address,
  });

  const approveHash = await ctx.walletClient.writeContract({
    address:      token.address,
    abi:          ERC20_ABI,
    functionName: "approve",
    args:         [route.transactionRequest.target, swapAmount],
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: approveHash });

  const swapHash = await ctx.walletClient.sendTransaction({
    account: ctx.account,
    to:   route.transactionRequest.target,
    data: route.transactionRequest.data,
  });
  await ctx.publicClient.waitForTransactionReceipt({ hash: swapHash });

  console.info(`Apis-Keeper: Auto-Refuel ${token.symbol} erfolgreich. Tx: ${swapHash}`);
}

/// Prüft alle Gebühren-Token-Kandidaten und tauscht bei Überschreiten von
/// refuelThreshold jeweils refuelPercentBps in CELO. Ein fehlschlagender
/// Token blockiert die anderen nicht (gleiches Verhalten wie
/// autoRefuelCelo() in squidKeeper.ts).
export async function refuelApisKeeperWallet(env: ApisKeeperEnv): Promise<void> {
  const ctx = createApisKeeperContext(env);
  for (const token of REFUEL_CANDIDATE_TOKENS) {
    try {
      await refuelFromToken(ctx, token);
    } catch (err) {
      console.error(`Apis-Keeper: Auto-Refuel für ${token.symbol} fehlgeschlagen:`, err);
    }
  }
}

// ─── Preis holen (Squid `/token-price`) ───────────────────────────────────────
//
// V1-Preisquelle, siehe Gesamtplan §16: pragmatisch einheitlich über alle
// Zieltoken hinweg statt Mento SortedOracles/RedStone-Integration mit
// pro-Token-Rate-Feed-IDs, die sich nicht ohne Live-Zugriff verifizieren
// lassen. Gibt den USD-Preis als Zahl zurück (Squid liefert ihn bereits
// dezimal, nicht als Fixed-Point-Integer).

async function getTokenPriceUsd(integratorId: string, tokenAddress: `0x${string}`): Promise<number> {
  const url = new URL("https://apiplus.squidrouter.com/v2/token-price");
  url.searchParams.set("chainId", "42220");
  url.searchParams.set("tokenAddress", tokenAddress);

  const response = await fetch(url, { headers: { "x-integrator-id": integratorId } });
  if (!response.ok) {
    throw new Error(`Squid token-price fehlgeschlagen: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as { price: number };
  return data.price;
}

// ─── Preisbedingung prüfen ─────────────────────────────────────────────────────
//
// triggerPrice ist 8-dezimal skaliert (wie Chainlink/Squid), siehe
// TriggerVault.sol und apis/backend/src/planCompiler.ts.

function isTriggerMet(vault: TriggerVaultState, priceUsd: number): boolean {
  const triggerPriceUsd = Number(vault.triggerPrice) / 1e8;
  return vault.triggerAbove ? priceUsd >= triggerPriceUsd : priceUsd <= triggerPriceUsd;
}

const SLIPPAGE_BPS_BUFFER = 300; // wie squidKeeper.ts — 3 % Puffer auf Squids toAmountMin

function applyBuffer(toAmountMin: string): bigint {
  const raw = BigInt(toAmountMin);
  return (raw * BigInt(10_000 - SLIPPAGE_BPS_BUFFER)) / 10_000n;
}

// ─── Einen einzelnen Vault lesen ───────────────────────────────────────────────

async function readVaultState(ctx: ApisKeeperContext, vaultAddress: `0x${string}`): Promise<TriggerVaultState> {
  const [owner, heldToken, outputToken, watchToken, amount, triggerAbove, triggerPrice, expiresAt] = await Promise.all([
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "owner" }) as Promise<`0x${string}`>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "heldToken" }) as Promise<`0x${string}`>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "outputToken" }) as Promise<`0x${string}`>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "watchToken" }) as Promise<`0x${string}`>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "amount" }) as Promise<bigint>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "triggerAbove" }) as Promise<boolean>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "triggerPrice" }) as Promise<bigint>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "expiresAt" }) as Promise<bigint>,
  ]);
  return { address: vaultAddress, owner, heldToken, outputToken, watchToken, amount, triggerAbove, triggerPrice, expiresAt };
}

// ─── Einen einzelnen Vault ausführen ───────────────────────────────────────────
//
// Zieht dieselbe Gebühr-vorab-abschätzen-Logik wie OSIRIS' executeVaultStep()
// nach (siehe squidKeeper.ts): Squid muss den NETTO-Betrag nach Gebührenabzug
// zum Quotieren bekommen, sonst approved der Contract beim swap zu wenig und
// der Router-Call scheitert. fromAddress ist der Vault selbst (er hält
// heldToken bis zum Swap, siehe execute() in TriggerVault.sol), toAddress ist
// vault.owner (dort wird der Balance-Zuwachs gemessen).

async function executeVault(
  ctx: ApisKeeperContext,
  factoryAddress: `0x${string}`,
  vault: TriggerVaultState,
): Promise<`0x${string}`> {
  const [feeBps, minFee] = await ctx.publicClient.readContract({
    address: factoryAddress, abi: TRIGGER_VAULT_FACTORY_ABI, functionName: "feeInfo",
  }) as [number, bigint, `0x${string}`];

  // Vault-Bestand statt vault.amount lesen — muss identisch sein (der Vault
  // hält exakt den bei setupPlan() eingezahlten Betrag bis zur Ausführung),
  // ist aber die tatsächliche On-Chain-Quelle der Wahrheit.
  const vaultBalance = await ctx.publicClient.readContract({
    address: vault.heldToken, abi: ERC20_ABI, functionName: "balanceOf", args: [vault.address],
  }) as bigint;
  if (vaultBalance === 0n) throw new Error(`Vault ${vault.address}: nichts zu tauschen (Bestand 0).`);

  let feeAmount = (vaultBalance * BigInt(feeBps)) / 10_000n;
  if (feeAmount < minFee) feeAmount = minFee;
  const netAmount = vaultBalance - feeAmount;

  const route = await getSquidRoute(ctx.integratorId, {
    fromToken:   vault.heldToken,
    toToken:     vault.outputToken,
    fromAmount:  netAmount.toString(),
    fromAddress: vault.address,
    toAddress:   vault.owner,
  });

  const minAmountOut = applyBuffer(route.estimate.toAmountMin);

  // Vor dem Broadcast simulieren — deckt z.B. SlippageExceeded oder eine seit
  // dem Preis-Check inzwischen abgelaufene expiresAt auf, ohne echtes Gas zu
  // verbrennen (gleiches Muster wie executeVaultStep() in squidKeeper.ts).
  const { request } = await ctx.publicClient.simulateContract({
    account:      ctx.account,
    address:      vault.address,
    abi:          TRIGGER_VAULT_ABI,
    functionName: "execute",
    args:         [route.transactionRequest.target, minAmountOut, route.transactionRequest.data],
  });

  const hash = await ctx.walletClient.writeContract(request);
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// ─── Ausführungs-Zyklus ─────────────────────────────────────────────────────────
//
// Sequenziell statt parallel: sowohl Squids Rate-Limit als auch die Nonce-
// Verwaltung der Keeper-Wallet vertragen keine parallelen Broadcasts (gleiche
// Begründung wie runKeeperCycle() in squidKeeper.ts). Ein fehlschlagender
// Vault (z.B. SlippageExceeded für einen einzelnen Nutzer) darf die anderen
// nicht blockieren.

export interface ApisKeeperCycleResult {
  vaultAddress: `0x${string}`;
  txHash:       `0x${string}`;
}

export async function runApisKeeperCycle(env: ApisKeeperEnv): Promise<ApisKeeperCycleResult[]> {
  const ctx = createApisKeeperContext(env);
  const results: ApisKeeperCycleResult[] = [];

  if (!ctx.triggerVaultFactoryAddress) {
    console.info("Apis-Keeper: TRIGGER_VAULT_FACTORY_ADDRESS nicht gesetzt (noch nicht deployt) — überspringe Ausführungs-Zyklus.");
    await refuelApisKeeperWallet(env);
    return results;
  }

  const factoryAddress = ctx.triggerVaultFactoryAddress;
  const allVaults = await ctx.publicClient.readContract({
    address: factoryAddress, abi: TRIGGER_VAULT_FACTORY_ABI, functionName: "getAllVaults",
  }) as `0x${string}`[];

  for (let i = 0; i < allVaults.length; i++) {
    const vaultAddress = allVaults[i];
    try {
      const canExecute = await ctx.publicClient.readContract({
        address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "canExecute",
      }) as boolean;
      if (!canExecute) continue; // initialisiert & nicht storniert/ausgeführt/abgelaufen

      const authorized = await ctx.publicClient.readContract({
        address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "isKeeper", args: [ctx.account.address],
      }) as boolean;
      if (!authorized) continue; // globalKeeper wird zwar bei jedem Vault automatisch freigeschaltet (initialize()) — Absicherung falls der Owner ihn per setKeeper() wieder entzogen hat

      const vault = await readVaultState(ctx, vaultAddress);
      const priceUsd = await getTokenPriceUsd(ctx.integratorId, vault.watchToken);
      if (!isTriggerMet(vault, priceUsd)) continue;

      console.info(`Apis-Keeper: Vault ${vaultAddress} erfüllt Preisbedingung (Preis ${priceUsd}, Trigger ${vault.triggerAbove ? ">=" : "<="} ${Number(vault.triggerPrice) / 1e8}) — führe aus.`);
      const txHash = await executeVault(ctx, factoryAddress, vault);
      results.push({ vaultAddress, txHash });
      console.info(`Apis-Keeper: Vault ${vaultAddress} ausgeführt. Tx: ${txHash}`);
    } catch (err) {
      console.error(`Apis-Keeper: Fehler bei Vault ${vaultAddress}:`, err);
    }

    if (i + 1 < allVaults.length) await sleep(SQUID_REQUEST_SPACING_MS); // Rate-Limit-Abstand
  }

  await refuelApisKeeperWallet(env);
  return results;
}
