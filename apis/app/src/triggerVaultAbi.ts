// ABI-Ausschnitte für TriggerVault + TriggerVaultFactory — nur was das
// Frontend selbst aufruft (createVault(), setupPlan(), das VaultCreated-
// Event zum Auslesen der neuen Vault-Adresse). Eigene, unabhängige Kopie
// statt eines Imports aus apis/keeper — dieses Package hat bewusst kein
// package-übergreifendes Sharing (siehe Gesamtplan §22).

export const TRIGGER_VAULT_FACTORY_ABI = [
  {
    type: "function", name: "createVault",
    stateMutability: "nonpayable", inputs: [],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "event", name: "VaultCreated",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "vault", type: "address", indexed: true },
    ],
  },
] as const;

export const TRIGGER_VAULT_ABI = [
  {
    type: "function", name: "setupPlan",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_heldToken",    type: "address" },
      { name: "_outputToken",  type: "address" },
      { name: "_watchToken",   type: "address" },
      { name: "_amount",       type: "uint256" },
      { name: "_triggerAbove", type: "bool"    },
      { name: "_triggerPrice", type: "uint256" },
      { name: "_expiresAt",    type: "uint256" },
    ],
    outputs: [],
  },
] as const;
