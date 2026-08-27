// Keeper-Service — plattformneutraler Kern.
//
// Läuft sowohl als Node.js-Prozess (keeper/cli.ts, GitHub Actions) als auch
// als Cloudflare Worker (keeper/worker.ts, Cron Trigger). Deshalb greift
// dieser Kern NICHT direkt auf process.env zu — alle Konfiguration kommt
// über das Env-Objekt (createKeeperContext), das die jeweilige Entry-Point-
// Datei aus ihrer eigenen Laufzeitumgebung befüllt.
//
// Architektur: Der Vault ruft keinen DEX-Router mehr selbst auf. Stattdessen
// holt DIESER Keeper für jeden Zieltoken eine fertige, ausführbare Route
// (Ziel-Router + Calldata) von der Squid-API (quoteOnly=false) und übergibt
// sie per DcaVault.executeStep(routers[], minAmountsOut[], squidCallData[])
// an den Vault. Der Vault prüft nur noch, dass der Router freigegeben ist
// (approvedRouters) und dass `owner` danach mindestens minAmountsOut[i] mehr
// vom Zieltoken hat als vorher.
//
// Multi-Vault: Seit der DcaVaultFactory (EIP-1167-Clones) gibt es potenziell
// viele Vaults. Der Keeper prüft ALLE (Factory-Clones + den einen Vault, der
// vor der Factory direkt deployt wurde und nicht in factory.getAllVaults()
// auftaucht) und führt jeden aus, der gerade dran ist.
//
// Trigger-Pläne (TriggerVaultFactory, siehe contracts/TriggerVault.sol) laufen
// über denselben Zyklus und dieselbe Keeper-Wallet wie DCA — anders als der
// ursprüngliche, inzwischen verworfene APIS-Plan mit eigenem Keeper-Prozess
// (siehe Git-Historie apis/keeper/apisKeeper.ts, dessen bewährte Preis-Check-
// Logik hier 1:1 übernommen wird): Owner/Blast-Radius/Treasury sind ohnehin
// dieselben (OSIRIS besitzt jetzt beide Vault-Typen), ein zweiter Prozess mit
// eigenem Wallet/Secrets hätte hier keinen Vorteil mehr.

import { createWalletClient, createPublicClient, http, fallback, defineChain, parseUnits } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI, ERC20_ABI } from "../src/dcaVaultAbi";
import { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI } from "../src/triggerVaultAbi";
import { SEND_VAULT_ABI, SEND_VAULT_FACTORY_ABI } from "../src/sendVaultAbi";
import {
  VAULT_ADDRESS, ACTIVE_CHAIN_ID, CELO_CHAIN_ID, INPUT_TOKENS, TARGET_TOKENS,
  TRIGGER_VAULT_FACTORY_ADDRESS, SEND_VAULT_FACTORY_ADDRESS,
} from "../src/config";

// Celo Sepolia ist in viem/chains (Stand 2.21) nicht enthalten — eigene Definition,
// passend zu den RPC-Endpoints aus foundry.toml.
const celoSepolia = defineChain({
  id: 11142220,
  name: "Celo Sepolia",
  nativeCurrency: { name: "Celo", symbol: "CELO", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://forno.celo-sepolia.celo-testnet.org"] },
  },
  blockExplorers: {
    default: { name: "Celoscan", url: "https://sepolia.celoscan.io" },
  },
  testnet: true,
});

const activeChain = ACTIVE_CHAIN_ID === CELO_CHAIN_ID ? celo : celoSepolia;

// Vaults werden in Gruppen dieser Größe parallel auf canExecute() geprüft,
// um den RPC-Provider bei vielen Vaults nicht mit hunderten gleichzeitigen
// Calls zu überlasten.
const BATCH_SIZE = 10;

// 1 % zusätzlicher Puffer auf Squids eigene Slippage-Berechnung,
// um kurzfristige Marktbewegungen zwischen Quote und On-Chain-Ausführung
// abzufedern, ohne die Slippage-Kontrolle auszuhebeln.
const SLIPPAGE_BPS_BUFFER = 300;

// ─── Konfiguration (plattformneutral) ─────────────────────────────────────────
//
// Env wird von der jeweiligen Entry-Point-Datei befüllt: cli.ts aus
// process.env (Node/GitHub Actions), worker.ts aus dem env-Parameter, den
// Cloudflare Workers dem scheduled()-Handler übergibt (Workers Secrets).

export interface Env {
  KEEPER_PRIVATE_KEY:     string;
  SQUID_INTEGRATOR_ID:    string;
  FACTORY_ADDRESSES?:     string;
  FACTORY_ADDRESS?:       string;
  KEEPER_REFUEL_THRESHOLD?: string;
  KEEPER_REFUEL_PCT_BPS?:   string;
}

