// Wagmi-Setup + Auto-Connect — nach MiniPay-Referenz Abschnitt 3/4.
//
// Harte Regeln aus der Referenz:
//   1. Immer Auto-Connect beim Laden, NIE einen "Connect Wallet"-Button zeigen.
//   2. Kein Message-Signing zur Authentifizierung.
//   3. Nur `injected()`-Connector — MiniPay unterstützt kein WalletConnect-Pairing.
//   4. Verbindungsstatus über `useConnection()` (wagmi v3), NICHT `useAccount()`
//      (dort nur als deprecated Alias vorhanden — per npm-Paket verifiziert).
//   5. Keine "Connecting…"/"Connected"-UI-States — nur Fehler anzeigen.

import { useEffect, useState, useCallback } from 'react';
import { http, createConfig } from 'wagmi';
import { celo, celoSepolia } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { useConnect, useConnectors } from 'wagmi';

export const wagmiConfig = createConfig({
  chains: [celo, celoSepolia],
  connectors: [injected()],
  transports: {
    [celo.id]:        http(),
    [celoSepolia.id]: http(),
  },
});

/// Erkennt, ob überhaupt ein injizierter Provider da ist — außerhalb von
/// MiniPay (bzw. einer anderen kompatiblen In-App-Wallet) ist window.ethereum
/// nicht gesetzt, und ein Connect-Versuch würde nur eine irreführende
/// Fehlermeldung von wagmi selbst produzieren statt einer klaren Erklärung.
export function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { ethereum?: unknown }).ethereum !== 'undefined';
}

/// Verbindet automatisch beim ersten Mount. `retry` erlaubt einen erneuten
/// Versuch (z.B. durch Tippen auf das APIS-Logo auf dem Landing-Screen, siehe
/// Gesamtplan §14 "Re-Entry") — bewusst kein sichtbarer "Connect"-Button,
/// nur ein neutraler Marken-Tap, der denselben Mechanismus erneut auslöst.
export function useAutoConnect() {
  const connectors = useConnectors();
  const { connect, error, isPending } = useConnect();
  const [hasAttempted, setHasAttempted] = useState(false);

  const attempt = useCallback(() => {
    if (!hasInjectedProvider() || connectors.length === 0) {
      setHasAttempted(true);
      return;
    }
    connect(
      { connector: connectors[0] },
      { onSettled: () => setHasAttempted(true) },
    );
  }, [connect, connectors]);

  // hasAttempted schützt vor Mehrfachausführung, auch wenn sich attempt()
  // durch eine Connectors-Änderung neu referenziert — der eigentliche
  // Auto-Connect-Versuch läuft dadurch trotzdem nur genau einmal.
  useEffect(() => {
    if (hasAttempted) return;
    attempt();
  }, [attempt, hasAttempted]);

  const retry = useCallback(() => {
    setHasAttempted(false);
    attempt();
  }, [attempt]);

  return { error, isPending, retry, providerMissing: !hasInjectedProvider() };
}
