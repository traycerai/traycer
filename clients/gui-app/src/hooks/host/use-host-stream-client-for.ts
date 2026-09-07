import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  isRemoteHostDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { createRemoteHostTransport } from "@traycer-clients/shared/host-transport/remote/index";
import { planRestrictedReprobeAtFromClosedReason } from "@traycer-clients/shared/host-transport/remote/config";
import type { HostStatusDTO } from "@traycer/protocol/host/host-status";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  appHostCredentialMintFlow,
  noteHostCredentialState,
} from "@/lib/auth/host-credential-provisioning";
import { acquireHostStreamClient } from "@/lib/host/host-stream-client-cache";
import { useHostBinding } from "@/lib/host/runtime";
import { processReconnectEngine } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";
import { appServerClock } from "@/lib/clock/app-server-clock";
import { getGuiClientIdentity } from "@/lib/host/client-identity";
import { appLogger } from "@/lib/logger";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  hostTransportKey,
  remoteAwareOwnerIdentity,
  remoteAwareOwnerIdentityKey,
} from "@/lib/host/transport-key";
import {
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_OPEN_ACK_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
} from "@traycer-clients/shared/host-transport/transport-config";

const TRANSPORT_KEY_SEPARATOR = "\u0000";

const browserStreamWebSocketFactory = createWhatwgStreamWebSocketFactory();

/** Inert placeholder satisfying `RemoteHostDirectoryEntry.remoteStatus`'s shape requirement where a caller only has the primitive transport identity (hostId/websocketUrl/publicKey) on hand, not a live status DTO. */
const PLACEHOLDER_REMOTE_STATUS: HostStatusDTO = {
  // `unknown`, not `offline`: this value is never rendered, but if it ever
  // leaked to a status surface it must not assert something we did not learn.
  // We are here precisely because the caller had no status DTO to hand.
  connectivity: "unknown",
  viewerReachability: "unknown",
  clientCloud: "ok",
  updateState: "current",
  appVersion: null,
  lastSeenAt: null,
};

export interface HostStreamClientBinding {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  /** NOT the dialability-only `hostTransportKey` - a caller comparing this across renders to decide "is this still the same owned session" must see a remote public-key rotation as a distinct value, or it would silently misuse a stale session the same way the S1-era owners did. */
  readonly transportKey: string;
  /** pin/unpin retain the shared cache entry across this hook's unmount. Unpin when the consumer's own need ends. */
  readonly pin: () => void;
  readonly unpin: () => void;
}

/** Idempotent release: unpin is a decrement, so a double teardown must not close a sibling's transport. */
export function streamTransportRetain(
  binding: HostStreamClientBinding,
): () => () => void {
  return () => {
    binding.pin();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      binding.unpin();
    };
  };
}

export function hostStreamTransportKeyFor(
  target: HostDirectoryEntry | null,
  userId: string | null,
): string | null {
  // Reuse the canonical transport identity so this per-tab key stays in lockstep with the app-wide `HostStreamProvider` key and cannot drift.
  // The `userId` scope rebuilds the client when the signed-in identity changes; token rotation is handled live by the `bearer` closure and intentionally does NOT key the client.
  const transport = hostTransportKey(target);
  if (transport === null || userId === null) {
    return null;
  }
  return ["host-stream", userId, transport].join(TRANSPORT_KEY_SEPARATOR);
}

/** Shared by the chat and terminal session registries so their readiness gate cannot drift.
 * Kept separate from each registry's test seam - tests substitute their own key via the factory override and so never reach (or need to mock) the real request context. */
export function authenticatedHostStreamKey(
  globalClient: HostClient<HostRpcRegistry>,
  target: HostDirectoryEntry | null,
): string | null {
  if (globalClient.getRequestContext() === null) {
    return null;
  }
  return hostStreamTransportKeyFor(
    target,
    globalClient.getRequestContextUserId(),
  );
}

