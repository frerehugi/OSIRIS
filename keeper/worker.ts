// Cloudflare-Workers-Entry-Point für den Keeper (Cron Trigger).
//
// Ruft denselben plattformneutralen Kern wie cli.ts auf (squidKeeper.ts),
// bekommt die Konfiguration aber als env-Parameter statt aus process.env —
// Workers stellen Secrets/Vars nur zur Aufrufzeit im Handler bereit, nicht
// als globalen process.env.
//
// Bewusst KEIN Import von @cloudflare/workers-types: das Paket würde
// globale DOM-Ambient-Types mitbringen, die mit dem "DOM"-Lib-Eintrag im
// gemeinsamen Root-tsconfig (für das React-Frontend) kollidieren. Die hier
// verwendete Teilmenge des Workers-Runtime-Interface reicht für diesen
// Handler völlig aus.

import { runKeeperCycle, type Env } from "./squidKeeper";

interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: MinimalExecutionContext): Promise<void> {
    ctx.waitUntil(
      runKeeperCycle(env)
        .then((results) => {
          if (results.length === 0) {
            console.info("Done: nichts ausgeführt.");
          } else {
            for (const { vaultAddress, receipt } of results) {
              console.info(`Done: ${vaultAddress} -> ${receipt.transactionHash}`);
            }
          }
        })
        .catch((err) => {
          console.error("Keeper-Fehler:", err);
        })
    );
  },
};
