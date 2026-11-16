import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The window's bot lifetime: a count that moves on every change of the
 * account the app reads as (`contextMetadata.userId`), from one account to
 * another, to signed out and from signed out. A, B, A is three lifetimes. A
 * same-user re-projection, a token rotation or an unverified session for the
 * same user changes no user id, so it moves nothing.
 *
 * Bot data from an earlier lifetime is retired, not partitioned: at the move,
 * synchronously and before any reader of the lifetime is told, every
 * registered retirer drops what the previous account's bot data lives in.
 * Whatever could write it back checks the lifetime it was opened or started
 * under against `currentBotLifetime()`.
 */
let lifetime = 0;

/**
 * Something the previous account's bot data lives in. It runs at every move,
 * after the lifetime has moved and before any reader is told, with the
 * window's live query clients.
 */
export type BotLifetimeRetirer = (clients: readonly QueryClient[]) => void;

const retirers: BotLifetimeRetirer[] = [];
const readers = new Set<() => void>();

/**
 * The window's query clients, held weakly: a reference only finds a client
 * at the move and disposes nothing, so a client nothing else holds is
 * released. Dead references are pruned on every registration and every move.
 */
const clientRefs = new Set<WeakRef<QueryClient>>();
const registeredClients = new WeakSet<QueryClient>();

function liveClients(): QueryClient[] {
  const live: QueryClient[] = [];
  for (const ref of clientRefs) {
    const client = ref.deref();
    if (client === undefined) {
      clientRefs.delete(ref);
    } else {
      live.push(client);
    }
  }
  return live;
}

/** Install when a QueryClient is created, so the move finds its bot data. */
export function registerBotLifetimeClient(client: QueryClient): void {
  if (registeredClients.has(client)) return;
  registeredClients.add(client);
  liveClients();
  clientRefs.add(new WeakRef(client));
}

/** Retire what `retirer` names at every later move. */
export function retireAtBotLifetimeEdge(retirer: BotLifetimeRetirer): void {
  retirers.push(retirer);
}

/**
 * One listener for the window, installed at import and holding no client.
 * The request context changes before the store (`AuthService`), so a request
 * sent after the move already goes out as the new account.
 */
useAuthStore.subscribe((state, previous) => {
  const viewer = state.contextMetadata?.userId ?? null;
  if (viewer === (previous.contextMetadata?.userId ?? null)) return;
  lifetime += 1;
  const clients = liveClients();
  for (const retire of retirers) retire(clients);
  for (const reader of [...readers]) reader();
});

export function currentBotLifetime(): number {
  return lifetime;
}

function subscribeToLifetime(reader: () => void): () => void {
  readers.add(reader);
  return () => {
    readers.delete(reader);
  };
}

/** The lifetime as a render reads it: a render after the move sees the new one. */
export function useBotLifetime(): number {
  return useSyncExternalStore(
    subscribeToLifetime,
    currentBotLifetime,
    currentBotLifetime,
  );
}