// Von der tatsächlichen Rückgabe von createKeeperContext() abgeleitet statt
// als separates Interface deklariert: viem's createWalletClient/createPublicClient
// sind generisch — ReturnType<typeof createWalletClient> (ohne konkrete
// Aufruf-Argumente) liefert die unspezifische Default-Instanziierung und
// verliert die aus dem echten Aufruf hier unten inferierten konkreten Typen
// (chain, account), was writeContract()/sendTransaction()-Aufrufen weiter
// unten fälschlich ein fehlendes `chain`-Feld vorwirft.
type KeeperContext = ReturnType<typeof createKeeperContext>;

function createKeeperContext(env: Env) {
  const privateKey = env.KEEPER_PRIVATE_KEY as `0x${string}`;
  if (!privateKey) {
    throw new Error("KEEPER_PRIVATE_KEY Umgebungsvariable fehlt.");
  }

  // Solange die echte Integrator-ID bei Squid noch nicht beantragt/vergeben
  // ist, steht hier der Platzhalter "PENDING"; der Keeper verweigert in dem
  // Fall den Start mit einer klaren Fehlermeldung, statt Requests zu senden,
  // die Squid im Zweifel ablehnt oder ratelimited.
  const integratorId = env.SQUID_INTEGRATOR_ID;
  if (!integratorId) {
    throw new Error("SQUID_INTEGRATOR_ID Umgebungsvariable fehlt.");
  }
  if (integratorId === "PENDING") {
    throw new Error(
      "SQUID_INTEGRATOR_ID ist noch der Platzhalter 'PENDING'. " +
      "Echte Integrator-ID bei Squid (https://app.squidrouter.com/) beantragen " +
      "und als Secret hinterlegen, bevor der Keeper live läuft."
    );
  }

  // Komma-getrennte Liste statt einer einzelnen Adresse: sobald ein neuer
  // Factory-Deploy stattfindet (z.B. für einen Contract-Upgrade wie den
  // Gebühren-Mechanismus), erstellen neue Nutzer ihre Vaults über die neue
  // Factory — bestehende Nutzer-Vaults laufen aber weiter über die ALTE
  // Factory. Würde FACTORY_ADDRESSES beim Upgrade einfach ersetzt statt
  // ergänzt, würde der Keeper die alten Vaults nicht mehr finden und sie
  // stillschweigend nicht mehr ausführen. Deshalb bleiben alte Factory-
  // Adressen hier stehen, bis die letzten darüber erstellten Vaults
  // ausgelaufen sind. FACTORY_ADDRESS (Singular) wird als Fallback weiter
  // unterstützt, um bestehende Konfigurationen nicht zu brechen.
  const rawFactories = env.FACTORY_ADDRESSES ?? env.FACTORY_ADDRESS;
  if (!rawFactories) {
    throw new Error("FACTORY_ADDRESSES (oder FACTORY_ADDRESS) Umgebungsvariable fehlt.");
  }
  const factoryAddresses = rawFactories.split(",").map((address) => address.trim() as `0x${string}`);

  // forno.celo.org (viems Default-Endpunkt für Celo) fällt unter Last öfter
  // mit einem undifferenzierten Netzwerkfehler aus (siehe src/minipayWallet.ts,
  // dort dasselbe Problem beim Frontend) — fallback() wechselt bei einem
  // Fehler automatisch auf den nächsten Endpunkt statt den ganzen Keeper-
  // Zyklus für den betroffenen Vault abzubrechen.
  // celo.drpc.org bewusst NICHT mehr dabei: lehnt eth_getLogs teils hart mit
  // "method does not exist/is not available" ab (siehe src/minipayWallet.ts).
  const RPC_URLS = [
    "https://forno.celo.org",
    "https://rpc.ankr.com/celo",
  ];
  const rpcTransport = activeChain === celo ? fallback(RPC_URLS.map((url) => http(url))) : http();

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: activeChain, transport: rpcTransport });
  const publicClient = createPublicClient({ chain: activeChain, transport: rpcTransport });

  const refuelThreshold = parseUnits(env.KEEPER_REFUEL_THRESHOLD ?? "5", 6); // 5 USD-Äquivalent
  const refuelPercentBps = BigInt(env.KEEPER_REFUEL_PCT_BPS ?? "4000");     // 40 %

  return { account, walletClient, publicClient, integratorId, factoryAddresses, refuelThreshold, refuelPercentBps };
}

// ─── Squid-Route holen ────────────────────────────────────────────────────────

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

