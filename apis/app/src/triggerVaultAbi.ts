// Re-Export von OSIRIS' TriggerVault/TriggerVaultFactory-ABI — eine einzige
// Quelle der Wahrheit statt einer zweiten, potenziell abweichenden Kopie
// (gleiches Prinzip wie config.ts für Token-/Chain-Konfiguration und
// dcaVaultAbi.ts für die DCA-ABIs). Vorher eine unabhängige, auf den
// Frontend-Bedarf gekürzte Kopie — der Grund dafür (kein Import aus dem
// separaten apis/keeper-Package) ist mit dessen Entfernung entfallen, seit
// OSIRIS' eigener Keeper (keeper/squidKeeper.ts) alle Trigger-Vaults
// ausführt, unabhängig davon, welche UI sie erstellt hat.

export { TRIGGER_VAULT_ABI, TRIGGER_VAULT_FACTORY_ABI } from '../../../src/triggerVaultAbi';
