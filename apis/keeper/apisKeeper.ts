// Apis-Keeper — plattformneutraler Kern.
//
// Eigener, von OSIRIS' keeper/squidKeeper.ts getrennter Keeper (siehe
// Gesamtplan §17: eigene Wallet, eigenes Deployment — Nonce-Konflikt,
// Treasury-Kopplung und Blast-Radius sprechen dagegen, denselben Keeper-
// Prozess/dieselbe Wallet wie OSIRIS zu nutzen). Läuft absichtlich nach
// demselben, bewährten Muster wie squidKeeper.ts, ist aber eine eigenständige
// Kopie — keine Änderung an keeper/squidKeeper.ts.
//
// Stand dieser Datei: enthält den Auto-Refuel-Mechanismus (Apis-Keeper-Wallet
// hält aktuell 10 CELO Startguthaben, siehe Chat) — 1:1 nach OSIRIS-Vorbild,
// aber verallgemeinert auf fünf mögliche Gebühren-Token statt zwei, weil
// ConditionalSellOrder-Gebühren im jeweiligen sellToken anfallen (beliebig,
// nicht nur Stablecoins). Der eigentliche Ausführungs-Zyklus (Preis-Checks
// gegen die Provider-Registry + ConditionalSellOrder.execute()-Aufrufe) ist
// noch nicht gebaut — siehe TODO am Dateiende.

import { createWalletClient, createPublicClient, http, fallback, parseUnits } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "../../src/dcaVaultAbi";
import { INPUT_TOKENS, TARGET_TOKENS } from "../../src/config";

// ─── Konfiguration (plattformneutral) ─────────────────────────────────────────
//
// Env wird vom jeweiligen Entry-Point befüllt (worker.ts, Cloudflare Workers
// Secrets) — analog zu createKeeperContext() in squidKeeper.ts. Eigene
// Secrets, auch wenn SQUID_INTEGRATOR_ID aktuell denselben Wert wie OSIRIS
// trägt (bewusste Wiederverwendung der ID, siehe Gesamtplan §17 — trotzdem
// als eigenes, unabhängig konfigurierbares Secret in diesem Worker hinterlegt).

export interface ApisKeeperEnv {
  APIS_KEEPER_PRIVATE_KEY:   string;
  SQUID_INTEGRATOR_ID:       string;
  APIS_REFUEL_THRESHOLD?:    string;
  APIS_REFUEL_PCT_BPS?:      string;
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

  return { account, walletClient, publicClient, integratorId, refuelThreshold, refuelPercentBps };
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

// ─── TODO: Ausführungs-Zyklus ─────────────────────────────────────────────────
//
// Noch nicht gebaut, absichtlich nicht Teil dieses Commits:
//   1. Preis-Check pro beobachtetem Token gegen die Provider-Registry
//      (Mento SortedOracles / RedStone / Squid `/token-price`, siehe
//      Gesamtplan §16) — pro Token gebündelt, nicht pro Order.
//   2. Bei erfüllter Bedingung: ConditionalSellOrder.execute() aufrufen
//      (Contract + ABI existieren, siehe contracts/ConditionalSellOrder.sol —
//      TS-ABI dafür fehlt noch, analog zu src/dcaVaultAbi.ts anzulegen).
//   3. refuelApisKeeperWallet() am Ende jedes Zyklus aufrufen, wie
//      autoRefuelCelo() am Ende von runKeeperCycle() in squidKeeper.ts.
//
// Braucht zusätzlich noch einen Ort, an dem "welche Order beobachtet welche
// Bedingung" gespeichert wird (Apis-Backend/Datenbank) — das ist kein
// On-Chain-Zustand (die Preisbedingung selbst lebt bewusst off-chain, siehe
// Gesamtplan §15) und existiert als Konzept noch nicht als Code.