// Mindestabstand zwischen zwei Squid-Requests. Neu vergebene Integrator-IDs
// haben teils ein sehr niedriges Rate-Limit (beobachtet: ~0.27 req/s ≈ 1 Request
// alle 3.7s) — die eigenen "retry-after"-Header von Squid waren dabei zu klein,
// um sich darauf zu verlassen, daher ein fester, konservativer Abstand plus
// Retry-with-Backoff als zusätzliches Netz.
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
        fromChain:   ACTIVE_CHAIN_ID,
        toChain:     ACTIVE_CHAIN_ID, // Same-Chain-Swap innerhalb Celo
        fromToken:   params.fromToken,
        toToken:     params.toToken,
        fromAmount:  params.fromAmount,
        fromAddress: params.fromAddress, // = Vault: er ist msg.sender beim Router-Call
        toAddress:   params.toAddress,   // = Owner: dorthin soll der Output fließen
        slippage:      5,                // % — Contract erzwingt minAmountOut zusätzlich on-chain
        quoteOnly:   false,              // echte, ausführbare Route inkl. Calldata
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

    const backoffMs = SQUID_REQUEST_SPACING_MS * attempt; // 4s, 8s, 12s, 16s
    console.warn(
      `Squid: Rate-Limit (429) für ${params.toToken} — warte ${backoffMs}ms ` +
      `(Versuch ${attempt}/${SQUID_MAX_RETRIES})`
    );
    await sleep(backoffMs);
  }
  throw new Error("Squid-Route: unerreichbar nach maximalen Versuchen.");
}

// ─── Sicherheitspuffer auf toAmountMin anwenden ───────────────────────────────

function applyBuffer(toAmountMin: string): bigint {
  const raw = BigInt(toAmountMin);
  return (raw * BigInt(10_000 - SLIPPAGE_BPS_BUFFER)) / 10_000n;
}

// ─── Trigger-Pläne: Preis holen (Squid `/token-price`) ────────────────────────
//
// V1-Preisquelle, bewusst pragmatisch einheitlich über alle Zieltoken hinweg
// statt Mento SortedOracles/RedStone-Integration mit pro-Token-Rate-Feed-IDs.
// Gibt den USD-Preis als Zahl zurück (Squid liefert ihn bereits dezimal, nicht
// als Fixed-Point-Integer).

async function getTokenPriceUsd(integratorId: string, tokenAddress: `0x${string}`): Promise<number> {
  const url = new URL("https://apiplus.squidrouter.com/v2/token-price");
  url.searchParams.set("chainId", ACTIVE_CHAIN_ID);
  url.searchParams.set("tokenAddress", tokenAddress);

  const response = await fetch(url, { headers: { "x-integrator-id": integratorId } });
  if (!response.ok) {
    throw new Error(`Squid token-price fehlgeschlagen: ${response.status} ${await response.text()}`);
  }
  // Antwort ist { token: { ..., usdPrice: number, ... } } — KEIN "price"-Feld
  // auf oberster Ebene (siehe Chat: mit curl gegen die echte API verifiziert,
  // vorher lief die Preisprüfung wegen data.price === undefined immer ins
  // Leere, egal wie der tatsächliche Kurs stand).
  const data = await response.json() as { token?: { usdPrice?: number } };
  const price = data.token?.usdPrice;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw new Error(`Squid token-price: kein gültiger usdPrice in der Antwort: ${JSON.stringify(data)}`);
  }
  return price;
}

// triggerPrice ist 8-dezimal skaliert (wie Chainlink/Squid), siehe
// TriggerVault.sol und src/minipayWallet.ts (submitTriggerPlan).
interface TriggerVaultState {
  address:      `0x${string}`;
  owner:        `0x${string}`;
  heldToken:    `0x${string}`;
  outputToken:  `0x${string}`;
  watchToken:   `0x${string}`;
  triggerAbove: boolean;
  triggerPrice: bigint;
}

function isTriggerMet(vault: TriggerVaultState, priceUsd: number): boolean {
  const triggerPriceUsd = Number(vault.triggerPrice) / 1e8;
  return vault.triggerAbove ? priceUsd >= triggerPriceUsd : priceUsd <= triggerPriceUsd;
}

// ─── Vaults einsammeln ────────────────────────────────────────────────────────
//
// VAULT_ADDRESS (aus src/config.ts) wurde vor der Factory direkt deployt und
// taucht in factory.getAllVaults() nicht auf — er läuft aber weiter, bis alle
// 5 Tranchen ausgeführt sind, und wird deshalb explizit mit aufgenommen.

async function getAllVaultAddresses(ctx: KeeperContext): Promise<`0x${string}`[]> {
  const perFactoryVaults = await Promise.all(
    ctx.factoryAddresses.map((factoryAddress) =>
      ctx.publicClient.readContract({
        address: factoryAddress,
        abi:     DCA_VAULT_FACTORY_ABI,
        functionName: "getAllVaults",
      }) as Promise<`0x${string}`[]>
    )
  );

  return [...new Set([VAULT_ADDRESS, ...perFactoryVaults.flat()])];
}

