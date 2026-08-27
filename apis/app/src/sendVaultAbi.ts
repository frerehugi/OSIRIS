// Re-Export von OSIRIS' SendVault/SendVaultFactory-ABI — eine einzige Quelle
// der Wahrheit statt einer zweiten, potenziell abweichenden Kopie (gleiches
// Prinzip wie triggerVaultAbi.ts für TriggerVault). OSIRIS' eigener Keeper
// (keeper/squidKeeper.ts) führt auch Send-Pläne aus, unabhängig davon,
// welche UI sie erstellt hat.

export { SEND_VAULT_ABI, SEND_VAULT_FACTORY_ABI } from '../../../src/sendVaultAbi';
