// Keeper-Service (Node.js, läuft als Cron-Job / scheduled Task).
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

import { createWalletClient, createPublicClient, http, defineChain, parseUnits } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import { fileURLToPath } from "url";
import { DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI, ERC20_ABI } from "../src/dcaVaultAbi";
import { VAULT_ADDRESS, ACTIVE_CHAIN_ID, CELO_CHAIN_ID, INPUT_TOKENS, TARGET_TOKENS } from "../src/config";

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

// ─── Squid-Integrator-ID ──────────────────────────────────────────────────────
//
// Kommt bewusst aus keeper/.env (nicht aus src/config.ts) — der Keeper ist ein
// eigenständiger Prozess mit eigenen Secrets. Solange die echte ID bei Squid
// noch nicht beantragt/vergeben ist, steht hier der Platzhalter "PENDING";
// der Keeper verweigert in dem Fall den Start mit einer klaren Fehlermeldung,
// statt Requests zu senden, die Squid im Zweifel ablehnt oder ratelimited.

function getValidatedIntegratorId(): string {
  const id = process.env.SQUID_INTEGRATOR_ID;
  if (!id) {
    throw new Error("SQUID_INTEGRATOR_ID Umgebungsvariable fehlt (keeper/.env).");
  }
  if (id === "PENDING") {
    throw new Error(
      "SQUID_INTEGRATOR_ID ist noch der Platzhalter 'PENDING'. " +
      "Echte Integrator-ID bei Squid (https://app.squidrouter.com/) beantragen " +
      "und in keeper/.env eintragen, bevor der Keeper live läuft."
    );
  }
  return id;
}

// ─── Factory-Adressen ─────────────────────────────────────────────────────────
//
// Ebenfalls aus keeper/.env statt src/config.ts — gleicher Grund wie bei der
// Integrator-ID (eigenständiger Prozess, eigene Konfiguration).
//
// Komma-getrennte Liste statt einer einzelnen Adresse: sobald ein neuer
// Factory-Deploy stattfindet (z.B. für einen Contract-Upgrade wie den
// Gebühren-Mechanismus), erstellen neue Nutzer ihre Vaults über die neue
// Factory — bestehende Nutzer-Vaults laufen aber weiter über die ALTE
// Factory. Würde FACTORY_ADDRESSES beim Upgrade einfach ersetzt statt
// ergänzt, würde der Keeper die alten Vaults nicht mehr finden und sie
// stillschweigend nicht mehr ausführen. Deshalb bleiben alte Factory-
// Adressen hier stehen, bis die letzten darüber erstellten Vaults
// ausgelaufen sind. FACTORY_ADDRESS (Singular) wird als Fallback weiter
// unterstützt, um bestehende .env-Dateien nicht zu brechen.

function getValidatedFactoryAddresses(): `0x${string}`[] {
  const raw = process.env.FACTORY_ADDRESSES ?? process.env.FACTORY_ADDRESS;
  if (!raw) {
    throw new Error("FACTORY_ADDRESSES (oder FACTORY_ADDRESS) Umgebungsvariable fehlt (keeper/.env).");
  }
  return raw.split(",").map((address) => address.trim() as `0x${string}`);
}

// ─── Wallet-Setup ─────────────────────────────────────────────────────────────

const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY as `0x${string}`;
if (!KEEPER_PRIVATE_KEY) {
  throw new Error("KEEPER_PRIVATE_KEY Umgebungsvariable fehlt.");
}

// 1 % zusätzlicher Puffer auf Squids eigene Slippage-Berechnung,
// um kurzfristige Marktbewegungen zwischen Quote und On-Chain-Ausführung
// abzufedern, ohne die Slippage-Kontrolle auszuhebeln.
const SLIPPAGE_BPS_BUFFER = 300;

const account = privateKeyToAccount(KEEPER_PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: activeChain, transport: http() });
const publicClient = createPublicClient({ chain: activeChain, transport: http() });

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