// ─── canExecute() in Batches prüfen ───────────────────────────────────────────

async function findExecutableVaults(ctx: KeeperContext, vaultAddresses: `0x${string}`[]): Promise<`0x${string}`[]> {
  const executable: `0x${string}`[] = [];

  for (let i = 0; i < vaultAddresses.length; i += BATCH_SIZE) {
    const batch = vaultAddresses.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((vault) =>
        ctx.publicClient.readContract({ address: vault, abi: DCA_VAULT_ABI, functionName: "canExecute" })
      )
    );
    batch.forEach((vault, idx) => {
      if (results[idx]) executable.push(vault);
    });
  }

  return executable;
}

// ─── Einen Vault ausführen ────────────────────────────────────────────────────

async function executeVaultStep(ctx: KeeperContext, vaultAddress: `0x${string}`) {
  const [trancheAmount, targetConfigs, inputTokenAddress, ownerAddress, currentStep, totalSteps] = await Promise.all([
    ctx.publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "trancheAmount" }),
    ctx.publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "getTargetConfigs" }),
    ctx.publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "inputToken" }),
    ctx.publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "owner" }),
    ctx.publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "currentStep" }),
    ctx.publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "totalSteps" }),
  ]);

  // amountForThisStep wie im Contract: beim letzten Schritt der komplette
  // Restbestand (fängt Rundungs-Dust aus totalAmount/duration auf), sonst
  // die feste trancheAmount.
  const isLastStep = BigInt(currentStep as number) + 1n === BigInt(totalSteps as number);
  const amountForThisStep = isLastStep
    ? (await ctx.publicClient.readContract({
        address:      inputTokenAddress as `0x${string}`,
        abi:          ERC20_ABI,
        functionName: "balanceOf",
        args:         [vaultAddress],
      })) as bigint
    : (trancheAmount as bigint);

  // ── Gebühr spiegeln ──────────────────────────────────────────────────────
  // Der Contract zieht bei Vaults der neuen Factory vor dem Swap eine Gebühr
  // ab (feeInfo() auf der Factory) — der Keeper muss denselben Netto-Betrag
  // an Squid melden, sonst approved der Contract weniger, als die Squid-
  // Calldata abziehen will, und der Swap-Call revertet mit SwapFailed().
  // Legacy-Vaults (alte Factory-Implementation) haben keinen factory()-
  // Getter — der Call revertet dann einfach, amountNet bleibt = gross.
  let amountNet = amountForThisStep;
  try {
    const vaultFactory = await ctx.publicClient.readContract({
      address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "factory",
    }) as `0x${string}`;
    const [feeBps, minFee] = await ctx.publicClient.readContract({
      address: vaultFactory, abi: DCA_VAULT_FACTORY_ABI, functionName: "feeInfo",
    }) as [number, bigint, `0x${string}`];

    let feeAmount = (amountForThisStep * BigInt(feeBps)) / 10_000n;
    if (feeAmount < minFee) feeAmount = minFee;
    amountNet = amountForThisStep - feeAmount;
  } catch {
    // Kein factory()/feeInfo() auffindbar — Legacy-Vault, keine Gebühr.
  }

  const routers:       `0x${string}`[] = [];
  const minAmountsOut: bigint[]        = [];
  const callData:      `0x${string}`[] = [];

  const configs = targetConfigs as Array<{ token: `0x${string}`; bps: number }>;
  for (let i = 0; i < configs.length; i++) {
    if (i > 0) await sleep(SQUID_REQUEST_SPACING_MS); // Rate-Limit-Abstand zwischen Zieltoken

    const config = configs[i];
    const amountIn = (amountNet * BigInt(config.bps)) / 10_000n;

    const route = await getSquidRoute(ctx.integratorId, {
      fromToken:   inputTokenAddress as `0x${string}`,
      toToken:     config.token,
      fromAmount:  amountIn.toString(),
      fromAddress: vaultAddress,
      toAddress:   ownerAddress as `0x${string}`,
    });

    routers.push(route.transactionRequest.target);
    callData.push(route.transactionRequest.data);
    minAmountsOut.push(applyBuffer(route.estimate.toAmountMin));

    console.info(`  [${vaultAddress}] Route ${config.token}: minAmountOut=${minAmountsOut[minAmountsOut.length - 1]}`);
  }

  // Vor dem Broadcast simulieren — deckt z.B. RouterNotApproved oder
  // SlippageExceeded auf, ohne echtes Gas zu verbrennen.
  const { request } = await ctx.publicClient.simulateContract({
    account: ctx.account,
    address:      vaultAddress,
    abi:          DCA_VAULT_ABI,
    functionName: "executeStep",
    args:         [routers, minAmountsOut, callData],
  });

  const hash = await ctx.walletClient.writeContract(request);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });

  const newStep = await ctx.publicClient.readContract({
    address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "currentStep",
  });

  console.info(`Keeper: Vault ${vaultAddress} — Schritt ${newStep} ausgeführt. Tx: ${hash}`);
  return receipt;
}

