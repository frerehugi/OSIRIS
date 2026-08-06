# MiniPay Mini-App-Listing — Checkliste & Referenzdaten

Für das Formular unter `https://developer.minipay.to/mini-app-listing`. Diese Datei
sammelt alles, was recherchiert/entschieden werden musste, statt es im Formular
neu zu suchen.

## App-URL

**`https://app.osirisapp.xyz`** — nicht `osirisapp.xyz` (das ist nur die Marketing-
Landingpage, kein Teil der eigentlichen Mini-App). Nutzer landen so beim Öffnen
direkt in der funktionsfähigen App, ohne Umweg über die Landingpage.

## Netzwerk-Manifest (alle Origins, die die App vom Nutzergerät aus kontaktiert)

| Origin | Zweck |
|---|---|
| `fonts.googleapis.com`, `fonts.gstatic.com` | Google Fonts (Inter) |
| `forno.celo.org`, `rpc.ankr.com` | Celo-RPC (Lesen/Schreiben on-chain, mit Fallback) |
| `celoscan.io` | Ausgehende Links (Contract/Tx-Ansicht), keine API-Calls |
| `link.minipay.xyz` | Add-Cash-Deeplink bei zu niedrigem Guthaben |
| `t.me` | Support-/Update-Kanal (ausgehender Link) |
| `osirisapp.xyz` | Landingpage (ausgehender Link aus "About") |

Hinweis: `apiplus.squidrouter.com` wird **nicht** von der App selbst kontaktiert,
sondern nur vom separaten Keeper-Service (Cloudflare Worker) — kein Teil des
Netzwerk-Footprints der Mini-App vom Nutzergerät aus.

## Support-URL

`https://t.me/osirisapp`

## Icon

`public/icon-512.png` (512×512, aus `banner.jpg` zugeschnitten).

## ToS / Privacy Policy

In der App selbst als Screens umgesetzt (`View: 'terms'` / `'privacy'` in
`src/App.tsx`, verlinkt von "About OSIRIS"):
- `https://app.osirisapp.xyz` → About → Terms
- `https://app.osirisapp.xyz` → About → Privacy

(Kein separates Hosting nötig, solange das Formular einen In-App-Pfad statt
zwingend einer eigenen URL akzeptiert — sonst müssten die Texte zusätzlich als
eigene Unterseite auf `osirisapp.xyz` gespiegelt werden.)

## Noch offen (Recherche/Prozess, kein Code)

- [ ] **PageSpeed-Insights-Score** der Produktions-URL (`app.osirisapp.xyz`) laufen
      lassen und Ergebnis fürs Formular festhalten.
- [ ] **Sample-Transaktions-Links** für jede nutzerseitige Contract-Methode
      sammeln: `createVault`, `approve` (USDC/USDT), `setupPlan`, `cancelPlan`.
      (`executeStep` wird nur vom Keeper aufgerufen, nicht nutzerseitig — vermutlich
      trotzdem sinnvoll, mindestens einen Beispiel-Tx-Link mitzugeben.)
- [ ] Verifizieren, dass **alle** aktuell genutzten Contracts auf Celoscan verifiziert
      sind — nicht nur die ursprüngliche Factory:
      - Aktuelle Factory (`FACTORY_ADDRESS`, config.ts)
      - Alte Factory (`OLD_FACTORY_ADDRESS`, config.ts — hat noch aktive Vaults)
      - Vault-Implementation (`VAULT_IMPLEMENTATION_ADDRESS`, config.ts)
      - Standalone-Legacy-Vault (`VAULT_ADDRESS`, config.ts)
- [ ] Kategorie fürs Formular festlegen (vermutlich `finance`).
- [ ] Tagline + Publisher-Name final formulieren (Publisher: "Schmitz & Hugenberg").
