// get_balances — Lese-Pfad für Token-Guthaben. Ausgelagert aus server.ts,
// damit sowohl der MCP-Tool-Handler als auch die REST-Schicht (rest.ts)
// dieselbe Funktion nutzen, statt die Logik zweimal zu pflegen.

import { formatUnits } from 'viem';
import type { ApisPublicClient } from './client';
import { ERC20_ABI } from '../../../src/dcaVaultAbi';
import { INPUT_TOKENS, TARGET_TOKENS } from '../../../src/config';

const BALANCE_TOKENS = [
  INPUT_TOKENS.USDC,
  INPUT_TOKENS.USDT,
  TARGET_TOKENS.CELO,
  TARGET_TOKENS.XAUoT,
  TARGET_TOKENS.wBTC,
  TARGET_TOKENS.wETH,
] as const;

export async function getBalancesForOwner(publicClient: ApisPublicClient, owner: `0x${string}`) {
  const results = await Promise.all(
    BALANCE_TOKENS.map(async (token) => {
      try {
        const raw = await publicClient.readContract({
          address: token.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner],
        }) as bigint;
        return { symbol: token.symbol, balance: formatUnits(raw, token.decimals) };
      } catch {
        return { symbol: token.symbol, balance: null, error: 'Could not read this balance right now.' };
      }
    }),
  );

  return { owner, balances: results };
}
