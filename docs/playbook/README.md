# OSIRIS Playbook

Reusable knowledge from building OSIRIS — a non-custodial DCA vault on Celo
(React/Vite frontend, Solidity/Foundry contracts, viem, Squid Router
aggregation, GitHub Actions keeper). Written so a future, unrelated project
can point back here and ask "how did OSIRIS solve this?"

**How to use this from another project/chat:** attach this repo
(`frerehugi/OSIRIS`) and read the relevant file below — there's no other way
to carry this context across chats automatically.

## Contents

- [`architecture.md`](./architecture.md) — system design and the reasoning
  behind it (factory/clone pattern, keeper-driven execution, fee mechanism).
- [`lessons-learned.md`](./lessons-learned.md) — concrete bugs/problems and
  how they were actually fixed, with file references. The most useful file
  for "how did we solve X" questions.
- [`wallet-strategy.md`](./wallet-strategy.md) — how to support multiple
  mobile crypto wallets (MiniPay, Trust Wallet, MetaMask Mobile, Valora)
  without endangering an existing integration; when WalletConnect is/isn't
  worth the added risk.
- [`fee-economics.md`](./fee-economics.md) — how to actually measure whether
  an on-chain protocol's fee covers its own gas cost, using only public RPC
  calls (no explorer API/indexer needed), and the break-even-price method.

## Quick facts about OSIRIS (for orientation)

- **Chain:** Celo Mainnet (42220). Non-custodial: each user gets their own
  vault via an EIP-1167 minimal-proxy clone from a factory contract.
- **Routing:** All swaps go through Squid Router — the keeper fetches a
  route off-chain, the vault contract just validates and executes it.
- **Keeper:** stateless, runs hourly via GitHub Actions cron
  (`.github/workflows/keeper.yml`), also portable to a Cloudflare Worker
  (`keeper/worker.ts`) — core logic in `keeper/squidKeeper.ts` is platform-
  neutral (no direct `process.env` access).
- **Fee:** 0.99% per execution with a floor (`minFee`), paid straight to the
  keeper wallet, which doubles as treasury and auto-refuels its own CELO gas
  by periodically swapping accumulated stablecoin fees.
- **Frontend wallet integration:** `src/minipayWallet.ts` — deliberately
  generic (`window.ethereum`), not MiniPay-specific, despite the filename.
