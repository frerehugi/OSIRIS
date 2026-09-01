// Client-side Squid `/token-price` lookup — shared by the OSIRIS app
// (src/App.tsx, "Squid Token Prices" screen) and the APIS app
// (apis/app/src/screens/TokenPrices.tsx), same single-source-of-truth
// pattern as the rest of src/config.ts. Mirrors keeper/squidKeeper.ts's
// getTokenPriceUsd() (same endpoint, same response shape), the keeper's
// own already-proven way of reading this value — kept as its own small
// module (not re-exporting from the keeper) since keeper/ pulls in
// Node-only APIs elsewhere and isn't meant to be bundled into the browser
// build.
//
// Calling Squid directly from the browser is already the disclosed data
// flow in both apps' Privacy screens ("OSIRIS talks directly from your
// device to: ... the Squid Router API") — this is simply the first screen
// that actually does it; every other Squid call so far goes through the
// keeper server-side.

import { ACTIVE_CHAIN_ID, SQUID_INTEGRATOR_ID } from "./config";

export async function fetchTokenPriceUsd(tokenAddress: `0x${string}`): Promise<number> {
  const url = new URL("https://apiplus.squidrouter.com/v2/token-price");
  url.searchParams.set("chainId", ACTIVE_CHAIN_ID);
  url.searchParams.set("tokenAddress", tokenAddress);

  const response = await fetch(url.toString(), {
    headers: { "x-integrator-id": SQUID_INTEGRATOR_ID },
  });
  if (!response.ok) {
    throw new Error(`Squid token-price failed: ${response.status}`);
  }
  // Antwort ist { token: { ..., usdPrice: number, ... } } — kein "price"-Feld
  // auf oberster Ebene, siehe gleicher Fund in keeper/squidKeeper.ts.
  const data = (await response.json()) as { token?: { usdPrice?: number } };
  const price = data.token?.usdPrice;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw new Error("Squid token-price: no valid usdPrice in response");
  }
  return price;
}
