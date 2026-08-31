# ERC-7730 Clear Signing Descriptors

Metadata files that let a wallet show a human-readable description of an OSIRIS
transaction ("Start a recurring buy plan: pay 100 USDC over 10 purchases") instead
of raw calldata, if that wallet supports [ERC-7730](https://eips.ethereum.org/EIPS/eip-7730).
Pure off-chain metadata — no contract or ABI changes, nothing on-chain to deploy.

Validated against the real, currently published schema
(`specs/erc7730-v2.schema.json` in the registry below) — not just JSON syntax.

## Files

One descriptor per contract. Each vault type has two, because the factory (fixed
address) and the vault clones it creates (dynamic addresses, same shared bytecode)
are different contracts with different ABIs:

| File | Contract | Address (Celo Mainnet, chain 42220) |
|---|---|---|
| `dca-vault-factory.json` | `DcaVaultFactory` | `0xa6B66110b3593B5D32f4229CA5398611959149C5` |
| `dca-vault.json` | `DcaVault` clones | via factory `VaultCreated` event |
| `send-vault-factory.json` | `SendVaultFactory` | `0x4d63381b9b742683b92971d672018Ec5d82DA002` |
| `send-vault.json` | `SendVault` clones | via factory `VaultCreated` event |
| `trigger-vault-factory.json` | `TriggerVaultFactory` | `0x4398Cdd2AF617Bc36adBdF8a2BC60095535Bc625` |
| `trigger-vault.json` | `TriggerVault` clones | via factory `VaultCreated` event |

The `*-vault.json` files use `context.contract.factory` (`deployEvent`:
`VaultCreated(address indexed owner, address indexed vault)`) instead of a fixed
address list — this is the ERC-7730 spec's documented mechanism for EIP-1167
minimal-proxy clone factories, where every user gets their own vault address at
`createVault()` time rather than there being one fixed contract address to point
at. A wallet supporting this checks that the destination address it's about to
call shows up as the `vault` in a `VaultCreated` event emitted by one of the
addresses in `deployments`.

Only the addresses currently live in `src/config.ts` (`FACTORY_ADDRESS`,
`SEND_VAULT_FACTORY_ADDRESS`, `TRIGGER_VAULT_FACTORY_ADDRESS`) are covered — not
the `OLD_*` factory generations. Add another `deployments` entry per file if
coverage for those becomes worth it.

## Known limitation — unconfirmed wallet support

Checked before building these: the public registry (see below) had no existing
Celo (chain 42220) entries, and there's no confirmation that **MiniPay** — the
wallet OSIRIS users actually use — renders ERC-7730 descriptors at all. Writing
these files doesn't guarantee any OSIRIS user sees anything different in their
wallet today. The value right now is mostly future-proofing (for if/when MiniPay
or another wallet a user connects with adds support) and living, structured
documentation of what each function actually does.

## Approximations worth flagging

A few fields don't have a clean ERC-7730 representation and fall back to `raw`
display rather than something more structured:

- Array parameters (`_targetTokens`/`_targetBps` in `DcaVault.setupPlan`,
  `_recipients` in `SendVault.setupPlan`) — shown as raw values rather than a
  per-element breakdown.
- `SendVault.setupPlan`'s `_recipients` parameter is a struct array
  (`(address wallet, uint256 totalAmount)[]`) — the function signature key uses
  Solidity's tuple-array ABI notation with named fields; this wasn't explicitly
  confirmed against a real-world registry example using a struct array, so treat
  it as a best-effort guess pending validation by an actual ERC-7730 tool/wallet.
- `TriggerVault.setupPlan`'s `_triggerPrice` and `_expiresAt` are shown as raw
  numbers (8-decimal USD fixed-point, and a Unix timestamp respectively) rather
  than formatted — `_expiresAt` can legitimately be `0` (no expiry), which the
  `date` format type isn't a clean fit for.

## Next steps, if this is worth pursuing further

1. Get real wallet/tool confirmation this actually parses correctly — the
   registry repo below usually has a validator CLI.
2. If useful: submit as a PR to the public registry
   (`github.com/LedgerHQ/clear-signing-erc7730-registry`, `registry/<entity>/`
   folder convention, one entity per PR, test cases required per their
   contribution guidelines) so wallets that do support ERC-7730 can discover it.
3. Revisit the array/struct-array approximations above once real tooling
   feedback is available.
