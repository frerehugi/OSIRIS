// Re-Export der OSIRIS-Token-/Chain-Konfiguration — eine einzige Quelle der
// Wahrheit statt einer zweiten, potenziell abweichenden Kopie (siehe
// Gesamtplan §22). Diese Datei fügt nur Apis-eigene Werte hinzu, die es in
// src/config.ts nicht gibt.

export {
  CELO_CHAIN_ID,
  CELO_SEPOLIA_CHAIN_ID,
  ACTIVE_CHAIN_ID,
  SQUID_ROUTER_MAINNET,
  SQUID_INTEGRATOR_ID,
  INPUT_TOKENS,
  TARGET_TOKENS,
  type TokenInfo,
} from '../../../src/config';

export { ERC20_ABI } from '../../../src/dcaVaultAbi';

// ConditionalSellOrder-Adresse — noch kein Mainnet-Deploy (siehe
// script/DeploySellOrder.s.sol), Platzhalter bis dahin.
export const CONDITIONAL_SELL_ORDER_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;

// Apis-Keeper-Wallet — für Anzeige-/Freigabezwecke in der UI (z.B. "Create
// New Code for Agent"-Flow), keine Secrets. Siehe Gesamtplan §20.
export const APIS_KEEPER_ADDRESS = '0x1486f1859f0b2b16b525096205cCaE74a681b78c' as `0x${string}`;