// ─── Trigger-Pläne: Vault-Zustand lesen ────────────────────────────────────────

async function readTriggerVaultState(ctx: KeeperContext, vaultAddress: `0x${string}`): Promise<TriggerVaultState> {
  const [owner, heldToken, outputToken, watchToken, triggerAbove, triggerPrice] = await Promise.all([
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "owner" }) as Promise<`0x${string}`>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "heldToken" }) as Promise<`0x${string}`>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "outputToken" }) as Promise<`0x${string}`>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "watchToken" }) as Promise<`0x${string}`>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "triggerAbove" }) as Promise<boolean>,
    ctx.publicClient.readContract({ address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "triggerPrice" }) as Promise<bigint>,
  ]);
  return { address: vaultAddress, owner, heldToken, outputToken, watchToken, triggerAbove, triggerPrice };
}

// ─── Trigger-Pläne: einen Vault ausführen ──────────────────────────────────────
//
// Gleiche Gebühr-vorab-abschätzen-Logik wie executeVaultStep() oben: Squid
// muss den NETTO-Betrag nach Gebührenabzug zum Quotieren bekommen, sonst
// approved der Contract beim Swap zu wenig und der Router-Call revertet mit
// SwapFailed(). fromAddress ist der Vault selbst (er hält heldToken bis zum
// Swap, siehe execute() in TriggerVault.sol), toAddress ist vault.owner (dort
// wird der Balance-Zuwachs gemessen).

async function executeTriggerVaultStep(ctx: KeeperContext, vault: TriggerVaultState) {
  const [feeBps, minFee] = await ctx.publicClient.readContract({
    address: TRIGGER_VAULT_FACTORY_ADDRESS, abi: TRIGGER_VAULT_FACTORY_ABI, functionName: "feeInfo",
  }) as [number, bigint, `0x${string}`];

  // Vault-Bestand statt eines gecachten amount lesen — muss identisch sein
  // (der Vault hält exakt den bei setupPlan() eingezahlten Betrag bis zur
  // Ausführung), ist aber die tatsächliche On-Chain-Quelle der Wahrheit.
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
  // verbrennen (gleiches Muster wie executeVaultStep() oben).
  const { request } = await ctx.publicClient.simulateContract({
    account:      ctx.account,
    address:      vault.address,
    abi:          TRIGGER_VAULT_ABI,
    functionName: "execute",
    args:         [route.transactionRequest.target, minAmountOut, route.transactionRequest.data],
  });

  const hash = await ctx.walletClient.writeContract(request);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });

  console.info(`Keeper: Trigger-Vault ${vault.address} ausgeführt. Tx: ${hash}`);
  return receipt;
}

// ─── Trigger-Pläne: fällige Vaults finden ──────────────────────────────────────
//
// canExecute() prüft nur initialized/cancelled/executed/expiresAt on-chain —
// die eigentliche Preisbedingung (triggerAbove/triggerPrice) ist rein
// informativ im Contract hinterlegt und wird hier gegen Squids `/token-price`
// geprüft (siehe TriggerVault.sol-Architekturkommentar: kein On-Chain-Oracle).

