// Read-only Status-Check für einen DcaVault (Node.js, viem).
//
// Anders als squidKeeper.ts sendet dieses Script keine Transaktionen — es
// liest nur den aktuellen Fortschritt eines Vaults (currentStep,
// remainingInputBalance, ...) sowie die Ziel-Token-Salden des Owners aus,
// um von außen (z.B. per `npm run check-status`) zu prüfen, ob die täglichen/
// wöchentlichen Swaps wie geplant laufen — ohne dafür Celoscan manuell zu
// durchsuchen.

import { createPublicClient, http, formatUnits } from "viem";
import { celo } from "viem/chains";
import { fileURLToPath } from "url";
import { DCA_VAULT_ABI } from "../src/dcaVaultAbi";
import { VAULT_ADDRESS, TARGET_TOKENS, INPUT_TOKENS } from "../src/config";

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function", name: "balanceOf",
    stateMutability: "view",
    inputs:  [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const publicClient = createPublicClient({ chain: celo, transport: http() });

export interface VaultStatus {
  vaultAddress:           `0x${string}`;
  owner:                  `0x${string}`;
  inputToken:              `0x${string}`;
  currentStep:            number;
  totalSteps:             number;
  remainingSteps:         number;
  remainingInputBalance:  bigint;
  canExecute:             boolean;
}

export async function getVaultStatus(vaultAddress: `0x${string}`): Promise<VaultStatus> {
  const [owner, inputToken, currentStep, totalSteps, remainingSteps, remainingInputBalance, canExecute] =
    await Promise.all([
      publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "owner" }),
      publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "inputToken" }),
      publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "currentStep" }),
      publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "totalSteps" }),
      publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "remainingSteps" }),
      publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "remainingInputBalance" }),
      publicClient.readContract({ address: vaultAddress, abi: DCA_VAULT_ABI, functionName: "canExecute" }),
    ]);

  return {
    vaultAddress,
    owner:                 owner as `0x${string}`,
    inputToken:            inputToken as `0x${string}`,
    currentStep:           currentStep as number,
    totalSteps:            totalSteps as number,
    remainingSteps:        remainingSteps as number,
    remainingInputBalance: remainingInputBalance as bigint,
    canExecute:            canExecute as boolean,
  };
}

export async function getTargetTokenBalances(ownerAddress: `0x${string}`) {
  const tokens = Object.values(TARGET_TOKENS);
  const balances = await Promise.all(
    tokens.map((token) =>
      publicClient.readContract({
        address: token.address, abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf", args: [ownerAddress],
      })
    )
  );

  return tokens.map((token, i) => ({
    symbol:  token.symbol,
    address: token.address,
    raw:     balances[i] as bigint,
    formatted: formatUnits(balances[i] as bigint, token.decimals),
  }));
}

function inputTokenDecimals(inputToken: `0x${string}`): number {
  const match = Object.values(INPUT_TOKENS).find(
    (t) => t.address.toLowerCase() === inputToken.toLowerCase()
  );
  return match?.decimals ?? 18;
}

async function main() {
  const vaultAddress = (process.argv[2] as `0x${string}` | undefined) ?? VAULT_ADDRESS;

  const status = await getVaultStatus(vaultAddress);
  const balances = await getTargetTokenBalances(status.owner);

  console.info(`Vault:                    ${status.vaultAddress}`);
  console.info(`Owner:                    ${status.owner}`);
  console.info(`Step:                     ${status.currentStep} / ${status.totalSteps} (${status.remainingSteps} verbleibend)`);
  console.info(`Restguthaben (Input):     ${formatUnits(status.remainingInputBalance, inputTokenDecimals(status.inputToken))}`);
  console.info(`canExecute():             ${status.canExecute}`);
  console.info("Ziel-Token-Salden (Owner):");
  for (const balance of balances) {
    console.info(`  ${balance.symbol.padEnd(6)} ${balance.formatted}  (${balance.address})`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("checkVaultStatus-Fehler:", err);
    process.exit(1);
  });
}
