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
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
  handleHostClients,
  handleHostIds,
  isEpicSessionHandleDead,
  releaseOpenEpicSessionIfUnused,
  trackEpicSessionHandleLiveness,
} from "@/lib/registries/epic-session-registry";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { shouldMergeEpicRoomSwap } from "@/lib/epics/epic-room-swap";
import { armCarriesRootWrites } from "@/stores/epics/open-epic/runtime/epic-adapter-selection";
import { ESTABLISHING_DEADLINE_MS } from "@/lib/host/bounded-load-budgets";
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

/**
 * What a fresh owner-identity reading means for the session being held.
 *
 * `completed` is deliberately NOT a rebuild: it carries the session forward
 * with the reading filled in.
 */
type OwnerIdentityVerdict =
  | { readonly kind: "stable" }
  | { readonly kind: "completed"; readonly session: MountedSessionState }
  | { readonly kind: "rotated" };

const OWNER_IDENTITY_STABLE: OwnerIdentityVerdict = { kind: "stable" };

/**
 * INVARIANT (R-1): a tuple's `ownerIdentityKey` is the owner identity OF its
 * own `hostId`, and this is the only place that decides what a new reading
 * means for it.
 *
 * The discriminator exists for a same-`hostId` public-key rotation
 * (re-enrollment / corruption recovery - `registerOrAdoptHost` overwrites the
 * key under a stable `hostId`), which `hostId` alone cannot see. Two rules
 * make the comparison honest, and each closes a different failure:
 *
 *  - **Same host, or nothing.** Comparing a key recorded for host A against a
 *    key read from host B is a category error, not a rotation check - and it
 *    fires on exactly the paths where the two legitimately differ (a warm
 *    handle adopted while the window has moved), turning an ordinary re-point
 *    into a hard rebuild that discards the document.
 *  - **An absent reading is not a rotation.** A stored `null` is COMPLETED by
 *    the first real reading rather than treated as a change; a reading that
 *    vanishes (the row is deregistered) is not one either. Without the
 *    completion the stored side stays `null` for ever, "absent is not a
 *    rotation" holds for ever, and the rotation boundary silently dies.
 *
 * `ownerIdentityKeyHostId` is widened to `| null` ONLY because the caller
 * computes it in the component body, above the effect's
 * `targetHostId === null` early return, and TS cannot narrow across that
 * boundary. **The null arm is unreachable from both call sites** - both are
 * straight-line in that effect's body, past its early return, and a tuple's
 * `hostId` is typed `string`. Do not write a fixture for it: it would pass
 * while pinning nothing.
 */
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

/**
 * The honesty rule at RECORDING time, mirroring the comparison above: a key
 * is recorded against a tuple only when it was read off that tuple's own
 * host. Any other reading is recorded as absent - never as a key belonging to
 * a different host, which is the state the invariant exists to exclude.
 *
 * Same widening, same unreachability, as `readOwnerIdentityVerdict` above.
 *
 * APPLIED AT BOTH TUPLE WRITERS - the adoption arm and `commitReplacement`.
 * That is not optional at the second one: the same-host guard checks the host
 * a reading was TAKEN FROM, not the honesty of a record already labelled with
 * this host, so a cross-host record written there passes the guard and reaches
 * the rotation arm, which is exactly the B5 discard. Any third tuple writer
 * must route through here too.
 */
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

