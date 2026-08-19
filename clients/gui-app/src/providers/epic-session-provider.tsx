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
import * as Y from "yjs";
import { useNavigate } from "@tanstack/react-router";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  LOCAL_ORIGIN,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { EpicStreamClient } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthService } from "@/lib/host";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import { useReactiveOwnerIdentityKey } from "@/hooks/host/use-reactive-owner-identity-key";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  claimDesktopEpicOwnership,
  getDesktopEpicOwnershipBridge,
  releaseDesktopEpicOwnership,
} from "@/lib/windows/desktop-epic-ownership";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
  EpicSessionPresentationContext,
  getEpicStreamClientFactoryOverride,
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
  handleHostIds,
  releaseOpenEpicSessionIfUnused,
} from "@/lib/registries/epic-session-registry";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { shouldMergeEpicRoomSwap } from "@/lib/epics/epic-room-swap";
import { ESTABLISHING_DEADLINE_MS } from "@/lib/host/bounded-load-budgets";
import { openEpicKey } from "@/lib/persist";
import { adoptLegacyPersistedKey } from "@/lib/persist/zustand-persist-lifecycle";

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

export function EpicSessionProvider(
  props: EpicSessionProviderProps,
): ReactNode {
  const { epicId, tabId, children } = props;
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
  const [requestedHostId, setRequestedHostId] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [presentation, setPresentation] = useState<SessionPresentationState>({
    kind: "establishing",
    targetHostId: effectiveHostId,
    originalHostId: null,
  });
  const targetHostId = requestedHostId ?? effectiveHostId;
  const resolvedSessionHostClient = useHostClientForHostId(
    session?.hostId ?? targetHostId,
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
    setRetryGeneration((generation) => generation + 1);
  }, []);
  const openOnOriginalHost = useCallback((): void => {
    const originalHostId = originalHostIdRef.current;
    if (originalHostId === null) return;
    setRequestedHostId(originalHostId);
    setRetryGeneration((generation) => generation + 1);
  }, []);

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
    // The session OWNS its transport: the factory opens it (socket + auth +
    // wake) and the returned handle's `close()` tears it all down on dispose.
    // The registry only closes the handle when it DISPOSES the session, so the
    // socket survives across the MRU warm window and a revived session is never
    // handed a dead transport; the durable transport's live endpoint + wake
    // re-dial heal a host restart under a stable `hostId` on their own. Tests
    // drive the stream through the override seam and never open a real socket.
    const streamClientFactory: EpicStreamClientFactory = (
      factoryEpicId,
      callbacks,
    ) => {
      const override = getEpicStreamClientFactoryOverride();
      if (override !== null) {
        return override(factoryEpicId, callbacks);
      }
      // `targetHostId` is non-null here: the acquire effect gates on it above,
      // and it is a `const`, so that narrowing flows into this factory closure.
      // Removing the gate would surface a compile error at this call (which
      // requires a concrete `hostId`), not a runtime throw - the type system is
      // the invariant.
      const result = openOwnedDurableStreamClient(
        openTransport,
        targetHostId,
        (ws) =>
          new EpicStreamClient({
            wsStreamClient: ws,
            epicId: factoryEpicId,
            callbacks,
          }),
      );
      return {
        applyUpdate: (updateBytes) => result.client.applyUpdate(updateBytes),
        awareness: (awarenessBytes) => result.client.awareness(awarenessBytes),
        applyArtifactRoomUpdate: (artifactRoomId, updateBytes) =>
          result.client.applyArtifactRoomUpdate(artifactRoomId, updateBytes),
        artifactRoomAwareness: (artifactRoomId, awarenessBytes) =>
          result.client.artifactRoomAwareness(artifactRoomId, awarenessBytes),
        retryMigration: () => result.client.retryMigration(),
        close: result.close,
      };
    };
    const createHandle = (): OpenEpicStoreHandle => {
      // Before the store exists, because `persist` reads its key at creation:
      // the bucket used to be named by the email, and re-keying without this
      // would silently reset every install's focus state on upgrade.
      if (sessionUserId !== null) adoptLegacyOpenEpicKey(sessionUserId);
      const created = createOpenEpicStore({
        epicId,
        streamClientFactory,
        userId: sessionUserId,
        onAuthError: handleSessionAuthError,
      });
      // Construction-honest stamp, written exactly once: `streamClientFactory`
      // above captures this run's `targetHostId` into the transport it opens,
      // so the stamp IS the handle's transport binding. Nothing re-stamps a
      // live handle - a label that can drift from the binding routes RPCs and
      // capability answers to a host that does not own the stream (F1).
      handleHostIds.set(created, targetHostId);
      return created;
    };
    let current = sessionRef.current;
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
      const nextHandle = registry.acquireMounted(epicId, createHandle);
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
      const stampedHostId = handleHostIds.get(nextHandle);
      if (stampedHostId === undefined || stampedHostId === null) {
        throw new Error(
          "epic session handle carries no construction host stamp",
        );
      }
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
      const stampedHostId = handleHostIds.get(winner);
      if (stampedHostId === undefined || stampedHostId === null) {
        throw new Error(
          "epic session handle carries no construction host stamp",
        );
      }
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
      const editsTransferredToReplacement = shouldMergeEpicRoomSwap(
        { roomId: previousRoomId },
        { roomId: nextRoomId },
      );
      if (editsTransferredToReplacement) {
        // LOCAL_ORIGIN routes the CRDT union through the replacement's normal
        // local-update path, preserving unacknowledged edits for recovery.
        Y.applyUpdate(
          nextHandle.doc,
          Y.encodeStateAsUpdate(current.handle.doc),
          LOCAL_ORIGIN,
        );
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
        hostStamp: getEpicSessionHandleHostId(current.handle),
        ownerIdentityKey: current.ownerIdentityKey,
        editsTransferredToReplacement,
      };
      const replaced = registry.replaceMounted(
        epicId,
        current.handle,
        nextHandle,
        previousDisposition,
      );
      if (!replaced) {
        // Lost the race between the `peek` above and here, or the entry is
        // gone. A sibling's winner is adopted; anything else is presented as
        // failed so the retry affordance exists, instead of an `establishing`
        // that nothing will ever advance.
        const winner = registry.peek(epicId);
        if (winner !== null && winner !== current.handle) {
          adoptWinner(winner);
          return;
        }
        nextHandle.dispose();
        presentSession({
          kind: "failed",
          targetHostId,
          originalHostId: originalHostIdRef.current,
        });
        return;
      }
      const nextSession = {
        handle: nextHandle,
        hostId: targetHostId,
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
          targetHostId,
          ownerIdentityKey,
          ownerIdentityKeyHostId,
        ),
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      presentSession({
        kind: "ready",
        targetHostId,
        originalHostId: originalHostIdRef.current,
      });
    };
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

    let lastSyncedTitle: string | null = null;
    const syncTitle = (): void => {
      const title = normalizeGeneratedTitle(handle.store.getState().epic.title);
      if (title === null || title === lastSyncedTitle) return;
      lastSyncedTitle = title;
      updateEpicTitleInCloudTaskCaches(
        queryClient,
        { hostId: activeHostId, userId },
        epicId,
        title,
      );
    };

    syncTitle();
    return handle.store.subscribe(syncTitle);
  }, [activeHostId, epicId, handle, queryClient, userId]);
}

function normalizeGeneratedTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}
