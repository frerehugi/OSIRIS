// Keeper-Service (Node.js, läuft als Cron-Job / scheduled Task).
//
// Architektur: Der Vault ruft keinen DEX-Router mehr selbst auf. Stattdessen
// holt DIESER Keeper für jeden Zieltoken eine fertige, ausführbare Route
// (Ziel-Router + Calldata) von der Squid-API (quoteOnly=false) und übergibt
// sie per DcaVault.executeStep(routers[], minAmountsOut[], squidCallData[])
// an den Vault. Der Vault prüft nur noch, dass der Router freigegeben ist
// (approvedRouters) und dass `owner` danach mindestens minAmountsOut[i] mehr
// vom Zieltoken hat als vorher.

import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import { fileURLToPath } from "url";
import { DCA_VAULT_ABI } from "../src/dcaVaultAbi";
import { VAULT_ADDRESS, ACTIVE_CHAIN_ID, CELO_CHAIN_ID } from "../src/config";

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

// ─── Wallet-Setup ─────────────────────────────────────────────────────────────

const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY as `0x${string}`;
if (!KEEPER_PRIVATE_KEY) {
  throw new Error("KEEPER_PRIVATE_KEY Umgebungsvariable fehlt.");
}

// 1 % zusätzlicher Puffer auf Squids eigene Slippage-Berechnung,
// um kurzfristige Marktbewegungen zwischen Quote und On-Chain-Ausführung
// abzufedern, ohne die Slippage-Kontrolle auszuhebeln.
const SLIPPAGE_BPS_BUFFER = 100;

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

async function getSquidRoute(params: {
  fromToken:   `0x${string}`;
  toToken:     `0x${string}`;
  fromAmount:  string;
  fromAddress: `0x${string}`;
  toAddress:   `0x${string}`;
}): Promise<SquidRoute> {
  const integratorId = getValidatedIntegratorId();

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
      slippage:    1.5,                // % — Contract erzwingt minAmountOut zusätzlich on-chain
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
}

// ─── Sicherheitspuffer auf toAmountMin anwenden ───────────────────────────────

function applyBuffer(toAmountMin: string): bigint {
  const raw = BigInt(toAmountMin);
  return (raw * BigInt(10_000 - SLIPPAGE_BPS_BUFFER)) / 10_000n;
}

// ─── Plan-Status aus Contract lesen ──────────────────────────────────────────

async function readContractStatus() {
  const [
    canExec,
    currentStep,
    totalSteps,
    trancheAmount,
    targetConfigs,
    inputTokenAddress,
    ownerAddress,
  ] = await Promise.all([
    publicClient.readContract({ address: VAULT_ADDRESS, abi: DCA_VAULT_ABI, functionName: "canExecute" }),
    publicClient.readContract({ address: VAULT_ADDRESS, abi: DCA_VAULT_ABI, functionName: "currentStep" }),
    publicClient.readContract({ address: VAULT_ADDRESS, abi: DCA_VAULT_ABI, functionName: "totalSteps" }),
    publicClient.readContract({ address: VAULT_ADDRESS, abi: DCA_VAULT_ABI, functionName: "trancheAmount" }),
    publicClient.readContract({ address: VAULT_ADDRESS, abi: DCA_VAULT_ABI, functionName: "getTargetConfigs" }),
    publicClient.readContract({ address: VAULT_ADDRESS, abi: DCA_VAULT_ABI, functionName: "inputToken" }),
    publicClient.readContract({ address: VAULT_ADDRESS, abi: DCA_VAULT_ABI, functionName: "owner" }),
  ]);

  return {
    canExec, currentStep, totalSteps, trancheAmount, targetConfigs,
    inputTokenAddress: inputTokenAddress as `0x${string}`,
    ownerAddress:       ownerAddress as `0x${string}`,
  };
}

// ─── Haupt-Keeper-Funktion ────────────────────────────────────────────────────

export async function runDcaStep() {
  getValidatedIntegratorId(); // wirft früh, bevor irgendein Contract-Call passiert

  const { canExec, trancheAmount, targetConfigs, inputTokenAddress, ownerAddress } =
    await readContractStatus();

  if (!canExec) {
    console.info("Keeper: Noch nicht ausführbar (canExecute = false).");
    return null;
  }

  // Für jeden Zieltoken: anteiligen Betrag berechnen, echte Squid-Route holen
  // (Router-Adresse + fertige Calldata + Preisschätzung für die Slippage-Grenze).
  const routers:       `0x${string}`[] = [];
  const minAmountsOut: bigint[]        = [];
  const callData:      `0x${string}`[] = [];

  for (const config of targetConfigs as Array<{ token: `0x${string}`; bps: number }>) {
    const amountIn = (trancheAmount as bigint * BigInt(config.bps)) / 10_000n;

    const route = await getSquidRoute({
      fromToken:   inputTokenAddress,
      toToken:     config.token,
      fromAmount:  amountIn.toString(),
      fromAddress: VAULT_ADDRESS,
      toAddress:   ownerAddress,
    });

    routers.push(route.transactionRequest.target);
    callData.push(route.transactionRequest.data);
    minAmountsOut.push(applyBuffer(route.estimate.toAmountMin));
  }

  // Vor dem Broadcast simulieren — deckt z.B. RouterNotApproved oder
  // SlippageExceeded auf, ohne echtes Gas zu verbrennen.
  const { request } = await publicClient.simulateContract({
    account,
    address:      VAULT_ADDRESS,
    abi:          DCA_VAULT_ABI,
    functionName: "executeStep",
    args:         [routers, minAmountsOut, callData],
  });

  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.info(`Keeper: Step ausgeführt. Tx: ${hash}`);
  return receipt;
}

// ─── Entry Point (z.B. per Cron aufgerufen) ───────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDcaStep()
    .then((receipt) => {
      if (receipt) console.info("Done:", receipt.transactionHash);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Keeper-Fehler:", err);
      process.exit(1);
    });
}