/** Owner identity includes remote public key. hostTransportKey cannot see a same-host key rotation. */
export function authenticatedOwnerIdentityKey(
  globalClient: HostClient<HostRpcRegistry>,
  target: HostDirectoryEntry | null,
): string | null {
  if (globalClient.getRequestContext() === null) {
    return null;
  }
  return remoteAwareOwnerIdentityKey(
    target,
    globalClient.getRequestContextUserId(),
  );
}

/** Local dials endpoint live; remote returns null if the public key does not decode. */
export function buildHostStreamClient(params: {
  readonly target: HostDirectoryEntry;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly authnBaseUrl: string;
  readonly auth: StreamAuthRevalidator | null;
  /** The signed-in user this transport is built for. */
  readonly userId: string;
  /** Whether the process-wide wake sweep may proactively poke or force-drop the shared session behind this client (remote branch only). */
  readonly proactiveWakeEligible: boolean;
  // Render-path callers pass false and build in useEffect, not useMemo (discarded acquires would leak the shared session).
  readonly autoStart: boolean;
}): IHostStreamClient<HostStreamRpcRegistry> | null {
  if (params.target.kind === "remote") {
    // Fail closed: an incomplete remote row (no public key / no relay url)
    // must never fall through to the plain-WS branch below - that would dial
    // a relay attach URL without the Noise-NK transport.
    if (
      !isRemoteHostDirectoryEntry(params.target) ||
      params.target.websocketUrl === null
    ) {
      return null;
    }

    const remoteTransport = createRemoteHostTransport<
      HostRpcRegistry,
      HostStreamRpcRegistry
    >({
      hostId: params.target.hostId,
      userId: params.userId,
      relayAttachUrl: params.target.websocketUrl,
      authnBaseUrl: params.authnBaseUrl,
      hostPublicKey: params.target.publicKey,
      bearer: params.bearer,
      // Same UNAUTHORIZED recovery the local branch wires below: an expired
      // bearer at a wake-time re-attach revalidates + redials instead of
      // terminally closing the shared session (`RemoteSessionOptions.auth`).
      auth: params.auth,
      // A wrong wall clock wedges a remote session identically - it is the machine's clock, not the host's - and a user connected across a relay is the one least placed to guess why nothing works.
      clock: appServerClock,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: hostStreamRpcRegistry,
      webSocketFactory: browserStreamWebSocketFactory,
      requestId: uuidv4,
      evidence: transportEvidenceRelay,
      clientIdentity: getGuiClientIdentity(),
      proactiveWakeEligible: params.proactiveWakeEligible,
    });
    if (remoteTransport === null) return null;
    if (params.autoStart) {
      remoteTransport.session.start();
    }
    return remoteTransport.streamClient;
  }

  return new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    // Named, so this client can seed its stream-method support from what an earlier handshake with the SAME host already computed instead of probing for it again.
    hostId: params.target.hostId,
    endpoint: params.endpoint,
    bearer: params.bearer,
    auth: params.auth,
    // Without it, a bearer that reads "expired" only because the clock is hours off walks this session to `goTerminal` with a diagnosis that blames the credential.
    clock: appServerClock,
    // Always the app-wide flow, never a per-caller one: the renderer holds several clients against one host, and the shared module is what keeps that from becoming several concurrent mints revoking each other.
    hostCredentialMint: appHostCredentialMintFlow,
    // Kept wired as the one place transports report credential state into, but the report is deliberately INERT today: an `openAck` state carries no provenance (which credential, which transport, when), so `active` must NOT release the app-wide adoption claim - a delayed `active(A)` observed before A was burned would free B's claim and reopen the double-mint it exists to prevent.
    onHostCredentialState: noteHostCredentialState,
    // The LOCAL host's long-lived connection, so this is the leg that hears a restart tombstone from a local host restarted by somebody other than this app - a `traycer host restart` on the box, an update install.
    evidence: transportEvidenceRelay,
    webSocketFactory: browserStreamWebSocketFactory,
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: DEFAULT_OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
    pongTimeoutMs: DEFAULT_PONG_TIMEOUT_MS,
    initialBackoffMs: DEFAULT_INITIAL_BACKOFF_MS,
    maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
    clientIdentity: getGuiClientIdentity(),
  });
}

