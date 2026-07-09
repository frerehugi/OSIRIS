// Debug-Script für gescheiterte executeStep()-Aufrufe (z.B. SwapFailed()).
//
// Holt für jeden Zieltoken eines Vaults eine echte Squid-Route, simuliert
// (kein Broadcast!) executeStep(...) mit publicClient.simulateContract und
// gibt Request, Response und Revert-Grund strukturiert aus — gedacht als
// Rohdaten für den Squid-Support, nicht als automatisierte Diagnose.
//
// Läuft rein lesend: braucht keinen KEEPER_PRIVATE_KEY, weil der Vault-Owner
// laut onlyExecutor() immer ausführungsberechtigt ist und simulateContract
// keine Signatur braucht (eth_call, kein Broadcast).

import { createPublicClient, http, BaseError, ContractFunctionRevertedError } from "viem";
import { celo } from "viem/chains";
import { DCA_VAULT_ABI } from "../src/dcaVaultAbi";
import { VAULT_ADDRESS } from "../src/config";
import { getSquidRoute, type SquidRoute } from "./squidClient";

const publicClient = createPublicClient({ chain: celo, transport: http() });

interface TokenAttempt {
  targetToken: `0x${string}`;
  bps:         number;
  amountIn:    bigint;
  routeRequest: {
    fromToken: `0x${string}`;
    toToken:   `0x${string}`;
    fromAmount: string;
    fromAddress: `0x${string}`;
    toAddress:   `0x${string}`;
  };
  route?: SquidRoute;
  routeError?: unknown;
}

async function collectRoutes(vaultAddress: `0x${string}`): Promise<{
  owner: `0x${string}`;
  inputToken: `0x${string}`;
  attempts: TokenAttempt[];
}> {
  const [owner, inputToken, trancheAmount, targetConfigs, currentStep, totalSteps] = await Promise.all([
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "owner" }),
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "inputToken" }),
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "trancheAmount" }),
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "getTargetConfigs" }),
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "currentStep" }),
    publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "totalSteps" }),
  ]);

  const configs = targetConfigs as Array<{ token: `0x${string}`; bps: number }>;
  const step = (currentStep as number) + 1;
  const isLastStep = step === (totalSteps as number);

  const vaultBalance = (await publicClient.readContract({
    address: inputToken as `0x${string}`,
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
    functionName: "balanceOf",
    args: [vaultAddress],
  })) as bigint;

  const amountForThisStep = isLastStep ? vaultBalance : (trancheAmount as bigint);

  const attempts: TokenAttempt[] = [];
  let remaining = amountForThisStep;

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const amountIn = i === configs.length - 1
      ? remaining
      : (amountForThisStep * BigInt(config.bps)) / 10_000n;
    remaining -= amountIn;

    const routeRequest = {
      fromToken:   inputToken as `0x${string}`,
      toToken:     config.token,
      fromAmount:  amountIn.toString(),
      fromAddress: vaultAddress,
      toAddress:   owner as `0x${string}`,
    };

    const attempt: TokenAttempt = { targetToken: config.token, bps: config.bps, amountIn, routeRequest };
    try {
      attempt.route = await getSquidRoute(routeRequest);
    } catch (err) {
      attempt.routeError = err;
    }
    attempts.push(attempt);
  }

  return { owner: owner as `0x${string}`, inputToken: inputToken as `0x${string}`, attempts };
}

async function simulateExecuteStep(vaultAddress: `0x${string}`, owner: `0x${string}`, attempts: TokenAttempt[]) {
  const routers:       `0x${string}`[] = [];
  const minAmountsOut: bigint[]        = [];
  const callData:      `0x${string}`[] = [];

  for (const attempt of attempts) {
    if (!attempt.route) throw new Error(`Keine Route für ${attempt.targetToken} — kann executeStep nicht simulieren.`);
    routers.push(attempt.route.transactionRequest.target);
    callData.push(attempt.route.transactionRequest.data);
    minAmountsOut.push(BigInt(attempt.route.estimate.toAmountMin)); // ungebuffert — reale Squid-Zahl fürs Debugging
  }

  try {
    await publicClient.simulateContract({
      account:      owner,
      address:      vaultAddress,
      abi:          DCA_VAULT_ABI,
      functionName: "executeStep",
      args:         [routers, minAmountsOut, callData],
    });
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err };
  }
}

function describeRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revertError instanceof ContractFunctionRevertedError) {
      return `${revertError.data?.errorName ?? "unbekannter Custom Error"}(${(revertError.data?.args ?? []).join(", ")})`;
    }
    return err.shortMessage ?? err.message;
  }
  return String(err);
}

async function main() {
  const vaultAddress = (process.argv[2] as `0x${string}` | undefined) ?? VAULT_ADDRESS;

  const lines: string[] = [];
  lines.push(`# Squid-Debug-Report — Vault ${vaultAddress}`);
  lines.push(`Chain: Celo Mainnet (42220)`);
  lines.push("");

  const { owner, inputToken, attempts } = await collectRoutes(vaultAddress);
  lines.push(`Owner:      ${owner}`);
  lines.push(`InputToken: ${inputToken}`);
  lines.push("");

  for (const attempt of attempts) {
    lines.push(`## Zieltoken ${attempt.targetToken} (${attempt.bps} bps, amountIn=${attempt.amountIn})`);
    lines.push("### /v2/route Request");
    lines.push("```json");
    lines.push(JSON.stringify(attempt.routeRequest, null, 2));
    lines.push("```");

    if (attempt.routeError) {
      lines.push("### /v2/route Response: FEHLER");
      lines.push("```");
      lines.push(describeRevert(attempt.routeError));
      lines.push("```");
    } else if (attempt.route) {
      lines.push("### /v2/route Response");
      lines.push("```json");
      lines.push(JSON.stringify(attempt.route, null, 2));
      lines.push("```");
    }
    lines.push("");
  }

  const allRoutesOk = attempts.every((a) => a.route);
  if (!allRoutesOk) {
    lines.push("Simulation übersprungen — mindestens eine Squid-Route fehlt (siehe Fehler oben).");
  } else {
    const result = await simulateExecuteStep(vaultAddress, owner, attempts);
    lines.push("## executeStep()-Simulation (kein Broadcast)");
    if (result.ok) {
      lines.push("Erfolgreich simuliert — kein Revert.");
    } else {
      lines.push("### Revert-Grund");
      lines.push("```");
      lines.push(describeRevert(result.error));
      lines.push("```");
      lines.push("");
      lines.push(
        "Hinweis: SwapFailed() kommt aus DcaVault.sol — router.call(squidCallData) hat " +
        "`false` zurückgegeben (der Squid-Router selbst hat revertiert). SlippageExceeded() " +
        "kommt dagegen aus dem Vault-eigenen Post-Trade-Check. Ein anderer Custom Error " +
        "(z.B. RouterNotApproved) liegt vor der eigentlichen Swap-Ausführung."
      );
    }
  }

  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error("debugSwapFailure-Fehler:", err);
  process.exit(1);
});