async function getSquidRoute(params: {
  fromToken:   `0x${string}`;
  toToken:     `0x${string}`;
  fromAmount:  string;
  fromAddress: `0x${string}`;
  toAddress:   `0x${string}`;
}): Promise<SquidRoute> {
  const integratorId = getValidatedIntegratorId();

  for (let attempt = 1; attempt <= SQUID_MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        "https://apiplus.squidrouter.com/v2/route",
        {
          fromChain:   ACTIVE_CHAIN_ID,
          toChain:     ACTIVE_CHAIN_ID, // Same-Chain-Swap innerhalb Celo
          fromToken:   params.fromToken,
          toToken:     params.toToken,
          fromAmount:  params.fromAmount,
          fromAddress: params.fromAddress, // = Vault: er ist msg.sender beim Router-Call
          toAddress:   params.toAddress,   // = Owner: dorthin soll der Output fließen
          slippage:      5,                // % — Contract erzwingt minAmountOut zusätzlich on-chain
          quoteOnly:   false,              // echte, ausführbare Route inkl. Calldata
        },
        {
          headers: {
            "x-integrator-id": integratorId,
            "Content-Type":    "application/json",
          },
        }
      );
      return response.data.route as SquidRoute;
    } catch (err) {
      const isRateLimit = axios.isAxiosError(err) && err.response?.status === 429;
      if (!isRateLimit || attempt === SQUID_MAX_RETRIES) throw err;

      const backoffMs = SQUID_REQUEST_SPACING_MS * attempt; // 4s, 8s, 12s, 16s
      console.warn(
        `Squid: Rate-Limit (429) für ${params.toToken} — warte ${backoffMs}ms ` +
        `(Versuch ${attempt}/${SQUID_MAX_RETRIES})`
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("Squid-Route: unerreichbar nach maximalen Versuchen.");
}

// ─── Sicherheitspuffer auf toAmountMin anwenden ───────────────────────────────

function applyBuffer(toAmountMin: string): bigint {
  const raw = BigInt(toAmountMin);
  return (raw * BigInt(10_000 - SLIPPAGE_BPS_BUFFER)) / 10_000n;
}

// ─── Vaults einsammeln ────────────────────────────────────────────────────────
//
// VAULT_ADDRESS (aus src/config.ts) wurde vor der Factory direkt deployt und
// taucht in factory.getAllVaults() nicht auf — er läuft aber weiter, bis alle
// 5 Tranchen ausgeführt sind, und wird deshalb explizit mit aufgenommen.

async function getAllVaultAddresses(factoryAddresses: `0x${string}`[]): Promise<`0x${string}`[]> {
  const perFactoryVaults = await Promise.all(
    factoryAddresses.map((factoryAddress) =>
      publicClient.readContract({
        address: factoryAddress,
        abi:     DCA_VAULT_FACTORY_ABI,
        functionName: "getAllVaults",
      }) as Promise<`0x${string}`[]>
    )
  );

  return [...new Set([VAULT_ADDRESS, ...perFactoryVaults.flat()])];
}

// ─── canExecute() in Batches prüfen ───────────────────────────────────────────

async function findExecutableVaults(vaultAddresses: `0x${string}`[]): Promise<`0x${string}`[]> {
  const executable: `0x${string}`[] = [];

  for (let i = 0; i < vaultAddresses.length; i += BATCH_SIZE) {
    const batch = vaultAddresses.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((vault) =>
        publicClient.readContract({ address: vault, abi: DCA_VAULT_ABI, functionName: "canExecute" })
      )
    );
    batch.forEach((vault, idx) => {
      if (results[idx]) executable.push(vault);
    });
  }

  return executable;
}

// ─── Einen Vault ausführen ────────────────────────────────────────────────────

