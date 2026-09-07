import {
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  QueryClientContext,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from "@tanstack/react-query";
import {
  spawnEpicRuntimeWorker,
  type EpicRuntimeBodyReturnTarget,
} from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import { createProcessBackedAccountingPort } from "@/stores/epics/open-epic/runtime/process-backed-accounting-port";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { dispatchEpicWriteCommand } from "@/stores/epics/open-epic/runtime/epic-write-command-dispatch";
import { dispatchEpicLaneUnary } from "@/stores/epics/open-epic/runtime/epic-lane-unary-dispatch";
import {
  classifyEpicWriteCommandFailure,
  readWriteCommandIntent,
} from "@/stores/epics/open-epic/runtime/epic-write-command";
import { getEpicRuntimeWorkerFactory } from "@/lib/registries/epic-session-registry";
import { createLateBoundProjectionTarget } from "@/stores/epics/open-epic/runtime/worker/late-bound-projection-target";
import type { EpicRuntimeProjection } from "@/stores/epics/open-epic/runtime/epic-runtime-projection";
import { appLogger } from "@/lib/logger";
import {
  createOpenEpicStore,
  isProjectionPatch,
  type OpenEpicState,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthService, type HostRpcRegistry } from "@/lib/host";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import { useReactiveOwnerIdentityKey } from "@/hooks/host/use-reactive-owner-identity-key";
import {
  cloudEpicTasksQueryKeyMatchesScope,
  epicTaskContextsQueryKeyMatchesScope,
  updateEpicTitleInCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import {
  claimDesktopEpicOwnership,
  getDesktopEpicOwnershipBridge,
  releaseDesktopEpicOwnership,
} from "@/lib/windows/desktop-epic-ownership";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
  EpicSessionPresentationContext,
  attributeEpicSessionTransportClose,
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
  handleHostClients,
  handleHostIds,
  isEpicSessionHandleDead,
  releaseOpenEpicSessionIfUnused,
  trackEpicSessionHandleLiveness,
  trackEpicSessionTransportCloseAttribution,
  type EpicSessionTransportCloseTrigger,
} from "@/lib/registries/epic-session-registry";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { shouldMergeEpicRoomSwap } from "@/lib/epics/epic-room-swap";
import { armCarriesRootWrites } from "@/stores/epics/open-epic/runtime/epic-adapter-selection";
import { ESTABLISHING_DEADLINE_MS } from "@/lib/host/bounded-load-budgets";
import { attachPlanRestrictedReprobe } from "@/lib/host/owned-durable-stream-client";
import { createPlanRestrictedSessionRebuildBackoff } from "@/lib/host/plan-restricted-session-rebuild-backoff";
import { openEpicKey } from "@/lib/persist";
import { adoptLegacyPersistedKey } from "@/lib/persist/zustand-persist-lifecycle";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";
import { sessionCreatedEpicHostId } from "@/lib/epics/session-created-epics";

export interface EpicSessionProviderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}

interface MountedSessionState {
  readonly handle: OpenEpicStoreHandle;
  readonly hostId: string;
  readonly ownerIdentityKey: string | null;
}

/** `completed` fills in the reading; it is not a rebuild. */
type OwnerIdentityVerdict =
  | { readonly kind: "stable" }
  | { readonly kind: "completed"; readonly session: MountedSessionState }
  | { readonly kind: "rotated" };

const OWNER_IDENTITY_STABLE: OwnerIdentityVerdict = { kind: "stable" };

/** R-1: `ownerIdentityKey` is the owner identity of this tuple's own `hostId`. Same host or nothing; an absent reading is not a rotation. The `| null` host id is unreachable from both call sites. */
function readOwnerIdentityVerdict(
  current: MountedSessionState | null,
  ownerIdentityKey: string | null,
  ownerIdentityKeyHostId: string | null,
): OwnerIdentityVerdict {
  if (current === null) return OWNER_IDENTITY_STABLE;
  if (ownerIdentityKeyHostId !== current.hostId) return OWNER_IDENTITY_STABLE;
  if (ownerIdentityKey === null) return OWNER_IDENTITY_STABLE;
  if (current.ownerIdentityKey === null) {
    return { kind: "completed", session: { ...current, ownerIdentityKey } };
  }
  if (current.ownerIdentityKey === ownerIdentityKey) {
    return OWNER_IDENTITY_STABLE;
  }
  return { kind: "rotated" };
}

/** Record a key only when it was read off this tuple's own host; otherwise absent. Both tuple writers (adoption and `commitReplacement`) must route through here. */
function ownerIdentityKeyForHost(
  hostId: string,
  ownerIdentityKey: string | null,
  ownerIdentityKeyHostId: string | null,
): string | null {
  return ownerIdentityKeyHostId === hostId ? ownerIdentityKey : null;
}

