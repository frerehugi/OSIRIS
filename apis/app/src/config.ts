// Re-Export der OSIRIS-Token-/Chain-Konfiguration + Contract-Adressen — eine
// einzige Quelle der Wahrheit statt einer zweiten, potenziell abweichenden
// Kopie (siehe Gesamtplan §22). Keine APIS-eigenen Werte mehr seit dem
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
  SEND_VAULT_FACTORY_ADDRESS,
  type TokenInfo,
} from '../../../src/config';

export { ERC20_ABI, DCA_VAULT_ABI, DCA_VAULT_FACTORY_ABI } from '../../../src/dcaVaultAbi';

// Einzige Stelle, an der die APIS-App selbst (nicht die KI) den Backend-
// Worker aufruft — bisher rein für die KI/REST-Schicht gedacht (siehe
// apis/backend/src/openapi.ts, SERVER_URL dort), jetzt zusätzlich für den
// Adressbuch-Screen (siehe screens/AddressBook.tsx), weil das Adressbuch als
// einziger APIS-Datensatz server-seitig (Cloudflare KV) statt on-chain lebt.
export const APIS_BACKEND_URL = 'https://apis-backend.frerehugi.workers.dev';
