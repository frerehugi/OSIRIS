// Keeper-Service (Node.js, läuft als Cron-Job / scheduled Task).
// Holt für jeden Zieltoken eine Squid-Route und ruft anschließend
// DcaVault.executeStep(minAmountsOut[]) auf.
//
// KORREKTUR: executeStep hat nur einen Parameter — uint256[] minAmountsOut.
// Der Router ist immutable im Contract gespeichert; Squid wird nur für die
// minAmountOut-Berechnung (Preisschätzung) genutzt, nicht als Calldata-Quelle.
//
// Sicherheitsmodell: Der Vault validiert die empfangene Menge per Balance-Diff
// gegen minAmountsOut. Manipulierte Calldata führt zum Revert, nicht zu Verlust.

import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";
import { DCA_VAULT_ABI } from "../src/dcaVaultAbi";
import {
  VAULT_ADDRESS,
  SQUID_INTEGRATOR_ID,
  ACTIVE_CHAIN_ID,
  TARGET_TOKENS,
  INPUT_TOKENS,
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
const walletClient = createWalletClient({ account, chain: celoSepolia, transport: http() });
const publicClient = createPublicClient({ chain: celoSepolia, transport: http() });

// ─── Squid-Route holen ────────────────────────────────────────────────────────

interface SquidEstimate {
  toAmountMin: string;
}

interface SquidRoute {
  estimate: SquidEstimate;
}

async function getSquidMinAmountOut(params: {
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  fromAmount: string;
  fromAddress: `0x${string}`;
}): Promise<string> {
  const response = await axios.post(
    "https://apiplus.squidrouter.com/v2/route",
    {
      fromChain:   ACTIVE_CHAIN_ID,
      toChain:     ACTIVE_CHAIN_ID, // Same-Chain-Swap innerhalb Celo
      fromToken:   params.fromToken,
      toToken:     params.toToken,
      fromAmount:  params.fromAmount,
      fromAddress: params.fromAddress,
      toAddress:   VAULT_ADDRESS,
      slippage:    1.5,           // % — Contract erzwingt minAmountOut on-chain zusätzlich
      quoteOnly:   true,          // Nur Preisschätzung, keine Calldata
    },
    {
      headers: {
        "x-integrator-id": SQUID_INTEGRATOR_ID,
        "Content-Type":    "application/json",
      },
    }
  );
  const route = response.data.route as SquidRoute;
  return route.estimate.toAmountMin;
}

// ─── Sicherheitspuffer auf toAmountMin anwenden ───────────────────────────────

function applyBuffer(toAmountMin: string): bigint {
  const raw = BigInt(toAmountMin);
  return (raw * BigInt(10_000 - SLIPPAGE_BPS_BUFFER)) / 10_000n;
}

// ─── Plan-Status aus Contract lesen ──────────────────────────────────────────
// KORREKTUR: getPlanStatus existiert nicht im Contract. Wir lesen die einzelnen
// public Getter parallel aus.

async function readContractStatus() {
  const [
    canExec,
    currentStep,
    totalSteps,
    trancheAmount,
    targetConfigs,
  ] = await Promise.all([
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi:     DCA_VAULT_ABI,
      functionName: "canExecute",
    }),
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi:     DCA_VAULT_ABI,
      functionName: "currentStep",
    }),
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi:     DCA_VAULT_ABI,
      functionName: "totalSteps",
    }),
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi:     DCA_VAULT_ABI,
      functionName: "trancheAmount",
    }),
    publicClient.readContract({
      address: VAULT_ADDRESS,
      abi:     DCA_VAULT_ABI,
      functionName: "getTargetConfigs",
    }),
  ]);

  return { canExec, currentStep, totalSteps, trancheAmount, targetConfigs };
}

// ─── Haupt-Keeper-Funktion ────────────────────────────────────────────────────

export async function runDcaStep() {
  const { canExec, trancheAmount, targetConfigs } = await readContractStatus();

  if (!canExec) {
    console.info("Keeper: Noch nicht ausführbar (canExecute = false).");
    return null;
  }

  // targetConfigs ist ein Array von { token, bps, poolFee } Tuples.
  // Wir berechnen für jeden Zieltoken den anteiligen Betrag und holen
  // von Squid die Mindestmenge aus, die der Router liefern muss.
  const minAmountsOut: bigint[] = [];

  // Input-Token-Adresse aus dem Contract lesen (für Squid-Route benötigt)
  const inputTokenAddress = await publicClient.readContract({
    address: VAULT_ADDRESS,
    abi:     DCA_VAULT_ABI,
    functionName: "inputToken",
  }) as `0x${string}`;

  for (const config of targetConfigs as Array<{ token: `0x${string}`; bps: number; poolFee: number }>) {
    // Anteiliger Betrag für diesen Token
    const amountIn = (trancheAmount as bigint * BigInt(config.bps)) / 10_000n;

    const toAmountMin = await getSquidMinAmountOut({
      fromToken:   inputTokenAddress,
      toToken:     config.token,
      fromAmount:  amountIn.toString(),
      fromAddress: VAULT_ADDRESS,
    });

    minAmountsOut.push(applyBuffer(toAmountMin));
  }

  // KORREKTUR: executeStep erwartet nur uint256[] minAmountsOut
  const { request } = await publicClient.simulateContract({
    account,
    address:      VAULT_ADDRESS,
    abi:          DCA_VAULT_ABI,
    functionName: "executeStep",
    args:         [minAmountsOut],
  });

  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.info(`Keeper: Step ausgeführt. Tx: ${hash}`);
  return receipt;
}

// ─── Entry Point (z.B. per Cron aufgerufen) ───────────────────────────────────

if (require.main === module) {
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
