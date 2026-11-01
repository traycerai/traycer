import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { botListChangedServerFrameSchema } from "@traycer/protocol/host/bot/schemas";
import {
  useStreamHostId,
  useStreamMethodSupportFor,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { hostQueryKeys } from "@/lib/query-keys";

type StreamClient = IHostStreamClient<HostStreamRpcRegistry>;

/** On the APP-WIDE stream client: Home's reading, like its `bot.list`. */
export function useBotListChangedSubscriptionForApp(enabled: boolean): void {
  useBotListChangedSubscription(
    useStreamHostId(),
    useWsStreamClient(),
    enabled,
  );
}

/**
 * Through an explicit host's own stream client: the bot tab's reading, bound
 * to its host for life (dialed as `useBotSubscriptionForHost` dials it).
 */
export function useBotListChangedSubscriptionForHost(
  hostId: string,
  enabled: boolean,
): void {
  const target = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  useBotListChangedSubscription(
    hostId,
    useHostStreamClientFor(target, auth),
    enabled,
  );
}

/**
 * Keeps `bot.list` current while a bots surface is mounted (Tracy Bots):
 * holds a `bot.listChanged` subscription on `hostId` and invalidates every
 * host's `bot.list` on each `changed` frame, the way the app's own bot writes
 * do, and every host's `bot.onboarding.read`, whose team setup turns live
 * when the team's main bot is created on the team's host. The frame
 * carries nothing; the reads are refetched.
 *
 * ONE session per host, however many surfaces ask (Home and an open bot tab
 * read the same host through two different clients): two sessions would
 * deliver every change twice, and the second invalidation restarts the first
 * one's fetch. The session lives on one consumer's client and moves to
 * another's when that consumer leaves; the last one out closes it, which
 * releases the host's environment rooms.
 *
 * Admitted once the client reports the method `supported`, and kept through
 * a transient `unknown` - the client forgets support while it redials, and
 * closing then would leave nothing to bring the session back. Only
 * `unsupported`, `enabled` going false or unmount ends it.
 *
 * A reconnect or a hand-off needs no refetch of its own: every open of the
 * stream is a new subscription on the host, which sends one `changed` once
 * the subscriber's rooms have opened (its reconciliation), and that covers a
 * change made while the session was down. Refetching here as well would be a
 * second fetch for the same gap, and would abort the first.
 */
export function useBotListChangedSubscription(
  hostId: string | null,
  client: StreamClient | null,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  const support = useStreamMethodSupportFor(client, "bot.listChanged");
  // The client this hook has seen report `supported`, held through `unknown`.
  const [supportedClient, setSupportedClient] = useState<StreamClient | null>(
    null,
  );
  if (support === "supported" && supportedClient !== client) {
    setSupportedClient(client);
  }
  if (support === "unsupported" && supportedClient !== null) {
    setSupportedClient(null);
  }
  const admitted =
    support === "supported" ||
    (support === "unknown" && supportedClient === client);

  useEffect(() => {
    if (!enabled || !admitted || hostId === null || client === null) return;
    return joinSharedSession(hostId, client, queryClient);
  }, [enabled, admitted, hostId, client, queryClient]);
}

type SharedSession = {
  /** Each joined surface and the client it reads the host through. */
  readonly consumers: Map<symbol, StreamClient>;
  readonly queryClient: QueryClient;
  live: { readonly client: StreamClient; close(): void } | null;
  /**
   * Clients whose session closed for good. Never handed the session again,
   * so two refusing clients cannot pass it back and forth.
   */
  readonly failedClients: WeakSet<StreamClient>;
};

const sessionsByHost = new Map<string, SharedSession>();

/** Test helper: drop every session without closing anything. */
export function __resetBotListChangedSessionsForTesting(): void {
  sessionsByHost.clear();
}

function joinSharedSession(
  hostId: string,
  client: StreamClient,
  queryClient: QueryClient,
): () => void {
  let shared = sessionsByHost.get(hostId);
  if (shared === undefined) {
    shared = {
      consumers: new Map(),
      queryClient,
      live: null,
      failedClients: new WeakSet(),
    };
    sessionsByHost.set(hostId, shared);
  }
  const entry = shared;
  const id = Symbol("bot-list-changed-consumer");
  entry.consumers.set(id, client);
  if (entry.live === null) openOn(entry, client);
  return () => {
    entry.consumers.delete(id);
    if (entry.consumers.size === 0) {
      entry.live?.close();
      entry.live = null;
      if (sessionsByHost.get(hostId) === entry) sessionsByHost.delete(hostId);
      return;
    }
    handOff(entry);
  };
}

/** One invalidation for both reads a `changed` frame makes stale, on every host scope. */
function invalidateOnBotListChanged(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    predicate: (query) =>
      hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, "bot.list") ||
      hostQueryKeys.matchesMethodOnAnyHost(
        query.queryKey,
        "bot.onboarding.read",
      ),
  });
}

/**
 * Puts the session on a remaining consumer's client when it has none, or
 * rides a client no remaining consumer holds. The session can be gone before
 * its consumer's cleanup runs: a client's owner closes it (a released lease,
 * the app's host changing) and that closes every session on it at once.
 */
function handOff(entry: SharedSession): void {
  const live = entry.live;
  const remaining = [...entry.consumers.values()];
  if (live !== null && remaining.includes(live.client)) return;
  live?.close();
  entry.live = null;
  const next = remaining.find(
    (candidate) => !candidate.isClosed() && !entry.failedClients.has(candidate),
  );
  if (next !== undefined) openOn(entry, next);
}

function openOn(entry: SharedSession, client: StreamClient): void {
  const session = client.subscribe("bot.listChanged", {});
  let closed = false;
  const live = {
    client,
    close: (): void => {
      closed = true;
      session.close();
    },
  };
  entry.live = live;
  session.onServerFrame((envelope) => {
    if (closed) return;
    const parsed = botListChangedServerFrameSchema.safeParse(envelope);
    if (!parsed.success || parsed.data.kind !== "changed") return;
    invalidateOnBotListChanged(entry.queryClient);
  });
  session.onStatusChange((status, reason) => {
    if (closed) return;
    if (status === "closed") {
      // A retryable close is the transport redialing this same session.
      if (reason?.kind === "fatalError" && reason.details.retryable === true) {
        return;
      }
      // Terminal on this client: another consumer's client carries it on,
      // or the next surface to join opens a fresh one; until then the list
      // refreshes on focus.
      closed = true;
      entry.failedClients.add(client);
      if (entry.live !== live) return;
      entry.live = null;
      if (entry.consumers.size > 0) handOff(entry);
    }
  });
}
