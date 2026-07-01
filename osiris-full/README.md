# OSIRIS

**OSnabrück Investment and Risk Management System**

A DCA (Dollar-Cost Averaging) vault on Celo that automatically invests stablecoins into wBTC, wETH, CELO and XAUoT on a daily or weekly schedule via MiniPay.

---

## Architecture

```
osiris/
├── src/
│   ├── App.tsx            # React frontend — 6-step DCA wizard
│   ├── App.css            # Styles
│   ├── main.tsx           # React entry point
│   ├── types.ts           # Shared TypeScript interfaces
│   ├── config.ts          # Token addresses, chain IDs, pool fees
│   ├── dcaVaultAbi.ts     # Contract ABI (V4 UniversalRouter)
│   ├── minipayWallet.ts   # MiniPay / viem wallet integration
│   └── demo/
│       ├── OsirisDemoDE.jsx   # Standalone demo (German)
│       └── OsirisDemoEN.jsx   # Standalone demo (English)
├── contracts/
│   └── DcaVault.sol       # Smart contract (Solidity 0.8.20)
├── keeper/
│   └── squidKeeper.ts     # Automated execution service (Node.js)
├── public/
│   └── banner.jpg         # OSIRIS banner image
└── index.html
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Wallet | MiniPay (Celo), viem v2 |
| Smart Contract | Solidity 0.8.20, OpenZeppelin |
| DEX | Uniswap V4 UniversalRouter |
| Token Approvals | Permit2 |
| Cross-chain Quotes | Squid Router v2 |
| Keeper | Node.js, tsx |
| Network | Celo (Mainnet + Sepolia Testnet) |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

Edit `src/config.ts`:

```ts
export const VAULT_ADDRESS       = "0x..."  // after deploy
export const SQUID_INTEGRATOR_ID = "minipay-osiris-xxxxxxxx"
export const ACTIVE_CHAIN_ID     = CELO_SEPOLIA_CHAIN_ID  // or CELO_CHAIN_ID for mainnet
```

### 3. Run frontend (dev)

```bash
npm run dev
# → http://localhost:5173
```

### 4. Type check

```bash
npm run typecheck
```

---

## Smart Contract Deployment (Celo Sepolia)

Deploy via [Remix IDE](https://remix.ethereum.org):

1. Open `contracts/DcaVault.sol` in Remix
2. Compiler: Solidity `0.8.20`, optimization enabled
3. Deploy with MetaMask on **Celo Sepolia** (Chain ID: `11142220`)
4. Constructor args:
   - `_universalRouter`: `0x8891A0A682cC7f0bda7912E79C80167403d96103`
   - `_owner`: your wallet address
5. Copy the deployed address into `src/config.ts`

### Network Details

| | Celo Mainnet | Celo Sepolia |
|---|---|---|
| Chain ID | 42220 | 11142220 |
| UniversalRouter | `0xcb695bc5d3aa22cad1e6df07801b061a05a0233a` | `0x8891A0A682cC7f0bda7912E79C80167403d96103` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same |
| Faucet | — | [faucet.celo.org](https://faucet.celo.org/celo-sepolia) |

---

## Keeper Service

The keeper watches `canExecute()` on-chain and triggers `executeStep()`:

```bash
# Set private key (never commit this!)
export KEEPER_PRIVATE_KEY=0x...

# Run once
npm run keeper

# Or via cron (every hour)
0 * * * * cd /path/to/osiris && npm run keeper
```

---

## Token Addresses (Celo Sepolia)

| Token | Address |
|---|---|
| USDC | `0x01C5C0122039549AD1493B8220cABEdD739BC44E` |
| USDT | `0xd077A400968890Eacc75cdc901F0356c943e4fDb` |
| WETH | `0x2cE73DC897A3E10b3FF3F86470847c36ddB735cf` |
| CELO | `0x471EcE3750Da237f93B8E339c536989b8978a438` |
| wBTC | deploy mock ERC-20 for testing |
| XAUoT | deploy mock ERC-20 for testing |

---

## Open TODOs before Mainnet

- [ ] Verify wBTC, wETH, XAUoT addresses on Celo Mainnet
- [ ] Request `SQUID_INTEGRATOR_ID` from Squid
- [ ] Deploy mock ERC-20s for wBTC + XAUoT on Sepolia
- [ ] Full end-to-end test on Celo Sepolia
- [ ] Security audit of DcaVault.sol

---

## License

MIT — University of Osnabrück
