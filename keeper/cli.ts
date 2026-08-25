// Node.js-Entry-Point für den Keeper (GitHub Actions, lokales `npm run keeper`).
//
// Liest die Konfiguration aus process.env und ruft den plattformneutralen
// Kern (squidKeeper.ts) auf. Das Cloudflare-Workers-Pendant ist worker.ts.

import { runKeeperCycle, type Env } from "./squidKeeper";

const env: Env = {
  KEEPER_PRIVATE_KEY:       process.env.KEEPER_PRIVATE_KEY ?? "",
  SQUID_INTEGRATOR_ID:      process.env.SQUID_INTEGRATOR_ID ?? "",
  FACTORY_ADDRESSES:        process.env.FACTORY_ADDRESSES,
  FACTORY_ADDRESS:          process.env.FACTORY_ADDRESS,
  KEEPER_REFUEL_THRESHOLD:  process.env.KEEPER_REFUEL_THRESHOLD,
  KEEPER_REFUEL_PCT_BPS:    process.env.KEEPER_REFUEL_PCT_BPS,
};

runKeeperCycle(env)
  .then((results) => {
    if (results.length === 0) {
      console.info("Done: nichts ausgeführt.");
    } else {
      for (const { vaultAddress, receipt, kind } of results) {
        console.info(`Done (${kind ?? "dca"}): ${vaultAddress} -> ${receipt.transactionHash}`);
      }
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error("Keeper-Fehler:", err);
    process.exit(1);
  });