async function findExecutableTriggerVaults(
  ctx: KeeperContext, vaultAddresses: `0x${string}`[],
): Promise<TriggerVaultState[]> {
  const executable: TriggerVaultState[] = [];

  for (const vaultAddress of vaultAddresses) {
    try {
      const canExecute = await ctx.publicClient.readContract({
        address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "canExecute",
      }) as boolean;
      if (!canExecute) {
        console.info(`Keeper: Trigger-Vault ${vaultAddress} übersprungen (canExecute = false).`);
        continue; // initialisiert & nicht storniert/ausgeführt/abgelaufen
      }

      const authorized = await ctx.publicClient.readContract({
        address: vaultAddress, abi: TRIGGER_VAULT_ABI, functionName: "isKeeper", args: [ctx.account.address],
      }) as boolean;
      // globalKeeper wird bei jedem Vault automatisch freigeschaltet (initialize())
      // — Absicherung falls der Owner ihn per setKeeper() wieder entzogen hat.
      if (!authorized) {
        console.info(`Keeper: Trigger-Vault ${vaultAddress} übersprungen (Keeper-Wallet ${ctx.account.address} nicht autorisiert).`);
        continue;
      }

      const vault = await readTriggerVaultState(ctx, vaultAddress);
      const priceUsd = await getTokenPriceUsd(ctx.integratorId, vault.watchToken);
      const triggerPriceUsd = Number(vault.triggerPrice) / 1e8;
      if (!isTriggerMet(vault, priceUsd)) {
        console.info(
          `Keeper: Trigger-Vault ${vaultAddress} noch nicht fällig (Preis ${priceUsd}, ` +
          `Trigger ${vault.triggerAbove ? ">=" : "<="} ${triggerPriceUsd}).`
        );
        continue;
      }

      console.info(
        `Keeper: Trigger-Vault ${vaultAddress} erfüllt Preisbedingung (Preis ${priceUsd}, ` +
        `Trigger ${vault.triggerAbove ? ">=" : "<="} ${triggerPriceUsd}).`
      );
      executable.push(vault);
    } catch (err) {
      // Ein einzelner fehlschlagender Preis-Lookup/RPC-Read (z.B. Squid
      // rate-limited oder kurzzeitig down) darf weder die Prüfung der
      // restigen Trigger-Vaults noch — da runTriggerVaultCycle() ungefangen
      // in runKeeperCycle() durchschlägt — den kompletten Zyklus inkl.
      // autoRefuelCelo() abbrechen. Siehe Chat: "Der plan hat immer noch
      // nicht ausgelöst" — vorher konnte genau das die stille Ursache sein.
      console.error(`Keeper: Prüfung von Trigger-Vault ${vaultAddress} fehlgeschlagen:`, err);
    }
  }

  return executable;
}

// ─── CELO Auto-Refuel ─────────────────────────────────────────────────────────
//
// Die Keeper-Wallet ist gleichzeitig die Treasury (siehe DcaVaultFactory.
// feeInfo() — treasury == globalKeeper) und sammelt dadurch laufend Gebühren
// an. Statt die manuell in CELO umzutauschen, tauscht der Keeper nach jedem
// Zyklus automatisch einen Teil davon in CELO, um sich selbst mit Gas zu
// versorgen. Jedes Token wird bewusst GETRENNT geprüft (eigene Schwelle,
// eigener Swap) statt addiert — jeder Swap ist ohnehin ein eigener Squid-
// Request pro Token, eine gemeinsame Prüfung würde nur Sonderlogik fürs
// Kombinieren mehrerer ERC-20-Salden hinzufügen, ohne echten Vorteil.
//
// DCA-Gebühren fallen immer in USDC/USDT an — Trigger-Gebühren dagegen im
// jeweiligen heldToken, das bei einem Sell-Trigger auch ein Zieltoken sein
// kann (siehe TriggerVault.sol) — deshalb deckt die Liste alle fünf
// Nicht-CELO-Token ab, die OSIRIS kennt (CELO selbst ausgenommen, da bereits
// das Refuel-Ziel).

const REFUEL_CANDIDATE_TOKENS: { symbol: string; address: `0x${string}` }[] = [
  { symbol: "USDC",  address: INPUT_TOKENS.USDC.address },
  { symbol: "USDT",  address: INPUT_TOKENS.USDT.address },
  { symbol: "wBTC",  address: TARGET_TOKENS.wBTC.address },
  { symbol: "wETH",  address: TARGET_TOKENS.wETH.address },
  { symbol: "XAUoT", address: TARGET_TOKENS.XAUoT.address },
];

async function refuelFromToken(ctx: KeeperContext, token: { symbol: string; address: `0x${string}` }): Promise<void> {
  const balance = await ctx.publicClient.readContract({
    address: token.address, abi: ERC20_ABI, functionName: "balanceOf", args: [ctx.account.address],
  }) as bigint;

  if (balance <= ctx.refuelThreshold) return;

  const swapAmount = (balance * ctx.refuelPercentBps) / 10_000n;
  if (swapAmount === 0n) return;

  console.info(`Keeper: Auto-Refuel ${token.symbol} -> CELO, Betrag ${swapAmount}`);

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

  console.info(`Keeper: Auto-Refuel ${token.symbol} erfolgreich. Tx: ${swapHash}`);
}

async function autoRefuelCelo(ctx: KeeperContext): Promise<void> {
  for (const token of REFUEL_CANDIDATE_TOKENS) {
    try {
      await refuelFromToken(ctx, token);
    } catch (err) {
      // Ein fehlschlagender Refuel darf den nächsten Keeper-Zyklus nicht
      // blockieren — beim nächsten Lauf wird es einfach erneut versucht.
      console.error(`Keeper: Auto-Refuel für ${token.symbol} fehlgeschlagen:`, err);
    }
  }
}

