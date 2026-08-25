// Gemeinsamer viem-PublicClient — ausgelagert aus server.ts, damit plans.ts
// (und jedes künftige Lese-Tool) denselben, exakt typisierten Client nutzen
// kann, ohne einen zirkulären Import auf server.ts zu brauchen.

import { createPublicClient, http, fallback } from 'viem';
import { celo } from 'viem/chains';

// Gleiche RPC-Fallback-Strategie wie OSIRIS' und Apis' Keeper — bewusst
// wiederverwendetes Muster, kein neuer Anbieter.
const RPC_URLS = ['https://forno.celo.org', 'https://rpc.ankr.com/celo'];

export const publicClient = createPublicClient({ chain: celo, transport: fallback(RPC_URLS.map((url) => http(url))) });

export type ApisPublicClient = typeof publicClient;