type SessionPresentationKind = "ready" | "establishing" | "failed";

interface SessionPresentationState {
  readonly kind: SessionPresentationKind;
  readonly targetHostId: string | null;
  readonly originalHostId: string | null;
}

/** Construction host stamp, or throw. Absence is a broken write-once invariant, not a fallback. This map and the registry that hands back warm handles must stay in one module. */
function requireConstructionHostStamp(handle: OpenEpicStoreHandle): string {
  const stamped = handleHostIds.get(handle);
  if (stamped === undefined || stamped === null) {
    throw new Error("epic session handle carries no construction host stamp");
  }
  return stamped;
}

export function EpicSessionProvider(
  props: EpicSessionProviderProps,
): ReactNode {
  const { epicId, tabId, children } = props;

  // Opening the task retires its imported-unseen dot; every open path mounts this provider.
  useEffect(() => {
    useImportedUnseenStore.getState().markSeen(epicId);
  }, [epicId]);

  // Session owns its durable transport; a stable-`hostId` restart is healed by the transport, not a re-subscribe.
  const openTransport = useDurableStreamTransportFactory();
  const effectiveHostId = useEffectiveHostId();
  const authorityAttached = useSelectionAuthorityAttached();
  const authService = useAuthService();
  const queryClient = use(QueryClientContext);
  const navigate = useNavigate();
  const desktopBridge = getDesktopEpicOwnershipBridge();
  // Canonical `profile.userId`. Email is not an identity: two accounts can share an address.
  const sessionUserId = useAuthStore((state) => state.profile?.userId ?? null);
  // Names the pre-userId persist key for one-time adoption; not an identity. Not a session-effect dependency.
  const legacyEmail = useAuthStore((state) => state.profile?.email ?? null);
  const adoptLegacyOpenEpicKey = useEffectEvent((userId: string): void => {
    // `openEpicKey(null, …)` is the anonymous bucket; do not adopt it into an account bucket.
    if (legacyEmail === null) return;
    adoptLegacyPersistedKey(
      openEpicKey(userId, epicId),
      openEpicKey(legacyEmail, epicId),
    );
  });
  const cloudTasksUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );

  // UNAUTHORIZED: re-validate the live RequestContext. Not a reason to reacquire the session.
  const onAuthError = useEffectEvent((): void => {
    void authService.revalidateCurrentContext();
  });

  const ownershipKey =
    desktopBridge === null
      ? "browser"
      : `${desktopBridge.windowId}\x1f${epicId}\x1f${tabId}`;
  const [claimedOwnershipKey, setClaimedOwnershipKey] = useState<string | null>(
    () => (desktopBridge === null ? ownershipKey : null),
  );
  const ownershipClaimed =
    desktopBridge === null || claimedOwnershipKey === ownershipKey;

  // Desktop: claim single-window ownership before acquiring a live session. Children still render; session-bound slots see null.
  useEffect(() => {
    if (desktopBridge === null) return;

    const lifecycle = { cancelled: false };
    let claimHeld = false;
    void (async () => {
      const claim = await claimDesktopEpicOwnership(tabId, epicId);
      if (lifecycle.cancelled) {
        if (claim.ok) {
          await releaseDesktopEpicOwnership(tabId);
        }
        return;
      }
      if (claim.ok) {
        claimHeld = true;
        setClaimedOwnershipKey(ownershipKey);
        return;
      }
      const cleanupPatch = useEpicCanvasStore.getState().discardTabState(tabId);
      if (cleanupPatch !== null) {
        await desktopBridge.perWindowState.update(cleanupPatch);
      }
      // Claim keys on `tabId`, not epic. Release only if no other tab in this window still shows it; `null` means another window owns it, so do not retain here.
      releaseOpenEpicSessionIfUnused(epicId, "keep", null);
      await desktopBridge.requestFocus(claim.currentOwner);
      void navigate({ to: "/epics", replace: true });
    })();

    return () => {
      lifecycle.cancelled = true;
      if (claimHeld) {
        void releaseDesktopEpicOwnership(tabId);
      }
    };
  }, [desktopBridge, epicId, navigate, ownershipKey, tabId]);

  const [session, setSession] = useState<MountedSessionState | null>(null);
  const sessionRef = useRef<MountedSessionState | null>(null);
  const originalHostIdRef = useRef<string | null>(null);
  // Seed from create-host memory: until the cloud record lands, only that host can serve this epic. Time-bounded; given up on the first derivation move.
  const [requestedHostId, setRequestedHostId] = useState<string | null>(() =>
    sessionCreatedEpicHostId(epicId),
  );
  // Only the seed is given up (derivation move, Retry, or user naming a host). An explicit request outlives those.
  const seededCreateHostRef = useRef(requestedHostId !== null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [presentation, setPresentation] = useState<SessionPresentationState>({
    kind: "establishing",
    targetHostId: requestedHostId ?? effectiveHostId,
    originalHostId: null,
  });
  const targetHostId = requestedHostId ?? effectiveHostId;
  // One controller per mounted provider so handle replacement cannot reset owner-level backoff.
  const [planRestrictedSessionRebuildBackoff] = useState(
    createPlanRestrictedSessionRebuildBackoff,
  );
  useEffect(() => {
    return () => {
      planRestrictedSessionRebuildBackoff.cancel();
    };
  }, [
    epicId,
    ownershipClaimed,
    planRestrictedSessionRebuildBackoff,
    sessionUserId,
    targetHostId,
  ]);
  const resolvedSessionHostClient = useHostClientForHostId(
    session?.hostId ?? targetHostId,
  );
  // Incoming-host client. During a re-point `session` still names the outgoing host.
  const resolvedTargetHostClient = useHostClientForHostId(targetHostId);
  // Resolve by this handle's host id: two handles are live during a re-point, and the outgoing handle must keep sending to its own host.
  const getRequesterForHostId = useEffectEvent(
    (hostId: string): HostClient<HostRpcRegistry> | null => {
      if (hostId === targetHostId) return resolvedTargetHostClient;
      if (session !== null && hostId === session.hostId) {
        return resolvedSessionHostClient;
      }
      // Refuse rather than fall back to "whatever is live": a null requester is a visible refusal.
      return null;
    },
  );
  // R-1: read owner identity off the session's host, not the app-wide client.
  const ownerIdentityKey = useReactiveOwnerIdentityKey(
    resolvedSessionHostClient,
  );
  // Host the reading above describes, captured from the same expression the resolver consumed so the pairing cannot drift.
  const ownerIdentityKeyHostId = session?.hostId ?? targetHostId;

  // Presentation writes are idempotent by value so an unstable `openTransport` cannot loop this effect.
  const presentSession = useCallback((next: SessionPresentationState): void => {
    setPresentation((current) =>
      current.kind === next.kind &&
      current.targetHostId === next.targetHostId &&
      current.originalHostId === next.originalHostId
        ? current
        : next,
    );
  }, []);

  const retryRepoint = useCallback((): void => {
    // A user Retry supersedes an automatic backed-off retry; otherwise the old timer rebuilds the freshly retried session.
    planRestrictedSessionRebuildBackoff.cancel();
    // Reaching Retry means the seeded open failed; drop only the seed. A host named through `openOnOriginalHost` stays.
    if (seededCreateHostRef.current) {
      seededCreateHostRef.current = false;
      setRequestedHostId(null);
    }
    setRetryGeneration((generation) => generation + 1);
  }, [planRestrictedSessionRebuildBackoff]);
  const openOnOriginalHost = useCallback((): void => {
    const originalHostId = originalHostIdRef.current;
    if (originalHostId === null) return;
    planRestrictedSessionRebuildBackoff.cancel();
    // An explicit request replaces the seed: a later derivation move must not take it back.
    seededCreateHostRef.current = false;
    setRequestedHostId(originalHostId);
    setRetryGeneration((generation) => generation + 1);
  }, [planRestrictedSessionRebuildBackoff]);

  // Give up the create-host seed on a derivation move, not a timer: expiry would re-point a healthy session. `null` is detached, not a move.
  const lastEffectiveHostIdRef = useRef<string | null>(effectiveHostId);
  useEffect(() => {
    if (effectiveHostId === null) return;
    const previous = lastEffectiveHostIdRef.current;
    lastEffectiveHostIdRef.current = effectiveHostId;
    if (previous === null || previous === effectiveHostId) return;
    if (!seededCreateHostRef.current) return;
    seededCreateHostRef.current = false;
    setRequestedHostId(null);
  }, [effectiveHostId]);

  // Hold `establishing` until the authority attaches; fail only once attached and still host-less.
  // Own effect so attach churn cannot dispose a mid-establish handle.
  useEffect(() => {
    if (!ownershipClaimed) return;
    if (targetHostId !== null) return;
    const presentGap = (): void => {
      presentSession({
        kind: "failed",
        targetHostId: null,
        originalHostId: originalHostIdRef.current,
      });
    };
    if (authorityAttached) {
      presentGap();
      return;
    }
    presentSession({
      kind: "establishing",
      targetHostId: null,
      originalHostId: originalHostIdRef.current,
    });
    const deadline = window.setTimeout(presentGap, ESTABLISHING_DEADLINE_MS);
    return () => {
      window.clearTimeout(deadline);
    };
  }, [
    authorityAttached,
    ownershipClaimed,
    presentSession,
    retryGeneration,
    targetHostId,
  ]);

  useEffect(() => {
    if (!ownershipClaimed) return;
    // The effect above owns the null-host shell; acquisition needs a concrete `hostId`.
    if (targetHostId === null) return;
    const lifecycle = { cancelled: false };
    const registry = getOpenEpicRegistry();
    const handleSessionAuthError = (): void => {
      onAuthError();
    };
    const createHandle = (): OpenEpicStoreHandle => {
      // This handle's host, captured now: after a re-point `targetHostId` would mean the provider's new target.
      const handleHostId = targetHostId;
      // Before the store exists: `persist` reads its key at creation, and re-keying without this resets focus state on upgrade.
      if (sessionUserId !== null) adoptLegacyOpenEpicKey(sessionUserId);
      // Session owns one transport, always opened here before any client. Tests supply a fake transport at this opener, not a stream-factory override.
      const transport = openTransport(targetHostId);
      const wsStreamClient = transport.wsStreamClient;
      let transportClosed = false;
      let pendingTransportCloseTrigger: EpicSessionTransportCloseTrigger | null =
        null;
      let detachSessionHealthy: (() => void) | null = null;
      // Slot filled once the handle exists: `onClosed` does not retro-fire, so a construction-time deadline would be lost if attached later.
      let reprobeHandle: OpenEpicStoreHandle | null = null;
      const detachReprobe = attachPlanRestrictedReprobe(wsStreamClient, () => {
        const deniedHandle = reprobeHandle;
        if (deniedHandle === null) return;
        planRestrictedSessionRebuildBackoff.request(deniedHandle, () => {
          // Capture this exact owner so a delayed rung cannot call through a newer handle's slot.
          deniedHandle.retryTransport();
        });
      });
      const closeSessionTransport = (
        fallbackTrigger: EpicSessionTransportCloseTrigger,
      ): void => {
        if (transportClosed) return;
        transportClosed = true;
        // Before `transport.close()`, so the timer cannot outlive the socket it exists to rebuild.
        detachReprobe();
        detachSessionHealthy?.();
        detachSessionHealthy = null;
        // Transport tears down wake/endpoint wiring before closing. Keep the `durable-transport-closed` prefix for log searches.
        const trigger = pendingTransportCloseTrigger ?? fallbackTrigger;
        transport.closeWithReason(`durable-transport-closed:${trigger}`);
      };
      // Close the transport on any throw between open and a handle that owns close; otherwise the socket stays dialling for the window lifetime.
      try {
        // Accounting on main: the worker reports into this port over the bridge.
        const accounting = createProcessBackedAccountingPort({
          hostId: targetHostId,
          epicId,
          environment: createRendererRuntimeEnvironment(),
        });

        // Buffers publications until the store exists. `null` from the parser means "foreign payload", never "no target yet".
        const projection = createLateBoundProjectionTarget<
          Partial<EpicRuntimeProjection>
        >(
          (value) => (isProjectionPatch(value) ? value : null),
          (reason, revision) => {
            appLogger.warn(
              "[open-epic] dropped a projection publication before attach",
              { epicId, reason, revision },
            );
          },
        );
        // Body return is not buffered: materialize is issued by the store-built lease bridge, so no publication can precede the store.
        let bodyTarget: EpicRuntimeBodyReturnTarget | null = null;

        // Created before spawn: a protocol-mismatch fatal arrives synchronously from inside `spawnEpicRuntimeWorker`.
        const liveness = { dead: false };

        const runtimeWorker = spawnEpicRuntimeWorker<
          Partial<EpicRuntimeProjection>
        >({
          createWorker: getEpicRuntimeWorkerFactory(),
          relay: {
            log: (entry) => {
              // Map worker levels onto this logger; `debug` is the floor so relocated chatter is not an error.
              if (entry.level === "error") {
                appLogger.error(entry.message, entry.fields, entry.error);
                return;
              }
              if (entry.level === "warn") {
                appLogger.warn(entry.message, entry.fields);
                return;
              }
              appLogger.debug(entry.message, entry.fields);
            },
            fatal: (message, stack) => {
              // Runtime is gone; present `failed` so Retry exists. Mark dead rather than dispose here (may run inside a registry acquire).
              appLogger.error(
                "[epic-session] runtime worker fatal",
                { epicId },
                { message, stack },
              );
              liveness.dead = true;
              presentSession({
                kind: "failed",
                targetHostId,
                originalHostId: originalHostIdRef.current,
              });
            },
          },
          // Classify on main: an `Error` does not survive structured clone.
          writeCommand: async (commandId, intent) => {
            const narrowed = readWriteCommandIntent(intent);
            if (narrowed === null) {
              return {
                ok: false,
                failure: {
                  kind: "rejected",
                  resolution: {
                    kind: "rejected",
                    code: "RPC_ERROR",
                    reason: "unrecognised write command intent",
                    retryable: false,
                  },
                },
              };
            }
            try {
              const sent = await dispatchEpicWriteCommand(
                {
                  epicId,
                  requester: () => getRequesterForHostId(handleHostId),
                },
                commandId,
                narrowed,
              );
              return { ok: true, hostId: sent.hostId };
            } catch (cause: unknown) {
              return {
                ok: false,
                failure: classifyEpicWriteCommandFailure(cause),
              };
            }
          },
          // Reduce on main: an `Error` does not survive structured clone.
          laneUnary: (request) =>
            dispatchEpicLaneUnary(
              { epicId, requester: () => getRequesterForHostId(handleHostId) },
              request,
            ),
          streams: wsStreamClient,
          // Same object as `streams`, narrowed to the two members the manifest is built from.
          methodSupport: wsStreamClient,
          accounting,
          projection: projection.handlers,
          body: {
            applyDocUpdate: (docKey, update) => {
              bodyTarget?.applyDocUpdate(docKey, update);
            },
            applyAwareness: (docKey, frame) => {
              bodyTarget?.applyAwareness(docKey, frame);
            },
          },
          epicId,
          // Host this session was established against; the worker write-command queue uses it as its send gate.
          hostId: targetHostId,
          windowLabel: epicId,
        });

        const created = createOpenEpicStore({
          epicId,
          userId: sessionUserId,
          // Same host as the runtime binding, for the registry cap-guard.
          hostId: handleHostId,
          accounting,
          // Store decides whether a rebuild is lossy; this decides how. Mark dead so acquire retires the closed handle. No presentation here.
          onRetryTransport: () => {
            liveness.dead = true;
            setRetryGeneration((generation) => generation + 1);
          },
          runtime: {
            port: runtimeWorker.port,
            command: (command) => {
              runtimeWorker.command(command);
            },
            awarenessOut: (docKey, frame, localClientId) => {
              runtimeWorker.awarenessOut(docKey, frame, localClientId);
            },
            currentUser: (nextUserId) => {
              runtimeWorker.currentUser(nextUserId);
            },
            detach: () => {
              runtimeWorker.detach();
            },
            dispose: () => {
              runtimeWorker.dispose();
            },
          },
        });
        projection.attach(created.projection);
        bodyTarget = created.body;

        // UNAUTHORIZED revalidate from the projection. Do not unsubscribe: the store's lifetime is the subscription's.
        let revalidatedForUnauthorized = false;
        created.store.subscribe((state) => {
          if (state.snapshotFetchError?.code !== "UNAUTHORIZED") {
            // Re-arm once the error clears so a later UNAUTHORIZED still reaches the net.
            revalidatedForUnauthorized = false;
            return;
          }
          // Projection republishes on every publish, not only on change.
          if (revalidatedForUnauthorized) return;
          revalidatedForUnauthorized = true;
          handleSessionAuthError();
        });
        const noteSessionHealth = (state: OpenEpicState): void => {
          if (!state.snapshotLoaded || state.hostTransportStatus !== "open") {
            return;
          }
          // Only a loaded replica on an open transport proves a previous plan denial ended.
          planRestrictedSessionRebuildBackoff.markHealthy();
        };
        detachSessionHealthy = created.store.subscribe(noteSessionHealth);
        noteSessionHealth(created.store.getState());

        // Stamp once: a drifting label routes RPCs to a host that does not own the stream. Dispose and detachTransport both close this transport.
        const handle: OpenEpicStoreHandle = {
          ...created,
          dispose: () => {
            created.dispose();
            closeSessionTransport("tab-close");
          },
          detachTransport: () => {
            created.detachTransport();
            closeSessionTransport("repoint");
          },
        };
        // Stamp the wrapper that escapes, not the inner store: `handleHostIds` is keyed by identity.
        handleHostIds.set(handle, targetHostId);
        // `retryTransport` is the wrapper's: a reprobe that rebuilt the inner store would leave the socket behind.
        reprobeHandle = handle;
        // Same cell the fatal relay writes, so a death before this line is already recorded.
        trackEpicSessionHandleLiveness(handle, liveness);
        trackEpicSessionTransportCloseAttribution(handle, (trigger) => {
          // Most specific product intent first; first-wins through the later onBeforeDispose callback.
          if (pendingTransportCloseTrigger === null) {
            pendingTransportCloseTrigger = trigger;
          }
        });
        return handle;
      } catch (error: unknown) {
        // Idempotent, so a later `dispose` on a handle that never escaped cannot double-close.
        closeSessionTransport("construction-failed");
        throw error;
      }
    };
    let current = sessionRef.current;
    // A dead runtime is not a session. Forget this provider's reference only; `acquireMounted` owns retirement.
    if (current !== null && isEpicSessionHandleDead(current.handle)) {
      sessionRef.current = null;
      setSession(null);
      current = null;
    }
    const ownerIdentityVerdict = readOwnerIdentityVerdict(
      current,
      ownerIdentityKey,
      ownerIdentityKeyHostId,
    );
    if (ownerIdentityVerdict.kind === "completed") {
      // Continue to the host comparison; returning would park an adopted session on its old host. Honest by construction, so it does not route through `ownerIdentityKeyForHost`.
      current = ownerIdentityVerdict.session;
      sessionRef.current = current;
      setSession(current);
    }
    if (
      current === null ||
      current.handle.userId !== sessionUserId ||
      ownerIdentityVerdict.kind === "rotated"
    ) {
      // Identity changes are security boundaries: discard on userId change, keep buffers on owner-key rotation (same person, different host key).
      if (current !== null) {
        const discarding = current.handle.userId !== sessionUserId;
        if (discarding) {
          registry.releaseForSignOut(epicId, "discard", null);
        } else {
          registry.releaseForRetryRebuild(epicId, "keep", {
            // Rotation is not a user change: retain under the old owner key so re-enrollment does not destroy unsynced edits.
            hostStamp: current.hostId,
            ownerIdentityKey: current.ownerIdentityKey,
          });
        }
      }
      // Catch Worker construction failure and present `failed` so Retry survives. Do not wrap the stamp check below; a missing stamp is fail-loud.
      let nextHandle: OpenEpicStoreHandle;
      try {
        nextHandle = registry.acquireMounted(epicId, createHandle);
      } catch (error: unknown) {
        appLogger.error(
          "epic session worker failed to start",
          { epicId },
          error instanceof Error ? error : new Error(String(error)),
        );
        presentSession({
          kind: "failed",
          targetHostId,
          originalHostId: originalHostIdRef.current,
        });
        return;
      }
      // Record the construction stamp, not `targetHostId`: a warm handle may be bound elsewhere. A missing stamp is a broken write-once invariant.
      const stampedHostId = requireConstructionHostStamp(nextHandle);
      const nextSession = {
        handle: nextHandle,
        hostId: stampedHostId,
        ownerIdentityKey: ownerIdentityKeyForHost(
          stampedHostId,
          ownerIdentityKey,
          ownerIdentityKeyHostId,
        ),
      };
      sessionRef.current = nextSession;
      // "Open on original host" must name a host this session actually served, including a warm adoption's bound host.
      if (originalHostIdRef.current === null) {
        originalHostIdRef.current = nextSession.hostId;
      }
      // Publish the handle on a microtask so consumers do not eager-read before a snapshot can apply. `sessionRef` still updates synchronously.
      queueMicrotask(() => {
        if (lifecycle.cancelled) return;
        setSession(nextSession);
      });
      presentSession({
        kind: "ready",
        targetHostId,
        originalHostId: originalHostIdRef.current,
      });
      return;
    }
    if (current.hostId === targetHostId) {
      presentSession({
        kind: "ready",
        targetHostId,
        originalHostId: originalHostIdRef.current,
      });
      return;
    }

    // Previous handle stays registered and rendered; the successor stays outside the registry until a complete snapshot can replace atomically.
    const nextHandle = createHandle();
    const disposeRepointCandidate = (): void => {
      attributeEpicSessionTransportClose(nextHandle, "repoint");
      nextHandle.dispose();
    };
    presentSession({
      kind: "establishing",
      targetHostId,
      originalHostId: originalHostIdRef.current,
    });
    let settled = false;
    const disposePending = (): void => {
      if (settled) return;
      settled = true;
      disposeRepointCandidate();
    };
    // Two tabs can share the mounted handle; a re-point race loser must adopt the winner, not sit on `establishing` forever.
    const adoptWinner = (winner: OpenEpicStoreHandle): void => {
      settled = true;
      disposeRepointCandidate();
      // `peek` does not retire a dead entry; present `failed` so Retry exists rather than `ready` on a corpse.
      if (isEpicSessionHandleDead(winner)) {
        presentSession({
          kind: "failed",
          targetHostId,
          originalHostId: originalHostIdRef.current,
        });
        return;
      }
      const stampedHostId = requireConstructionHostStamp(winner);
      const nextSession = {
        handle: winner,
        hostId: stampedHostId,
        ownerIdentityKey: ownerIdentityKeyForHost(
          stampedHostId,
          ownerIdentityKey,
          ownerIdentityKeyHostId,
        ),
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (stampedHostId === targetHostId) {
        presentSession({
          kind: "ready",
          targetHostId,
          originalHostId: originalHostIdRef.current,
        });
      }
    };
    const commitReplacement = (): void => {
      if (lifecycle.cancelled || settled) return;
      if (sessionRef.current !== current) {
        disposePending();
        return;
      }
      // Woken by the registry as well as the candidate store, so a sibling's win is seen the moment it lands.
      const mounted = registry.peek(epicId);
      if (
        mounted !== null &&
        mounted !== current.handle &&
        mounted !== nextHandle
      ) {
        adoptWinner(mounted);
        return;
      }
      if (!nextHandle.store.getState().snapshotLoaded) return;
      settled = true;
      const previousRoomId =
        current.handle.store.getState().snapshotMeta?.roomId;
      const nextRoomId = nextHandle.store.getState().snapshotMeta?.roomId;
      // Whether to attempt the transfer, not whether it happened: the merge is now a worker round trip.
      const shouldTransferEdits = shouldMergeEpicRoomSwap(
        { roomId: previousRoomId },
        { roomId: nextRoomId },
      );
      // Pass already-narrowed values into the tail: TypeScript cannot carry a narrowing across an `await`.
      void transferThenComplete(shouldTransferEdits, current, targetHostId);
    };

    async function transferThenComplete(
      shouldTransferEdits: boolean,
      outgoing: MountedSessionState,
      hostId: string,
    ): Promise<void> {
      let editsTransferredToReplacement = false;
      // Re-read the candidate arm across every await. A lane or still-null arm cannot carry a root transfer, so retain the outgoing handle.
      const destinationCarriesRootWrites = (): boolean =>
        armCarriesRootWrites(nextHandle.store.getState().installedArm);
      if (shouldTransferEdits && destinationCarriesRootWrites()) {
        try {
          const update = await outgoing.handle.encodeRootState();
          // `true`: LOCAL_ORIGIN, so unacknowledged edits survive for recovery.
          editsTransferredToReplacement =
            destinationCarriesRootWrites() &&
            (await nextHandle.applyRootUpdate(update, true)) &&
            destinationCarriesRootWrites();
        } catch {
          // Failed transfer: edits still live only in the outgoing handle; still tell `replaceMounted`.
          editsTransferredToReplacement = false;
        }
      }
      if (lifecycle.cancelled) {
        // `settled` already disarmed cleanup; this function owns `nextHandle` on every exit, including cancel after an await.
        disposeRepointCandidate();
        return;
      }
      // The candidate can fatal during the await; do not install a corpse or overwrite `failed` with `ready`.
      if (isEpicSessionHandleDead(nextHandle)) {
        disposeRepointCandidate();
        presentSession({
          kind: "failed",
          targetHostId: hostId,
          originalHostId: originalHostIdRef.current,
        });
        return;
      }
      // Retention identity from the construction stamp, plus the merge outcome, so two hosts' unsynced edits never share one document.
      const previousDisposition = {
        hostStamp: getEpicSessionHandleHostId(outgoing.handle),
        ownerIdentityKey: outgoing.ownerIdentityKey,
        editsTransferredToReplacement,
      };
      const replaced = registry.replaceMounted(
        epicId,
        outgoing.handle,
        nextHandle,
        previousDisposition,
      );
      if (!replaced) {
        // Lost the peek-to-replace race: adopt a sibling winner, otherwise present `failed` so Retry exists.
        const winner = registry.peek(epicId);
        if (winner !== null && winner !== outgoing.handle) {
          adoptWinner(winner);
          return;
        }
        disposeRepointCandidate();
        presentSession({
          kind: "failed",
          targetHostId: hostId,
          originalHostId: originalHostIdRef.current,
        });
        return;
      }
      const nextSession = {
        handle: nextHandle,
        hostId: hostId,
        // Record honest-absent for the new host; recording the previous host's key would rebuild the handle that just received the merge.
        ownerIdentityKey: ownerIdentityKeyForHost(
          hostId,
          ownerIdentityKey,
          ownerIdentityKeyHostId,
        ),
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      presentSession({
        kind: "ready",
        targetHostId: hostId,
        originalHostId: originalHostIdRef.current,
      });
    }

    const unsubscribe = nextHandle.store.subscribe(commitReplacement);
    const unsubscribeRegistry = registry.subscribe(commitReplacement);
    const deadline = window.setTimeout(() => {
      if (lifecycle.cancelled || settled) return;
      disposePending();
      presentSession({
        kind: "failed",
        targetHostId,
        originalHostId: originalHostIdRef.current,
      });
    }, ESTABLISHING_DEADLINE_MS);
    commitReplacement();

    return () => {
      lifecycle.cancelled = true;
      window.clearTimeout(deadline);
      unsubscribe();
      unsubscribeRegistry();
      disposePending();
    };
  }, [
    epicId,
    openTransport,
    ownerIdentityKey,
    ownerIdentityKeyHostId,
    ownershipClaimed,
    planRestrictedSessionRebuildBackoff,
    presentSession,
    sessionUserId,
    targetHostId,
    retryGeneration,
  ]);

  useEffect(() => {
    return () => {
      getOpenEpicRegistry().releaseMounted(epicId);
      sessionRef.current = null;
      originalHostIdRef.current = null;
    };
  }, [epicId]);

  const handle = ownershipClaimed ? (session?.handle ?? null) : null;
  // Stamp the same client the context provides, for imperative callers. Re-stamp on client rotation; host id must not drift.
  useEffect(() => {
    if (handle === null) return;
    handleHostClients.set(handle, resolvedSessionHostClient);
  }, [handle, resolvedSessionHostClient]);
  const sessionPresentation = useMemo(
    () => ({
      ...presentation,
      retry: retryRepoint,
      openOnOriginalHost,
    }),
    [openOnOriginalHost, presentation, retryRepoint],
  );
  useCloudTaskTitleCacheSync({
    activeHostId: session?.hostId ?? null,
    epicId,
    handle,
    queryClient,
    userId: cloudTasksUserId,
  });

  return (
    <EpicSessionContext.Provider value={handle}>
      <EpicSessionPresentationContext.Provider value={sessionPresentation}>
        <EpicSessionHostClientContext.Provider
          value={handle === null ? null : resolvedSessionHostClient}
        >
          {children}
        </EpicSessionHostClientContext.Provider>
      </EpicSessionPresentationContext.Provider>
    </EpicSessionContext.Provider>
  );
}

interface CloudTaskTitleCacheSyncArgs {
  readonly activeHostId: string | null;
  readonly epicId: string;
  readonly handle: OpenEpicStoreHandle | null;
  readonly queryClient: QueryClient | undefined;
  readonly userId: string | null;
}

function useCloudTaskTitleCacheSync(args: CloudTaskTitleCacheSyncArgs): void {
  const { activeHostId, epicId, handle, queryClient, userId } = args;
  useEffect(() => {
    if (activeHostId === null) return;
    if (handle === null) return;
    if (queryClient === undefined) return;
    if (userId === null) return;

    const scope = { hostId: activeHostId, userId };
    let lastObservedTitle: string | null = null;
    const currentTitle = (): string | null =>
      normalizeGeneratedTitle(handle.store.getState().epic.title);
    const writeThroughTitle = (title: string): void => {
      updateEpicTitleInCloudTaskCaches(queryClient, scope, epicId, title);
    };
    const syncChangedTitle = (): void => {
      const title = normalizeGeneratedTitle(handle.store.getState().epic.title);
      if (title === null || title === lastObservedTitle) return;
      lastObservedTitle = title;
      writeThroughTitle(title);
    };
    const syncMatchingQueryUpdate = (event: QueryCacheNotifyEvent): void => {
      if (event.type !== "updated") return;
      const queryKey: unknown = event.query.queryKey;
      if (!Array.isArray(queryKey)) return;
      if (
        !cloudEpicTasksQueryKeyMatchesScope(queryKey, scope) &&
        !epicTaskContextsQueryKeyMatchesScope(queryKey, scope)
      ) {
        return;
      }
      const title = currentTitle();
      if (title !== null) writeThroughTitle(title);
    };

    syncChangedTitle();
    const unsubscribeStore = handle.store.subscribe(syncChangedTitle);
    const unsubscribeQueries = queryClient
      .getQueryCache()
      .subscribe(syncMatchingQueryUpdate);
    return () => {
      unsubscribeStore();
      unsubscribeQueries();
    };
  }, [activeHostId, epicId, handle, queryClient, userId]);
}

function normalizeGeneratedTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}
