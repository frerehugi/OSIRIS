// Re-Export der OSIRIS-Token-/Chain-Konfiguration + Contract-Adressen — eine
// einzige Quelle der Wahrheit statt einer zweiten, potenziell abweichenden
// Kopie (siehe Gesamtplan §22). Keine Apis-eigenen Werte mehr seit dem
// Architektur-Wechsel (OSIRIS besitzt jetzt beide Vault-Typen).

export {
  CELO_CHAIN_ID,
  CELO_SEPOLIA_CHAIN_ID,
  ACTIVE_CHAIN_ID,
  SQUID_ROUTER_MAINNET,
  SQUID_INTEGRATOR_ID,
  INPUT_TOKENS,
  TARGET_TOKENS,
  FACTORY_ADDRESS,
  TRIGGER_VAULT_FACTORY_ADDRESS,
  type TokenInfo,
} from '../../../src/config';

export { ERC20_ABI, DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI } from '../../../src/dcaVaultAbi';