async function executeVaultStep(vaultAddress: `0x${string}`) {
  const [trancheAmount, targetConfigs, inputTokenAddress, ownerAddress] = await Promise.all([
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "trancheAmount" }),
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "getTargetConfigs" }),
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "inputToken" }),
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "owner" }),
  ]);

  const routers:       `0x${string}`[] = [];
  const minAmountsOut: bigint[]        = [];
  const callData:      `0x${string}`[] = [];

  const configs = targetConfigs as Array<{ token: `0x${string}`; bps: number }>;
  for (let i = 0; i < configs.length; i++) {
    if (i > 0) await sleep(SQUID_REQUEST_SPACING_MS); // Rate-Limit-Abstand zwischen Zieltoken

    const config = configs[i];
    const amountIn = (trancheAmount as bigint * BigInt(config.bps)) / 10_000n;

    const route = await getSquidRoute({
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
  const { request } = await publicClient.simulateContract({
    account,
    address:      vaultAddress,
    abi:          DCA_VAULT_ABI,
    functionName: "executeStep",
    args:         [routers, minAmountsOut, callData],
  });

  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  const newStep = await publicClient.readContract({
    address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "currentStep",
  });

  console.info(`Keeper: Vault ${vaultAddress} — Schritt ${newStep} ausgeführt. Tx: ${hash}`);
  return receipt;
}

// ─── CELO Auto-Refuel ─────────────────────────────────────────────────────────
//
// Die Keeper-Wallet ist gleichzeitig die Treasury (siehe DcaVaultFactory.
// feeInfo() — treasury == globalKeeper) und sammelt dadurch laufend USDC/USDT-
// Gebühren an. Statt die manuell in CELO umzutauschen, tauscht der Keeper nach
// jedem Zyklus automatisch einen Teil davon in CELO, um sich selbst mit Gas
// zu versorgen. USDC und USDT werden bewusst GETRENNT geprüft (eigene
// Schwelle, eigener Swap) statt addiert — jeder Swap ist ohnehin ein eigener
// Squid-Request pro Token, eine gemeinsame Prüfung würde nur Sonderlogik fürs
// Kombinieren zweier ERC-20-Salden hinzufügen, ohne echten Vorteil.

const REFUEL_THRESHOLD = parseUnits(process.env.KEEPER_REFUEL_THRESHOLD ?? "5", 6); // 5 USD-Äquivalent
const REFUEL_PERCENT_BPS = BigInt(process.env.KEEPER_REFUEL_PCT_BPS ?? "4000");     // 40 %

const REFUEL_STABLE_TOKENS: { symbol: string; address: `0x${string}` }[] = [
  { symbol: "USDC", address: INPUT_TOKENS.USDC.address },
  { symbol: "USDT", address: INPUT_TOKENS.USDT.address },
];

async function refuelFromToken(token: { symbol: string; address: `0x${string}` }): Promise<void> {
  const balance = await publicClient.readContract({
    address: token.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  }) as bigint;

  if (balance <= REFUEL_THRESHOLD) return;

  const swapAmount = (balance * REFUEL_PERCENT_BPS) / 10_000n;
  if (swapAmount === 0n) return;

  console.info(`Keeper: Auto-Refuel ${token.symbol} -> CELO, Betrag ${swapAmount}`);

  const route = await getSquidRoute({
    fromToken:   token.address,
    toToken:     TARGET_TOKENS.CELO.address,
    fromAmount:  swapAmount.toString(),
    fromAddress: account.address,
    toAddress:   account.address,
  });

  const approveHash = await walletClient.writeContract({
    address:      token.address,
    abi:          ERC20_ABI,
    functionName: "approve",
    args:         [route.transactionRequest.target, swapAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const swapHash = await walletClient.sendTransaction({
    account,
    to:   route.transactionRequest.target,
    data: route.transactionRequest.data,
  });
  await publicClient.waitForTransactionReceipt({ hash: swapHash });

  console.info(`Keeper: Auto-Refuel ${token.symbol} erfolgreich. Tx: ${swapHash}`);
}

async function autoRefuelCelo(): Promise<void> {
  for (const token of REFUEL_STABLE_TOKENS) {
    try {
      await refuelFromToken(token);
    } catch (err) {
      // Ein fehlschlagender Refuel darf den nächsten Keeper-Zyklus nicht
      // blockieren — beim nächsten Lauf wird es einfach erneut versucht.
      console.error(`Keeper: Auto-Refuel für ${token.symbol} fehlgeschlagen:`, err);
    }
  }
}

// ─── Haupt-Keeper-Funktion ────────────────────────────────────────────────────

export interface KeeperCycleResult {
  vaultAddress: `0x${string}`;
  receipt:      Awaited<ReturnType<typeof executeVaultStep>>;
}

export async function runKeeperCycle(): Promise<KeeperCycleResult[]> {
  getValidatedIntegratorId(); // wirft früh, bevor irgendein Contract-Call passiert
  const factoryAddresses = getValidatedFactoryAddresses();

  const vaultAddresses = await getAllVaultAddresses(factoryAddresses);
  console.info(`Keeper: ${vaultAddresses.length} Vault(s) insgesamt (Factories: ${factoryAddresses.join(", ")}).`);

  const executableVaults = await findExecutableVaults(vaultAddresses);
  const results: KeeperCycleResult[] = [];

  if (executableVaults.length === 0) {
    console.info("Keeper: Kein Vault aktuell ausführbar (canExecute = false).");
  } else {
    console.info(`Keeper: ${executableVaults.length} Vault(s) ausführbar: ${executableVaults.join(", ")}`);

    // Sequenziell statt parallel: sowohl die Squid-Rate-Limits als auch die
    // Nonce-Verwaltung des Keeper-Wallets vertragen keine parallelen Broadcasts.
    for (const vaultAddress of executableVaults) {
      try {
        const receipt = await executeVaultStep(vaultAddress);
        results.push({ vaultAddress, receipt });
      } catch (err) {
        // Ein fehlschlagender Vault (z.B. SlippageExceeded für einen einzelnen
        // Nutzer) darf die Ausführung für alle anderen Vaults nicht blockieren.
        console.error(`Keeper: Fehler bei Vault ${vaultAddress}:`, err);
      }
    }
  }

  await autoRefuelCelo();

  return results;
}

// ─── Entry Point (z.B. per Cron aufgerufen) ───────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runKeeperCycle()
    .then((results) => {
      if (results.length === 0) {
        console.info("Done: nichts ausgeführt.");
      } else {
        for (const { vaultAddress, receipt } of results) {
          console.info(`Done: ${vaultAddress} -> ${receipt.transactionHash}`);
        }
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Keeper-Fehler:", err);
      process.exit(1);
    });
}