/** Stream client for a chosen host, not the app-wide HostStreamProvider. */
export function useHostStreamClientBindingFor(
  target: HostDirectoryEntry | null,
  auth: StreamAuthRevalidator | null,
): HostStreamClientBinding | null {
  const runtimeBinding = useHostBinding();
  if (runtimeBinding === null) {
    throw new Error(
      "useHostStreamClientBindingFor requires a HostRuntimeProvider",
    );
  }
  const globalClient = runtimeBinding.hostClient;
  const authnBaseUrl = useRunnerHost().authnBaseUrl;
  // `null` when signed out or the credential lease was released - the
  // "no bound user" / "no auth" gate.
  const requestContext = globalClient.getRequestContext();
  const userId = globalClient.getRequestContextUserId();
  const transportKey =
    requestContext === null ? null : hostStreamTransportKeyFor(target, userId);
  const endpointHostId = target?.hostId ?? null;
  const endpointWebsocketUrl = target?.websocketUrl ?? null;
  const endpointKind = target?.kind ?? null;
  const endpointPublicKey =
    target !== null && isRemoteHostDirectoryEntry(target)
      ? target.publicKey
      : null;

  const [binding, setBinding] = useState<HostStreamClientBinding | null>(null);
  const [rebuildNonce, setRebuildNonce] = useState(0);
  const teardownInProgressRef = useRef(false);
  // Back off failed dials of a persisted selection; otherwise mint/dial/handshake loops for as long as the pin stands.
  const [rebuildBackoff] = useState(() =>
    processReconnectEngine().createRebuildPacer(),
  );

  // Acquire in this effect, not useMemo: a discarded memo would leak the shared session refCount.
  useEffect(() => {
    if (
      transportKey === null ||
      endpointHostId === null ||
      endpointWebsocketUrl === null ||
      endpointKind === null ||
      userId === null
    ) {
      setBinding(null);
      return;
    }
    const endpoint = {
      hostId: endpointHostId,
      websocketUrl: endpointWebsocketUrl,
    };
    // Depend on primitive fields, not target identity. This fabricated entry is not a directory verdict.
    const memoizedTarget =
      endpointKind === "remote" && endpointPublicKey !== null
        ? ({
            hostId: endpointHostId,
            label: endpointHostId,
            kind: "remote",
            websocketUrl: endpointWebsocketUrl,
            version: null,
            transportDialability: "dialable",
            publicKey: endpointPublicKey,
            remoteStatus: PLACEHOLDER_REMOTE_STATUS,
            // Fabricated endpoint, not a directory verdict: never in fuse grace.
            relayFuseGrace: false,
            recentHostCheckIn: false,
            // Same reason `transportDialability` is written coarsely above: the plan gate ran upstream against the real directory entry, and re-asserting a refusal here would contradict a dial this effect has already been cleared to make.
            planAllowsRemote: true,
          } satisfies RemoteHostDirectoryEntry)
        : ({
            hostId: endpointHostId,
            label: endpointHostId,
            kind: endpointKind,
            websocketUrl: endpointWebsocketUrl,
            version: null,
            transportDialability: "dialable",
          } satisfies HostDirectoryEntry);

    // `buildHostStreamClient` runs only on a cache miss: a second surface naming the same host adopts this exact object, and that shared object identity is what makes the two share a `git.subscribeStatus` instead of opening one each (the subscription registries key on `client.instanceId`).
    const lease = acquireHostStreamClient(
      {
        kind: endpointKind,
        hostId: endpointHostId,
        userId,
        websocketUrl: endpointWebsocketUrl,
        publicKey: endpointPublicKey ?? "",
        authnBaseUrl,
        authRecovery: auth === null ? "terminal" : "revalidate",
      },
      () =>
        buildHostStreamClient({
          target: memoizedTarget,
          endpoint: () => endpoint,
          bearer: () => globalClient.getRequestContext()?.credentials ?? null,
          authnBaseUrl,
          auth,
          userId,
          // A render-path durable client (chat/terminal/epic tiles): its
          // streams are snapshot-shaped, so a swept reconnect only
          // re-snapshots.
          proactiveWakeEligible: true,
          // Never eager-start: this acquire is guaranteed exactly one matching release (unlike the old memo-based build), but the connect-on-first- subscribe laziness is an independent, unchanged behavior.
          autoStart: false,
        }),
    );
    if (lease === null) {
      setBinding(null);
      return;
    }
    const client = lease.client;
    // The SAME identity the binding is filed under, so the streak follows the transport rather than this hook instance: a caller that retargets is dialing a different machine, and the previous one's failures are not evidence about it.
    const builtTransportKey = remoteAwareOwnerIdentity(memoizedTarget, userId);
    rebuildBackoff.markBuilt(Date.now(), builtTransportKey);
    setBinding({
      transportKey: builtTransportKey,
      client,
      // Deliberately not a second count beside the cache's: two lifecycles over one object is how the same code yields premature disposal in one race and a leak in another.
      pin: lease.retain,
      unpin: lease.release,
    });

    return () => {
      teardownInProgressRef.current = true;
      // The client is closed here only if nothing else still holds one - neither a sibling surface on the same host nor an outstanding `pin()`.
      lease.release();
      teardownInProgressRef.current = false;
    };
  }, [
    auth,
    authnBaseUrl,
    endpointHostId,
    endpointKind,
    endpointPublicKey,
    endpointWebsocketUrl,
    globalClient,
    rebuildBackoff,
    rebuildNonce,
    transportKey,
    userId,
  ]);

  // Push the rotated bearer onto this client's open sessions whenever a token refresh rotates the credential lease in place, so the host updates each connection's credential without a reconnect (`credentialUpdate`).
  const client = binding?.client ?? null;
  useEffect(() => {
    if (client === null) {
      return;
    }
    return globalClient.onBearerRotated(() => {
      client.notifyBearerRotated();
    });
  }, [client, globalClient]);

  useEffect(() => {
    if (client === null) return;
    let backoffTimer: number | null = null;
    const clearBackoffTimer = (): void => {
      if (backoffTimer === null) return;
      window.clearTimeout(backoffTimer);
      backoffTimer = null;
    };
    const rebuild = (): void => {
      if (teardownInProgressRef.current) return;
      const planRestrictedReprobeAt = planRestrictedReprobeAtFromClosedReason(
        client.getClosedReason(),
      );
      if (planRestrictedReprobeAt !== null) {
        backoffTimer = window.setTimeout(
          () => {
            backoffTimer = null;
            setRebuildNonce((nonce) => nonce + 1);
          },
          Math.max(0, planRestrictedReprobeAt - Date.now()),
        );
        return;
      }
      const delayMs = rebuildBackoff.nextRebuildDelayMs(Date.now());
      appLogger.warn(
        "[stream] transient host stream client closed underneath its binding - rebuilding",
        {
          client: client.instanceId,
          closedReason: client.getClosedReason(),
          rebuildDelayMs: delayMs,
        },
      );
      if (delayMs === 0) {
        setRebuildNonce((nonce) => nonce + 1);
        return;
      }
      backoffTimer = window.setTimeout(() => {
        backoffTimer = null;
        setRebuildNonce((nonce) => nonce + 1);
      }, delayMs);
    };
    if (client.isClosed()) {
      rebuild();
      return clearBackoffTimer;
    }
    const unsubscribe = client.onClosed(rebuild);
    return () => {
      unsubscribe();
      clearBackoffTimer();
    };
  }, [client, rebuildBackoff]);

  return binding?.client.isClosed() === true ? null : binding;
}

export function useHostStreamClientFor(
  target: HostDirectoryEntry | null,
  auth: StreamAuthRevalidator | null,
): IHostStreamClient<HostStreamRpcRegistry> | null {
  return useHostStreamClientBindingFor(target, auth)?.client ?? null;
}