/**
 * The handle's construction host stamp, or a throw.
 *
 * ONE copy for the two readers - the acquire arm and `adoptWinner` - which
 * used to carry the same six lines each. The stamp is written once, inside
 * `createHandle`, and it is what routes RPCs and capability answers to the
 * host that owns the stream; substituting the caller's target instead would
 * silently re-create F1, so absence is a thrown invariant rather than a
 * fallback. Reachable only if the write-once invariant broke - this map and
 * the registry that hands back warm handles live in ONE module, so no module
 * replacement can leave a surviving warm handle whose stamp was left behind.
 * That colocation is load-bearing: moving the map elsewhere makes this throw
 * reachable under HMR, which no test can see.
 */
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

  // Opening the task is what retires its imported-unseen dot, and every open
  // path - list click, palette, deep link - mounts this provider.
  useEffect(() => {
    useImportedUnseenStore.getState().markSeen(epicId);
  }, [epicId]);

  // The session OWNS its durable transport: the factory built in the acquire
  // effect opens it (socket + auth + wake) and the returned handle's `close()`
  // tears it down on dispose. A host restart under a STABLE `hostId` is healed
  // by the durable transport itself (live endpoint + wake re-dial), not by a
  // provider-driven re-subscribe; a `hostId` CHANGE releases the session below.
  const openTransport = useDurableStreamTransportFactory();
  const effectiveHostId = useEffectiveHostId();
  const authorityAttached = useSelectionAuthorityAttached();
  // Owner-identity discriminator (R-1): `activeHostId` alone cannot see a
  // same-host remote public-key rotation (re-enrollment / corruption
  // recovery), since the hostId is unchanged. Folded into the rebuild
  // decision below alongside the existing hostId/user checks, not in place
  // of them.
  // One explicit-host resolver per retained Epic surface. Sidebar rows share
  // the result through context instead of each mounting a directory listener,
  // query observer, and transient client for this same host.
  const authService = useAuthService();
  const queryClient = use(QueryClientContext);
  const navigate = useNavigate();
  const desktopBridge = getDesktopEpicOwnershipBridge();
  // The SESSION identity: the handle is stamped with it, persisted state
  // (`lastFocusedArtifactId`) is bucketed under it, and the effect below
  // treats a change in it as a security boundary that DISCARDS the previous
  // session and its retained buffers. It is the canonical `profile.userId`.
  // It used to be the email, which reads like an identity and is not one: two
  // canonical accounts can present the same address, so for that pair the
  // comparison saw no change, the previous user's handle stayed mounted (or
  // the rotation arm chose "keep"), and the incoming account inherited the
  // outgoing account's persisted focus state and retained unsynced `Y.Doc`.
  // Null means signed-out / hydrating.
  const sessionUserId = useAuthStore((state) => state.profile?.userId ?? null);
  // Only to name the pre-userId persist key for one-time adoption below; NOT
  // an identity, and nothing compares on it. Read through an effect event so
  // it is not a dependency of the session effect: it is consulted once, at
  // handle creation, and a change in it must never re-run the session.
  const legacyEmail = useAuthStore((state) => state.profile?.email ?? null);
  const adoptLegacyOpenEpicKey = useEffectEvent((userId: string): void => {
    // Both non-null, explicitly: `openEpicKey(null, …)` is the ANONYMOUS
    // bucket, and adopting that into an account's bucket would be its own
    // leak. `email` is a string on every present profile, so this guard is
    // stating the invariant rather than expecting the arm.
    if (legacyEmail === null) return;
    adoptLegacyPersistedKey(
      openEpicKey(userId, epicId),
      openEpicKey(legacyEmail, epicId),
    );
  });
  const cloudTasksUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );

  // When the host terminates the epic stream with `UNAUTHORIZED`, the
  // current context bearer is no longer accepted. Re-validate the live
  // RequestContext: AuthnV3 either confirms/rotates it (transient host
  // miss; a future reconnect will succeed) or rejects it (cascade to sign-out
  // so the user can re-authenticate). This is an event emitted by the acquired
  // session, not a reason to reacquire the session if the auth service object
  // changes identity.
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

  // Desktop only: claim single-window ownership before acquiring a live epic
  // session. The provider still renders its children while this guard runs;
  // session-bound slots see a null context and show their own loading content.
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
      // Another window owns this TAB, so this one navigates away. Not "another
      // window has this epic open": `EpicWindowOwnership.claim` keys on
      // `tabId` and stores `epicId` without ever comparing it, so a denial
      // means the same tab id exists in two windows (a move/restore race).
      // Two windows CAN hold the same epic live at once with different tab
      // ids - do not reason about retention scoping as one session per epic.
      //
      // Involuntary either way - no confirmation was shown - so retained
      // buffers stay. They remain reachable through the unsynced-edits
      // projection, which reports retentions whose live session is gone.
      //
      // ...and IF NO OTHER TAB IN THIS WINDOW STILL SHOWS THE EPIC. The
      // paragraph above establishes that a denial is about a TAB and that one
      // window can hold the same epic in two of them; releasing straight
      // through the epic-keyed registry then contradicted it on the very next
      // line, disposing the live session under a tab that was never denied
      // anything. `discardTabState(tabId)` above has already removed this tab,
      // so the question this asks is exactly "does another one still hold it".
      // `null`: this window lost the epic to ANOTHER window, which opens its
      // own session against the same room, and a retention here would surface
      // in this window's quit sheet as work it can never flush - it has no
      // ownership left to flush with. Deliberately unchanged by the rotation
      // fix below, whose loss had no such continuation.
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
  // Seeded from the create-host memory for an epic THIS renderer just
  // created: `epic.create` is local-first on the create host - the cloud
  // record is written by that host's deferred background connect - so until
  // it lands, the create host is the only machine that can serve the epic.
  // Opening on `effectiveHostId` in that window cold-opens into a cloud
  // NOT_FOUND, which the access coordinator reads as an adjudicated "epic is
  // gone" and force-closes the brand-new tab. The seed is time-bounded (see
  // `sessionCreatedEpicHostId`), so later opens of the same epic follow the
  // effective host as before - and within this mount it is given up on the
  // first derivation move (see `seededCreateHostRef` below), so it never
  // outranks an activation or a failover.
  const [requestedHostId, setRequestedHostId] = useState<string | null>(() =>
    sessionCreatedEpicHostId(epicId),
  );
  // Whether `requestedHostId` is still that SEED rather than a host the user
  // asked for through `openOnOriginalHost`. Only the seed is given up, and on
  // any of the three signals that the create race is no longer what decides
  // placement: a derivation move, a Retry, or the user naming a host. An
  // explicit request is the user's and outlives all of them, exactly as it
  // did before this seed existed.
  const seededCreateHostRef = useRef(requestedHostId !== null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [presentation, setPresentation] = useState<SessionPresentationState>({
    kind: "establishing",
    targetHostId: requestedHostId ?? effectiveHostId,
    originalHostId: null,
  });
  const targetHostId = requestedHostId ?? effectiveHostId;
  const resolvedSessionHostClient = useHostClientForHostId(
    session?.hostId ?? targetHostId,
  );
  // The client for the host this provider is currently POINTING at, which is
  // NOT the one above while a re-point is establishing: `session` still names
  // the outgoing host then, so that read answers for it and nothing else in
  // the render path resolves the incoming one at all.
  const resolvedTargetHostClient = useHostClientForHostId(targetHostId);
  // Read through an effect event so it is not a dependency of the session
  // effect: a handle's requester is consulted per call, and these clients
  // legitimately rotate (reconnect, identity re-point) without that being a
  // reason to tear down and reacquire the session.
  //
  // Resolved BY HOST ID rather than from one "the session's client" read,
  // because TWO handles are live at once during a re-point. The previous
  // handle stays registered and RENDERED while its successor establishes, and
  // the successor's `attach()` starts the tab-open workspace-context read
  // (`epic-lane-arm.ts`) BEFORE `commitReplacement` can run - which is gated
  // on that candidate's own `snapshotLoaded`. So the single read sent the
  // candidate's `epic.getWorkspaceContext` to A while its streams, its
  // accounting stamp and its worker bootstrap all said B, with no post-commit
  // refetch to correct it. `bridge-protocol.ts`'s "a worker never serves two
  // hosts" is the invariant that broke.
  //
  // NOT `targetHostId` unconditionally either. The outgoing handle is still
  // mounted and still issuing writes on behalf of the rows it projected, and
  // re-aiming it at the incoming host is the same cross-host send pointed the
  // other way.
  const getRequesterForHostId = useEffectEvent(
    (hostId: string): HostClient<HostRpcRegistry> | null => {
      if (hostId === targetHostId) return resolvedTargetHostClient;
      if (session !== null && hostId === session.hostId) {
        return resolvedSessionHostClient;
      }
      // A handle whose construction host is neither the host this provider is
      // pointing at nor the one it is currently serving has been superseded.
      // REFUSING is the point rather than a gap: both dispatchers answer a
      // `null` requester with a refusal the caller can see, where falling back
      // to "whatever is live" would BE the cross-host send.
      return null;
    },
  );
  // Owner-identity discriminator (R-1), read off THE SESSION'S host - the same
  // client the stream runs on, not the app-wide one.
  //
  // It used to be read off the spine, which answered from the active slot, so
  // it always described whichever host was effective. That is only the same
  // host while the session is UNPINNED: `targetHostId` is
  // `requestedHostId ?? effectiveHostId`, so a retried or cloned session runs
  // against a host the effective pointer is not naming. There the old read was
  // wrong in both directions - a key rotation on the session's own host went
  // unseen (the one thing this discriminator exists to catch, since `hostId`
  // is unchanged), while a rotation on an unrelated effective host tripped the
  // comparison below, which discards a live stream. Sessions are
  // placement-bound, and this file's own rule decides it: identity changes are
  // security boundaries, not re-points. P4.2 deleted the slot, so the read had
  // to move; it moves to the host whose identity it is describing.
  const ownerIdentityKey = useReactiveOwnerIdentityKey(
    resolvedSessionHostClient,
  );
  // The host the reading above DESCRIBES - captured from the same expression
  // the client resolver consumed, so the pairing cannot drift. The acquire
  // effect's honesty rule compares against THIS value, never `sessionRef`:
  // the ref updates synchronously while `session` state publishes on a
  // microtask, so the two can disagree within one run, and pairing the key
  // with a host the hook never read is exactly the cross-host recording the
  // rule exists to prevent.
  const ownerIdentityKeyHostId = session?.hostId ?? targetHostId;

  // Presentation writes are IDEMPOTENT by value. The acquire effect re-runs
  // whenever any of its dependencies churn - `openTransport` is a hook result,
  // and only the real hook's referential stability keeps that from happening on
  // every commit - and an effect that unconditionally stores a fresh object is
  // then an infinite render loop rather than a wasted render. Nothing about
  // this provider's correctness needs the churn, so it is refused here once
  // instead of relying on every producer upstream to stay stable.
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
    // Reaching Retry means the seeded open FAILED at the one job the seed
    // has, so give it up here too. Without this the seed survives a create
    // host that died while `effectiveHostId` never moved - the derivation
    // move below is then never observed - and Retry re-dials the dead host
    // for as long as the user keeps pressing it, where an UNSEEDED session
    // would have re-dialed the live effective host. Only the seed is
    // dropped; a host the user named through `openOnOriginalHost` is what
    // they are retrying, so it stays.
    if (seededCreateHostRef.current) {
      seededCreateHostRef.current = false;
      setRequestedHostId(null);
    }
    setRetryGeneration((generation) => generation + 1);
  }, []);
  const openOnOriginalHost = useCallback((): void => {
    const originalHostId = originalHostIdRef.current;
    if (originalHostId === null) return;
    // An explicit request replaces the seed and stops being one: the user
    // named this host, so a later derivation move must not silently take it
    // back the way it takes back the create-host seed.
    seededCreateHostRef.current = false;
    setRequestedHostId(originalHostId);
    setRetryGeneration((generation) => generation + 1);
  }, []);

  // The create-host seed answers ONE question - which host can serve this epic
  // while its cloud record is still being written - and that question is
  // settled in seconds. It must not also outrank a later derivation move: an
  // unseeded session re-points when `effectiveHostId` changes (Settings ▸
  // Activate, or a failover), and a session that merely STARTED on its create
  // host has no standing to refuse that.
  //
  // Given up on the move, not on a timer. Expiring the seed on its own clock
  // would re-point a healthy session for no reason at the two-minute mark -
  // the create host and the effective host differ by construction in the case
  // this seed exists for, so a bare expiry IS a re-point. `null` is the
  // authority's DETACHED default rather than a move, so the first non-null
  // answer is adopted as the baseline instead of acted on.
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

  // A selection gap must be visible: the old provider silently bailed and left
  // the task permanently skeleton-bound. But the authority's `null` carries TWO
  // meanings and only one of them is a gap - until this window's kernel has
  // ATTACHED, `effectiveHostId` is null because nobody has answered yet (the
  // store's DETACHED default), not because nothing is usable. The bridge mounts
  // in an effect ABOVE this provider and React runs child effects first, so
  // presenting the failure on sight flashes "couldn't load this task" on every
  // cold open, before the authority has spoken. Hold `establishing` while
  // detached - bounded by the same deadline, since invariant 6 does not exempt
  // a bridge that never attaches - and fail immediately only once the authority
  // IS attached and still names no usable host.
  //
  // Deliberately its own effect: `authorityAttached` must not join the acquire
  // effect's dependencies, where a detach/reattach would dispose a replacement
  // handle that is mid-establish.
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
    // The effect above owns what the shell shows for a null host; acquisition
    // needs a concrete `hostId` and has nothing to do until one arrives.
    if (targetHostId === null) return;
    const lifecycle = { cancelled: false };
    const registry = getOpenEpicRegistry();
    const handleSessionAuthError = (): void => {
      onAuthError();
    };
    const createHandle = (): OpenEpicStoreHandle => {
      // The host THIS handle is constructed against: an alias for the run's
      // `targetHostId`, which is already the value the transport below is
      // opened with, the accounting port is built with, and the construction
      // stamp is written from. Named separately because the requester it feeds
      // has to keep meaning THE HANDLE'S host after the provider has re-pointed
      // away from it - a bare `targetHostId` there reads as the provider's
      // current target and is the same defect one re-point later.
      const handleHostId = targetHostId;
      // Before the store exists, because `persist` reads its key at creation:
      // the bucket used to be named by the email, and re-keying without this
      // would silently reset every install's focus state on upgrade.
      if (sessionUserId !== null) adoptLegacyOpenEpicKey(sessionUserId);
      // ── The session's ONE transport ──────────────────────────────────────
      //
      // The session OWNS its transport, and now literally rather than by there
      // happening to be a single client. Every stream client this session
      // builds - the `@1` arm, the records lane, the control lane, and the
      // per-artifact body lanes - rides THIS transport's `wsStreamClient`,
      // because `WsStreamClient` multiplexes methods over one socket and
      // `openTransport` is not pooled. Opening one transport per client would
      // give an epic two sockets on the lane arm and one more per open tile,
      // which is worse than the `@1` monolith on exactly the axis the lane
      // cutover exists to improve.
      //
      // It is opened HERE, before any client, because adapter selection reads
      // this connection's negotiated method support off it and has to do so
      // before deciding what to open. The registry only closes the handle when
      // it DISPOSES the session, so the socket survives the MRU warm window;
      // the durable transport's live endpoint + wake re-dial heal a host
      // restart under a stable `hostId` on their own, and one reconnect now
      // resumes every client riding it rather than one client each. A revived
      // session is a NEW handle and therefore a new transport - this one is
      // never handed on.
      //
      // ALWAYS opened. There used to be a branch here that skipped the
      // transport when a test had installed a stream-factory override, on the
      // reasoning that "the override IS a test supplying this session's
      // stream". That branch produced a null `wsStreamClient` and the guard
      // below then threw unconditionally, so installing the override could not
      // do anything except fail - two comments in this one function stating
      // opposite contracts, with the code implementing both.
      //
      // The seam that survives the relocation is the WORKER factory, not the
      // stream factory: the worker builds its own typed clients over a proxied
      // `IStreamClient`, and a factory constructed on MAIN cannot cross
      // `postMessage` to reach it. A suite that wants to drive this session's
      // stream supplies a fake TRANSPORT at this opener instead, and gets the
      // real proxy path underneath it.
      const transport = openTransport(targetHostId);
      const wsStreamClient = transport.wsStreamClient;
      let transportClosed = false;
      const closeSessionTransport = (): void => {
        if (transportClosed) return;
        transportClosed = true;
        transport.close();
      };
      // EVERY construction between opening the transport and returning a
      // handle that owns its close. A synchronous throw anywhere in here -
      // `new Worker` refused by the runtime or CSP, an emitted worker URL
      // that will not load, an accounting port that cannot be built -
      // propagated with the transport already open and NO handle in
      // existence, so neither `dispose` nor `detachTransport` could ever
      // reach `closeSessionTransport` and the socket stayed dialling for
      // the life of the window. The epic also failed outside the `failed`
      // presentation, which is the state carrying the Retry affordance.
      //
      // Scoped to the whole span rather than to the worker spawn the
      // symptom pointed at: the leak is a property of the WINDOW between
      // acquiring the socket and handing back its owner, not of any one
      // call inside it.
      try {
        // The four typed stream clients are NOT built here any more. They are
        // the method-typed zod decode this relocation exists to move, so the
        // worker builds them itself over its proxied `IStreamClient`
        // (`buildProxiedStreamFactories`). What crosses is this session's real
        // `wsStreamClient`, whose socket never leaves this thread.
        //
        // There is deliberately no "no transport" guard left. One stood here and
        // threw, which was the right posture while a branch above could produce a
        // null client; with that branch gone, `DurableStreamTransport` declares
        // `wsStreamClient` non-nullable and the check became unreachable - and a
        // dead `=== null` is what `no-unnecessary-condition` exists to reject.
        // The property is carried by the TYPE now, which is the stronger form of
        // the same guarantee: a runtime throw catches a null that reaches it,
        // whereas this one cannot be constructed.

        /**
         * The books, on MAIN, and the one set for this session.
         *
         * Built here rather than in the store because the worker reports into
         * them too, over the bridge - so the composition that spawns the worker
         * is the composition that owns them.
         */
        const accounting = createProcessBackedAccountingPort({
          hostId: targetHostId,
          epicId,
          environment: createRendererRuntimeEnvironment(),
        });

        /**
         * The projection handlers, filled once the store exists.
         *
         * A slot because the two constructions are mutually dependent: the
         * spawner reduces into handlers only the store can supply, and the store
         * needs the port only the spawner can hand back. The worker cannot
         * publish before its bootstrap is answered, and that happens after both
         * lines below - so the window where this is `null` carries no traffic.
         * It is still checked rather than asserted, because "cannot happen" is
         * not a thing this file gets to claim about another thread.
         */
        // Buffers publications made before the store exists, and answers
        // `accept` from a pure parser so a `null` there means "foreign payload"
        // and never "no target yet". The worker composes and starts INSIDE the
        // spawn below, so that window carries real traffic.
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
        /**
         * The body plane's return leg, filled on the same line as the one above
         * and `null` for the same window. The store owns the live body docs, so
         * this is mutually dependent with the spawn in exactly the way the
         * projection slot is.
         */
        // NOT buffered, and derived rather than assumed. The body return leg
        // publishes only from observers attached inside the `body/materialize`
        // handler (`epic-runtime-core-ports.ts` - both call sites, the cold arm
        // and the forward-only one). A materialize is a CALL issued by the lease
        // bridge, and the lease bridge is built by the store - so no body
        // publication can precede the store, and this slot has no gap to lose
        // traffic in. Contrast the projection slot above, whose producer runs
        // during composition.
        let bodyTarget: EpicRuntimeBodyReturnTarget | null = null;

        // Created BEFORE the spawn and mapped to the handle after it, because a
        // protocol-mismatch fatal arrives synchronously from inside
        // `spawnEpicRuntimeWorker` - before `handle` exists. See
        // `handleWorkerLiveness` for why this is a cell rather than a set entry.
        const liveness = { dead: false };

        const runtimeWorker = spawnEpicRuntimeWorker<
          Partial<EpicRuntimeProjection>
        >({
          createWorker: getEpicRuntimeWorkerFactory(),
          relay: {
            log: (entry) => {
              // The worker's own level, mapped onto the four this logger has.
              // `debug` is the floor: a relocated module's chatter must not
              // arrive as an error just because it crossed a thread.
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
              // NOT just a log line. The runtime behind the bridge is gone, so a
              // UI waiting on projections would wait forever - the epic reads as
              // permanently loading. Surfaced as `failed`, which is the state
              // that carries a retry affordance.
              appLogger.error(
                "[epic-session] runtime worker fatal",
                { epicId },
                { message, stack },
              );
              // RECORDED, not acted on. `failed` is the presentation that carries
              // the Retry affordance, and Retry alone could not recover: it bumps
              // `retryGeneration`, the acquire effect sees
              // `current.hostId === targetHostId`, and presents this same dead
              // handle as `ready` - the affordance unable to recover from the one
              // failure it is shown for. Marking the handle is what lets that
              // pass retire it instead.
              //
              // Marked rather than disposed HERE because this runs on a bridge
              // callback that can be inside the registry's own acquire
              // transaction; the acquire effect owns registry mutation and reads
              // this on its next pass.
              liveness.dead = true;
              presentSession({
                kind: "failed",
                targetHostId,
                originalHostId: originalHostIdRef.current,
              });
            },
          },
          // Classified HERE, on main: an `Error` does not survive structured
          // clone, so the worker receives the classifier's own union.
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
          // Reduced HERE, on main, for the same reason `writeCommand` is: an
          // `Error` does not survive structured clone.
          laneUnary: (request) =>
            dispatchEpicLaneUnary(
              { epicId, requester: () => getRequesterForHostId(handleHostId) },
              request,
            ),
          streams: wsStreamClient,
          // The SAME object as `streams`, narrowed to the two members the
          // manifest is built from - see the option's own doc for why the two
          // are separate parameters rather than one widened one.
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
          // The host this session was established against, which is the same
          // value the accounting port is built with above. The worker's
          // write-command queue reads it as its send gate - see
          // `RuntimeWorkerBootstrap.hostId`.
          hostId: targetHostId,
          windowLabel: epicId,
        });

        const created = createOpenEpicStore({
          epicId,
          userId: sessionUserId,
          accounting,
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

        /**
         * The UNAUTHORIZED revalidate, delivered by the PROJECTION rather than by
         * a callback.
         *
         * `onAuthError` fired from the control replica, which is worker-side now.
         * Its own comment says what it is: "The stream owns UNAUTHORIZED recovery
         * now: it stays 'reconnecting' and self-revalidates … keep the revalidate
         * as the sign-out cascade's NET (single-flight, a no-op once already
         * settled)." A net whose trigger is single-flight and idempotent does not
         * need callback timing, and the same branch that called it publishes
         * `snapshotFetchError` one line above - so the fact already crosses.
         *
         * Filtered on the CODE. All three branches of that handler publish a
         * snapshot error; only UNAUTHORIZED is the sign-out cascade's business,
         * and triggering a revalidate on an INCOMPATIBLE close would be a second
         * bug wearing this one's clothes.
         */
        // Not unsubscribed explicitly: the subscription's lifetime IS this
        // store's, and the store is what the registry disposes. An unsubscribe
        // held here would be a second lifetime to keep in step with the first.
        let revalidatedForUnauthorized = false;
        created.store.subscribe((state) => {
          if (state.snapshotFetchError?.code !== "UNAUTHORIZED") {
            // Re-armed once the error clears, so a later UNAUTHORIZED after a
            // recovery still reaches the net.
            revalidatedForUnauthorized = false;
            return;
          }
          // The projection republishes on every publish, not only on change, so
          // without this the single-flight would be asked once per slice.
          if (revalidatedForUnauthorized) return;
          revalidatedForUnauthorized = true;
          handleSessionAuthError();
        });

        // Construction-honest stamp, written exactly once: `streamClientFactory`
        // above captures this run's `targetHostId` into the transport it opens,
        // so the stamp IS the handle's transport binding. Nothing re-stamps a
        // live handle - a label that can drift from the binding routes RPCs and
        // capability answers to a host that does not own the stream (F1).
        // The transport outlives every client on it, so the two lifetimes that
        // end the session have to close it: dispose (the registry evicting) and
        // detachTransport (a retained-dirty buffer that must stop dialling a host
        // this window has left). Composed here rather than inside the store
        // because the transport is the PROVIDER's to own - the store knows about
        // clients, not sockets - and idempotently, so either path may run first
        // or both may run.
        const handle: OpenEpicStoreHandle = {
          ...created,
          dispose: () => {
            created.dispose();
            closeSessionTransport();
          },
          detachTransport: () => {
            created.detachTransport();
            closeSessionTransport();
          },
        };
        // Stamped on the handle that ESCAPES, not on the inner store object:
        // `handleHostIds` is keyed by identity, and stamping `created` while
        // returning a wrapper leaves every lookup answering "no construction host
        // stamp" - which is a thrown invariant, not a silent miss, because the
        // stamp is what routes RPCs and capability answers to the host that owns
        // the stream (F1).
        handleHostIds.set(handle, targetHostId);
        // The same cell the fatal relay above writes, so a death that happened
        // before this line is already recorded on the handle the moment it
        // exists.
        trackEpicSessionHandleLiveness(handle, liveness);
        return handle;
      } catch (error: unknown) {
        // Idempotent, and the handle's own paths are too, so a later
        // `dispose` on a handle that never escaped cannot double-close.
        closeSessionTransport();
        throw error;
      }
    };
    let current = sessionRef.current;
    // A handle whose runtime worker died is not a session; it is a corpse that
    // every arm below would treat as live - the fast path would present it
    // `ready`, and the re-point arm would try to encode a root state out of a
    // bridge with nothing behind it. Forgetting it here is what makes Retry a
    // recovery: the bump re-runs this effect, `current` becomes null, and the
    // acquire arm below runs.
    //
    // FORGETTING ONLY. The retirement belongs to `acquireMounted`, which is the
    // one line that hands a mounted handle out and therefore the only place
    // that can promise every caller a live one - including a fresh surface that
    // never had a `current` to check. Retiring here as well would be a second
    // owner of one decision, and the version that did exactly that is what left
    // the corpse window open for a second tab. What this arm does that the
    // registry cannot is clear THIS provider's own reference.
    if (current !== null && isEpicSessionHandleDead(current.handle)) {
      sessionRef.current = null;
      setSession(null);
      current = null;
    }
    // R-1: see `readOwnerIdentityVerdict` for the invariant this enforces.
    const ownerIdentityVerdict = readOwnerIdentityVerdict(
      current,
      ownerIdentityKey,
      ownerIdentityKeyHostId,
    );
    if (ownerIdentityVerdict.kind === "completed") {
      // A write, not a terminal arm: control continues to the host comparison
      // below in this same run. Returning here would leave an adopted session
      // parked on its old host with every dependency stable and nothing left
      // to trigger the re-point.
      //
      // This is the third tuple writer, and the only one that does NOT route
      // through `ownerIdentityKeyForHost` - deliberately. It is honest by
      // construction: the verdict is built as `{...current, ownerIdentityKey}`
      // and is only reachable after the same-host check inside
      // `readOwnerIdentityVerdict`, so the key provably describes
      // `current.hostId` already. Routing it through the helper would be a
      // no-op that reads as the safety it is not. Any FOURTH writer,
      // assembling a tuple from raw inputs, must route.
      current = ownerIdentityVerdict.session;
      sessionRef.current = current;
      setSession(current);
    }
    if (
      current === null ||
      current.handle.userId !== sessionUserId ||
      ownerIdentityVerdict.kind === "rotated"
    ) {
      // Identity changes are security boundaries, not re-points: discard the
      // old user/owner session before opening another stream.
      //
      // The two arms differ on RETAINED buffers, so they are decided
      // separately rather than off the OR above. A different `userId` means
      // another person is at the keyboard, and no prior identity's document
      // may survive that - the same policy `disposeAll` applies at sign-out.
      // An owner-identity rotation is not that: it is detected on ONE host,
      // while the retained buffers can belong to others, so discarding here
      // would delete host A's unsynced work because host B rotated.
      if (current !== null) {
        const discarding = current.handle.userId !== sessionUserId;
        registry.release(
          epicId,
          discarding ? "discard" : "keep",
          // A ROTATION is not a user change: the same person is still at the
          // keyboard, nothing was shown to them, and the live handle can hold
          // unsynced edits. Retaining it under the identity it was built for -
          // the OLD owner key, which is the room those edits belong to - is
          // what keeps the re-enrollment from destroying work the user was
          // never asked about. A user change takes `null`: no prior identity's
          // document may survive it, exactly as `disposeAll` does at sign-out.
          discarding
            ? null
            : {
                hostStamp: current.hostId,
                ownerIdentityKey: current.ownerIdentityKey,
              },
        );
      }
      // GUARDED, because `createHandle` runs synchronously inside this call and
      // the very first thing it does is construct a Worker. That throws outright
      // where the runtime has none or a Content-Security-Policy refuses the
      // script URL - a whole-environment condition, not a transport one, so the
      // rollback `catch` inside `createHandle` closes the transport and then
      // rethrows into this effect body. An effect that throws reaches the
      // component error boundary, which replaces the Epic wholesale and takes
      // the Retry affordance down with it - and Retry is the one control that
      // could recover a session whose worker failed to start.
      //
      // Presenting `failed` instead is what every other unrecoverable arm in
      // this effect does (the establishing deadline below, the dead-winner
      // adoption above), so the surface offers the same recovery for a worker
      // that never started as for one that died later.
      //
      // Scoped to the ACQUIRE alone. The stamp check immediately below is
      // deliberately fail-loud - a missing stamp means the write-once invariant
      // broke - and widening this `try` over it would convert that invariant
      // into a retry loop against a handle nothing can route.
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
      // The stamp is written once, at construction (inside `createHandle`).
      // When the registry returns a WARM handle the factory never ran and
      // the stamp names the host the handle's transport was built for - not
      // necessarily `targetHostId`. Recording the stamp rather than the
      // target is the F1 fix: the tuple must describe the handle it holds,
      // so a warm handle bound elsewhere takes the safe re-point arm on the
      // next pass instead of streaming from one host while labelled with
      // another. A missing stamp means the write-once invariant broke, and
      // substituting `targetHostId` would silently re-create F1 - fail loud.
      // Absence is unreachable rather than merely unlikely: this map and the
      // registry that hands back warm handles are declared in ONE module, so
      // no module replacement can produce a surviving warm handle whose stamp
      // was left behind - they are replaced together or not at all. That
      // colocation is LOAD-BEARING, not incidental: moving this map to another
      // module (e.g. beside the terminal/chat registries' equivalents) makes
      // this throw reachable under HMR, and no test can see it because HMR is
      // not in the suite.
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
      // The recovery affordance ("Open on original host") must name a host
      // this session actually served. For a warm adoption that is the
      // handle's bound host - not wherever the window moved while the tab
      // was closed.
      if (originalHostIdRef.current === null) {
        originalHostIdRef.current = nextSession.hostId;
      }
      // PUBLISHED ON A MICROTASK, as this provider has since the stream
      // rework - not an implementation detail. Consumers gated on the handle
      // eager-read the projection the instant the gate opens (the initial-chat
      // handoff coordinator opens its tab there), so handing them the handle in
      // the SAME commit that acquired it runs them a tick before any snapshot
      // can apply: the tab opens carrying the placeholder title instead of the
      // projected one. `sessionRef` still updates synchronously - the re-point
      // logic below reads it and must never lag the acquisition it describes.
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

    // The previous handle remains registered and rendered while its successor
    // establishes. The successor is deliberately outside the registry until a
    // complete snapshot makes an atomic replacement possible.
    const nextHandle = createHandle();
    presentSession({
      kind: "establishing",
      targetHostId,
      originalHostId: originalHostIdRef.current,
    });
    let settled = false;
    const disposePending = (): void => {
      if (settled) return;
      settled = true;
      nextHandle.dispose();
    };
    // ONE Epic can be mounted in TWO tabs of the same window (a duplicated
    // tab: `mostRecentTabIdByEpicId`, `duplicateEpicTab`), and every provider
    // for it shares the registry's mounted handle. So a re-point is started by
    // EACH of them, each with its own candidate, and the registry's atomic
    // `replaceMounted` lets exactly one win. The loser must ADOPT the winner's
    // handle - not dispose its candidate and return, which left it presenting
    // `establishing` forever on the old handle the winner had already disposed
    // or detached, past a deadline that `settled` had already disarmed.
    //
    // Adoption publishes the winner under ITS construction stamp, exactly as a
    // warm handle is adopted at acquire time (F1 above): if the stamp is not
    // this provider's target the next pass takes the safe re-point arm from
    // the winner rather than relabelling it. Mounted refs are untouched - the
    // replacement inherited this provider's count, and its unmount still
    // releases one.
    const adoptWinner = (winner: OpenEpicStoreHandle): void => {
      settled = true;
      nextHandle.dispose();
      // Same question the replacement path asks of its own candidate, asked
      // here of a SIBLING's. The winner arrives from `registry.peek`, which -
      // unlike `acquireMounted` - does not retire a dead entry, so adopting it
      // unchecked would present `ready` on a corpse. The provider that owns it
      // retires it on its next pass; this one presents `failed` meanwhile, so
      // the retry affordance exists rather than a `ready` nothing advances.
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
      // Woken by the registry as well as by the candidate's own store, so a
      // sibling's win is seen the moment it lands - not only once this
      // provider's candidate happens to load its snapshot.
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
      // Whether to ATTEMPT the transfer - not whether it happened. The two
      // used to be one boolean because the merge was synchronous; through the
      // port it is a task now (a worker round trip after the flip), so the
      // outcome is only known in the tail.
      const shouldTransferEdits = shouldMergeEpicRoomSwap(
        { roomId: previousRoomId },
        { roomId: nextRoomId },
      );
      // `commitReplacement` still returns void here, with `settled` already
      // set: nothing downstream waits on a promise to decide anything. What
      // moved into the tail is `replaceMounted` and everything after it, so
      // the disposition it carries is DERIVED from the real apply outcome.
      //
      // The alternative - call `replaceMounted(false)` now and correct it
      // later - would retain the outgoing handle as "the only copy of its
      // edits" for the length of the window, and retaining a duplicate is
      // precisely what pins an epic as permanently unsyncable. See the
      // registry's own comment on `editsTransferredToReplacement`.
      // `current` and `targetHostId` are already narrowed non-null by the
      // early returns above (line 698, line 472) and neither is reassigned
      // between there and here, so TypeScript carries both narrowings this
      // far - and passing them as PARAMETERS, not closed-over names, is what
      // lets that proof survive into the tail: TypeScript cannot carry a
      // narrowing across an `await`, and a `!` inside the tail would assert a
      // fact the await can genuinely invalidate. The tail receives values
      // that were already proven, not names it would have to re-prove.
      void transferThenComplete(shouldTransferEdits, current, targetHostId);
    };

    async function transferThenComplete(
      shouldTransferEdits: boolean,
      outgoing: MountedSessionState,
      hostId: string,
    ): Promise<void> {
      let editsTransferredToReplacement = false;
      // The candidate's ARM decides whether a root apply is a transfer at all.
      //
      // `applyRootUpdate` reports the local `Y.applyUpdate` and nothing more,
      // and on the lane arm that apply is the whole story: `sendOutbound`
      // routes `root-update` to the DETACHED `@1` adapter and drops it, because
      // the root doc is not a write path there - that arm's writes go through
      // the command queue. Reporting an in-memory apply as a transfer retires
      // the outgoing handle, the only copy of those edits, on the strength of
      // bytes no authority ever received.
      //
      // Retention is the correct outcome here and NOT the duplicate the
      // registry warns about: that warning is about a replacement that really
      // does hold the edits, and this one provably does not.
      //
      // `null` - no arm selected yet - counts as cannot-carry, for the same
      // reason the `catch` below answers false. The flag is a data-loss guard,
      // so the unknown answer is the conservative one.
      //
      // Deliberately not applied-and-then-reported-false: merging a whole
      // legacy root replica into a lane-backed session's root doc would seed
      // records beside the typed rows the state lane delivers for those same
      // records, which is a second defect rather than a kinder failure.
      // RE-READ ACROSS EVERY AWAIT, not once before them. The arm is not a
      // constant of the candidate: a lane probe can resolve, and an in-place
      // host upgrade re-handshakes an existing session
      // (`recordNegotiatedHostManifest` runs on every re-attach), so a
      // candidate that answers `legacy` here can be serving `lanes` by the
      // time `encodeRootState` resolves. The comment above about narrowing not
      // surviving an `await` is the same hazard one level up: this verdict does
      // not survive one either, and unlike a narrowing nothing makes that fail
      // to compile.
      //
      // Both re-reads matter, and for different reasons:
      //
      //  - BEFORE the apply, because applying is itself the harm. Merging a
      //    whole legacy root replica into a lane-backed session's root doc
      //    seeds records beside the typed rows the state lane delivers for
      //    those same records - the second defect this function's own comment
      //    warns against, not a kinder failure.
      //  - AFTER it, because the arm can move during the apply too, and then
      //    the bytes landed in a document whose `sendOutbound` routes
      //    `root-update` to the detached `@1` adapter and drops them. The flag
      //    is a data-loss guard, so an arm that moved under the apply has to
      //    answer the conservative `false` - the outgoing handle is retained
      //    rather than retired, which is recoverable where a discarded handle
      //    is not.
      const destinationCarriesRootWrites = (): boolean =>
        armCarriesRootWrites(nextHandle.store.getState().installedArm);
      if (shouldTransferEdits && destinationCarriesRootWrites()) {
        try {
          const update = await outgoing.handle.encodeRootState();
          // `true`: LOCAL_ORIGIN, so the union routes through the
          // replacement's normal local-update path and unacknowledged edits
          // survive for recovery.
          editsTransferredToReplacement =
            destinationCarriesRootWrites() &&
            (await nextHandle.applyRootUpdate(update, true)) &&
            destinationCarriesRootWrites();
        } catch {
          // The honest false. A failed transfer means the edits still live
          // only in the outgoing handle, which is exactly what the retention
          // path must be told - and it must still be TOLD, so this falls
          // through to `replaceMounted` rather than returning.
          editsTransferredToReplacement = false;
        }
      }
      if (lifecycle.cancelled) {
        // OWNERSHIP, and it changed hands one line before this function was
        // called. `commitReplacement` sets `settled = true` before dispatching
        // here, which permanently disarms both `disposePending` and the
        // deadline - so from that assignment onward THIS function owns
        // `nextHandle` on every exit, and the cleanup's `disposePending()` is
        // a no-op it cannot rely on.
        //
        // Every other exit already discharges it: `adoptWinner` disposes, the
        // no-winner arm disposes, and the success arm hands it to the registry.
        // This one returned bare, so an unmount or a target change landing
        // while `encodeRootState` / `applyRootUpdate` was awaiting abandoned a
        // fully-built candidate - its worker, its stream transport, its socket
        // and its accounting registrations alive for the life of the tab, with
        // nothing left holding a reference that could ever end them.
        nextHandle.dispose();
        return;
      }
      // A SECOND liveness question, and not the one `lifecycle.cancelled`
      // answers. That one asks whether this re-point is still wanted; this
      // asks whether the thing it is about to install still exists.
      //
      // `encodeRootState` / `applyRootUpdate` above are awaits, and the
      // candidate's own worker can fatal inside them. The relay records the
      // death on the handle and presents `failed` - but nothing here read that,
      // so the corpse was installed anyway and the tail below overwrote the
      // failure with `ready`. Nothing retires it afterwards either: the
      // registry's retirement happens in `acquireMounted`, and this effect does
      // not re-run for a death it never observed. The tab then sits on a dead
      // runtime with the retry affordance gone - the one affordance that exists
      // for exactly this failure.
      //
      // Disposed and presented as `failed`, which is what every other
      // non-adoptable exit in this function already does.
      if (isEpicSessionHandleDead(nextHandle)) {
        nextHandle.dispose();
        presentSession({
          kind: "failed",
          targetHostId: hostId,
          originalHostId: originalHostIdRef.current,
        });
        return;
      }
      // Identity of the handle being REPLACED, for the retention (F10). Read
      // from the construction stamp rather than from `current.hostId`: the two
      // agree today, but "derive, don't assert" is the whole of step 1, and
      // this value decides whether a later retention merges into this buffer.
      // A wrong host here would merge two hosts' unsynced edits into one
      // document that can be honestly flushed to neither.
      //
      // Carries the merge OUTCOME too, so the registry can tell a handle that
      // is the only copy of its edits from one whose edits are already in the
      // replacement. Read from the same boolean the merge above branched on
      // rather than recomputed, so the two can never disagree about what
      // happened to this document.
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
        // Lost the race between the `peek` above and here, or the entry is
        // gone. A sibling's winner is adopted; anything else is presented as
        // failed so the retry affordance exists, instead of an `establishing`
        // that nothing will ever advance.
        const winner = registry.peek(epicId);
        if (winner !== null && winner !== outgoing.handle) {
          adoptWinner(winner);
          return;
        }
        nextHandle.dispose();
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
        // The captured reading describes the host this session was on when
        // the re-point STARTED, not `targetHostId` - so recording it here
        // pairs the replacement's handle with the previous host's key. The
        // next render reads the new host's key, the two differ, and the
        // rebuild arm disposes the handle that is holding the document this
        // function just merged into it (B5).
        //
        // Recording honest-absent instead is what the completion above is
        // for: it fills the tuple from the new host's own reading on the next
        // pass, same handle, no rebuild. That also covers the case where the
        // new host's directory row has not landed yet, where there is no
        // post-move key to record at all - one mechanism for both, which is
        // why an eager post-move read would not have been enough.
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
  // Stamp the SAME client the context below provides onto the handle, for
  // imperative callers outside this subtree (the DnD reparent commit) that
  // must address the host the session's records live on. Re-stamped on
  // every change, unlike `handleHostIds`: the host id is the handle's
  // transport binding and must not drift, the client is a requester for that
  // binding and legitimately rotates (reconnect, identity re-point).
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
