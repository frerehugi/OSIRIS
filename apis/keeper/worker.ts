// Cloudflare-Workers-Entry-Point für den Apis-Keeper (Cron Trigger).
//
// Gleiches Muster wie OSIRIS' eigener keeper/worker.ts: ruft den plattform-
// neutralen Kern (apisKeeper.ts) mit env statt process.env auf. Bewusst KEIN
// Import von @cloudflare/workers-types — die "DOM"-Lib in diesem eigenen
// tsconfig.json deckt fetch/console/URL/setTimeout bereits ab, die hier
// verwendete Teilmenge des Workers-Runtime-Interface (scheduled()/waitUntil())
// reicht für diesen Handler völlig aus.

import { runApisKeeperCycle, type ApisKeeperEnv } from "./apisKeeper";

interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async scheduled(_event: unknown, env: ApisKeeperEnv, ctx: MinimalExecutionContext): Promise<void> {
    ctx.waitUntil(
      runApisKeeperCycle(env)
        .then((results) => {
          if (results.length === 0) {
            console.info("Apis-Keeper: Done — nichts ausgeführt.");
          } else {
            for (const { orderId, txHash } of results) {
              console.info(`Apis-Keeper: Done — Order ${orderId} -> ${txHash}`);
            }
          }
        })
        .catch((err) => {
          console.error("Apis-Keeper-Fehler:", err);
        })
    );
  },
};