// Noch nicht deployt (siehe script/DeployTriggerVaultFactory.s.sol) — solange
// TRIGGER_VAULT_FACTORY_ADDRESS in src/config.ts der Platzhalter ist,
// überspringt der Zyklus den Trigger-Teil komplett statt gegen die
// Nulladresse zu lesen.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── Trigger-Pläne: Ausführungs-Zyklus ─────────────────────────────────────────
//
// Sequenziell statt parallel — gleiche Begründung wie bei den DCA-Vaults oben
// (Squid-Rate-Limit + Nonce-Verwaltung der Keeper-Wallet).

async function runTriggerVaultCycle(ctx: KeeperContext): Promise<KeeperCycleResult[]> {
  if (TRIGGER_VAULT_FACTORY_ADDRESS === ZERO_ADDRESS) {
    console.info("Keeper: TRIGGER_VAULT_FACTORY_ADDRESS noch nicht deployt — überspringe Trigger-Pläne.");
    return [];
  }

  const allVaults = await ctx.publicClient.readContract({
    address: TRIGGER_VAULT_FACTORY_ADDRESS, abi: TRIGGER_VAULT_FACTORY_ABI, functionName: "getAllVaults",
  }) as `0x${string}`[];
  console.info(`Keeper: ${allVaults.length} Trigger-Vault(s) insgesamt.`);

  const executableVaults = await findExecutableTriggerVaults(ctx, allVaults);
  const results: KeeperCycleResult[] = [];

  if (executableVaults.length === 0) {
    console.info("Keeper: Kein Trigger-Vault aktuell ausführbar (Preisbedingung nicht erfüllt oder canExecute = false).");
    return results;
  }

  for (const vault of executableVaults) {
    try {
      const receipt = await executeTriggerVaultStep(ctx, vault);
      results.push({ vaultAddress: vault.address, receipt, kind: "trigger" });
    } catch (err) {
      // Ein fehlschlagender Vault (z.B. SlippageExceeded für einen einzelnen
      // Nutzer) darf die Ausführung für alle anderen Vaults nicht blockieren.
      console.error(`Keeper: Fehler bei Trigger-Vault ${vault.address}:`, err);
    }
  }

  return results;
}

// ─── Send-Pläne: fällige Vaults finden ─────────────────────────────────────────
//
// Anders als bei Trigger-Plänen gibt es hier keine Preisbedingung zu prüfen —
// canExecute() (initialized/!cancelled/currentStep<totalSteps/Zeit erreicht)
// ist bereits die vollständige Antwort. Trotzdem pro Vault einzeln mit
// try/catch statt als Batch-Promise.all wie bei findExecutableVaults(): ein
// einzelner fehlschlagender RPC-Read darf die Prüfung der übrigen Send-Vaults
// nicht abbrechen — gleiches Isolationsmuster wie findExecutableTriggerVaults()
// (siehe dortigen Kommentar zum ursprünglichen stillen Trigger-Bug).

async function findExecutableSendVaults(
  ctx: KeeperContext, vaultAddresses: `0x${string}`[],
): Promise<`0x${string}`[]> {
  const executable: `0x${string}`[] = [];

  for (const vaultAddress of vaultAddresses) {
    try {
      const canExecute = await ctx.publicClient.readContract({
        address: vaultAddress, abi: SEND_VAULT_ABI, functionName: "canExecute",
      }) as boolean;
      if (!canExecute) continue;

      const authorized = await ctx.publicClient.readContract({
        address: vaultAddress, abi: SEND_VAULT_ABI, functionName: "isKeeper", args: [ctx.account.address],
      }) as boolean;
      if (!authorized) {
        console.info(`Keeper: Send-Vault ${vaultAddress} übersprungen (Keeper-Wallet ${ctx.account.address} nicht autorisiert).`);
        continue;
      }

      executable.push(vaultAddress);
    } catch (err) {
      console.error(`Keeper: Prüfung von Send-Vault ${vaultAddress} fehlgeschlagen:`, err);
    }
  }

  return executable;
}

// ─── Send-Pläne: einen Vault ausführen ─────────────────────────────────────────
//
// Kein Squid-Aufruf, kein Router, keine Calldata — executeStep() nimmt keine
// Parameter entgegen (siehe SendVault.sol). Simulieren vor dem Broadcast
// bleibt trotzdem sinnvoll (deckt z.B. eine seit dem letzten canExecute()-Read
// stornierte Plan auf, ohne echtes Gas zu verbrennen).

async function executeSendVaultStep(ctx: KeeperContext, vaultAddress: `0x${string}`) {
  const { request } = await ctx.publicClient.simulateContract({
    account:      ctx.account,
    address:      vaultAddress,
    abi:          SEND_VAULT_ABI,
    functionName: "executeStep",
    args:         [],
  });

  const hash = await ctx.walletClient.writeContract(request);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });

  const newStep = await ctx.publicClient.readContract({
    address: vaultAddress, abi: SEND_VAULT_ABI, functionName: "currentStep",
  });

  console.info(`Keeper: Send-Vault ${vaultAddress} — Schritt ${newStep} ausgeführt. Tx: ${hash}`);
  return receipt;
}

