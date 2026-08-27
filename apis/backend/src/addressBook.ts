// Server-seitiger Adressbuch-Speicher (Cloudflare KV) — Gegenstück zu
// Sterntalers/OSIRIS' bisheriger Konvention (localStorage im Browser der App).
// localStorage ist für diesen stateless Worker unerreichbar; ohne einen
// echten Server-Speicher könnte get_address_book (siehe server.ts) der KI nie
// etwas zurückgeben. Das ist der einzige Fund-relevante* State, den dieser
// Worker jetzt hält (*kein Geld — nur Name→Adresse-Zuordnungen).
//
// Das Schreibrecht bleibt trotzdem an dieselbe Bedingung gebunden wie bei
// Sterntalers rein lokalem addressBook.ts: propose_address_book_entry (siehe
// server.ts) validiert nur und schreibt NIE direkt in dieses KV — geschrieben
// wird ausschließlich über saveEntry()/removeEntry() unten, die eine vom
// Wallet-Owner selbst signierte Nachricht verlangen (siehe
// contactSignature.ts). Der Chat kann also vorschlagen, aber nie schreiben.

export interface AddressBookEntry {
  name:    string;
  address: `0x${string}`;
  savedAt: number;
}

// Kleinste gemeinsame Schnittstelle zu Cloudflare KVNamespace — eigenes
// Interface statt des globalen @cloudflare/workers-types-Typs, damit dieses
// Modul auch ohne die Workers-Typdefinitionen typprüfbar bleibt (gleiches
// Prinzip wie ApisPublicClient in client.ts).
export interface AddressBookKV {
  get(key: string, type: 'json'): Promise<AddressBookEntry[] | null>;
  put(key: string, value: string): Promise<void>;
}

function storageKey(owner: `0x${string}`): string {
  return `addressbook:${owner.toLowerCase()}`;
}

export async function getAddressBook(kv: AddressBookKV, owner: `0x${string}`): Promise<AddressBookEntry[]> {
  const entries = await kv.get(storageKey(owner), 'json');
  return entries ?? [];
}

// Ersetzt einen bestehenden Eintrag mit derselben Adresse statt ihn zu
// duplizieren (gleiches Prinzip wie Sterntalers saveContact()) — ein Nutzer,
// der einen Kontakt erneut bestätigt (z.B. mit korrigiertem Namen), bekommt
// keine zwei Zeilen für dieselbe Adresse.
export async function saveEntry(
  kv: AddressBookKV, owner: `0x${string}`, entry: AddressBookEntry,
): Promise<AddressBookEntry[]> {
  const existing = await getAddressBook(kv, owner);
  const withoutDup = existing.filter((e) => e.address.toLowerCase() !== entry.address.toLowerCase());
  const updated = [...withoutDup, entry].sort((a, b) => a.name.localeCompare(b.name));
  await kv.put(storageKey(owner), JSON.stringify(updated));
  return updated;
}

export async function removeEntry(
  kv: AddressBookKV, owner: `0x${string}`, address: `0x${string}`,
): Promise<AddressBookEntry[]> {
  const existing = await getAddressBook(kv, owner);
  const updated = existing.filter((e) => e.address.toLowerCase() !== address.toLowerCase());
  await kv.put(storageKey(owner), JSON.stringify(updated));
  return updated;
}