// ─── Send-Pläne: Ausführungs-Zyklus ─────────────────────────────────────────────
//
// Sequenziell statt parallel — gleiche Begründung wie bei DCA/Trigger oben
// (Nonce-Verwaltung der Keeper-Wallet; Squid-Rate-Limit spielt hier mangels
// Squid-Aufrufen keine Rolle, aber die Nonce-Reihenfolge schon).

async function runSendVaultCycle(ctx: KeeperContext): Promise<KeeperCycleResult[]> {
  if (SEND_VAULT_FACTORY_ADDRESS === ZERO_ADDRESS) {
    console.info("Keeper: SEND_VAULT_FACTORY_ADDRESS noch nicht deployt — überspringe Send-Pläne.");
    return [];
  }

  const allVaults = await ctx.publicClient.readContract({
    address: SEND_VAULT_FACTORY_ADDRESS, abi: SEND_VAULT_FACTORY_ABI, functionName: "getAllVaults",
  }) as `0x${string}`[];
  console.info(`Keeper: ${allVaults.length} Send-Vault(s) insgesamt.`);

  const executableVaults = await findExecutableSendVaults(ctx, allVaults);
  const results: KeeperCycleResult[] = [];

  if (executableVaults.length === 0) {
    console.info("Keeper: Kein Send-Vault aktuell ausführbar (canExecute = false).");
    return results;
  }

  for (const vaultAddress of executableVaults) {
    try {
      const receipt = await executeSendVaultStep(ctx, vaultAddress);
      results.push({ vaultAddress, receipt, kind: "send" });
    } catch (err) {
      // Ein fehlschlagender Vault darf die Ausführung für alle anderen
      // Send-Vaults nicht blockieren — gleiches Muster wie DCA/Trigger oben.
      console.error(`Keeper: Fehler bei Send-Vault ${vaultAddress}:`, err);
    }
  }

  return results;
}

// ─── Haupt-Keeper-Funktion ────────────────────────────────────────────────────

export interface KeeperCycleResult {
  vaultAddress: `0x${string}`;
  receipt:      Awaited<ReturnType<typeof executeVaultStep>>;
  kind?:        "dca" | "trigger" | "send"; // fehlt (= "dca") bei bereits vorhandenen Aufrufern
}

export async function runKeeperCycle(env: Env): Promise<KeeperCycleResult[]> {
  const ctx = createKeeperContext(env);

  const vaultAddresses = await getAllVaultAddresses(ctx);
  console.info(`Keeper: ${vaultAddresses.length} Vault(s) insgesamt (Factories: ${ctx.factoryAddresses.join(", ")}).`);

  const executableVaults = await findExecutableVaults(ctx, vaultAddresses);
  const results: KeeperCycleResult[] = [];

  if (executableVaults.length === 0) {
    console.info("Keeper: Kein Vault aktuell ausführbar (canExecute = false).");
  } else {
    console.info(`Keeper: ${executableVaults.length} Vault(s) ausführbar: ${executableVaults.join(", ")}`);

    // Sequenziell statt parallel: sowohl die Squid-Rate-Limits als auch die
    // Nonce-Verwaltung des Keeper-Wallets vertragen keine parallelen Broadcasts.
    for (const vaultAddress of executableVaults) {
      try {
        const receipt = await executeVaultStep(ctx, vaultAddress);
        results.push({ vaultAddress, receipt, kind: "dca" });
      } catch (err) {
        // Ein fehlschlagender Vault (z.B. SlippageExceeded für einen einzelnen
        // Nutzer) darf die Ausführung für alle anderen Vaults nicht blockieren.
        console.error(`Keeper: Fehler bei Vault ${vaultAddress}:`, err);
      }
    }
  }

  try {
    results.push(...await runTriggerVaultCycle(ctx));
  } catch (err) {
    // Ein Fehler beim Auflisten der Trigger-Vaults (z.B. RPC-Read auf die
    // Factory schlägt fehl) darf autoRefuelCelo() unten nicht verhindern.
    console.error("Keeper: Trigger-Vault-Zyklus fehlgeschlagen:", err);
  }

  try {
    results.push(...await runSendVaultCycle(ctx));
  } catch (err) {
    // Gleiche Isolation wie beim Trigger-Zyklus oben — ein Fehler beim
    // Auflisten der Send-Vaults darf autoRefuelCelo() nicht verhindern.
    console.error("Keeper: Send-Vault-Zyklus fehlgeschlagen:", err);
  }

  await autoRefuelCelo(ctx);

  return results;
}
