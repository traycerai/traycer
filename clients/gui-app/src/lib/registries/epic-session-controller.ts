/**
 * The tab-owned epic session controller: one per authenticated renderer, one
 * logical entry per epic with tab-id membership.
 *
 * ## The principle
 *
 * Tabs own session intent; residency is independently scheduled; React
 * observes. An epic tab's session follows from the tab EXISTING - it is in the
 * canvas store's `openTabOrder` - and from what that tab still needs, not from
 * a surface for it happening to be rendered. `EpicSessionProvider` subscribes to this controller's per-tab
 * snapshot and issues two commands (Retry, open on original host); it never
 * acquires, re-points, parks or releases on its own.
 *
 * Before this module, `EpicSessionProvider` was the only production creator of
 * a session, so an epic existed in the renderer only while its surface was
 * mounted or retained. A tab swapped in without activation (`replaceDraftWithEpic`
 * when the draft had lost focus) therefore had no session, nothing observed the
 * generated title, and the strip read "Untitled task" until the tab was opened.
 *
 * ## Membership vs demand
 *
 * MEMBERSHIP is intent: the set of open tab ids for an epic, derived from
 * `openTabOrder` (never `tabsById`, which retains closed records) by the same
 * open-set reconciler renderer parking uses (`lib/epics/epic-parking-open-tabs.ts`),
 * so background open, restore, duplicate, draft swap, close and window transfer
 * all flow through one place. Every open tab is a member; every way a tab
 * leaves releases the departing membership, and the last one releases the
 * session.
 *
 * A member gets a SESSION only while something DEMANDS residency, and demand
 * has exactly two sources:
 *
 *  - a SURFACE: a pane, visible or retained, is showing the tab;
 *  - UNOBSERVED METADATA: the tab record has no real name yet
 *    (`isRealEpicTitle`: empty, the GUI's "Untitled task" fallback and the
 *    host's "Untitled" placeholder are all absences). This is the "Untitled
 *    task" defect's case - a tab swapped in without activation - and it is a
 *    one-shot: the session is built hidden and held by the METADATA HOLD until
 *    its first real title is observed, bounded by the existing pending-title
 *    backstop (`TITLE_GENERATION_PENDING_TIMEOUT_MS`).
 *
 * A hidden tab with a real name has neither, so its entry starts SUSPENDED and
 * builds nothing - exactly what it was before tabs owned sessions, and what
 * keeps N restored tabs from building N workers at boot.
 *
 * Demand is deliberately not membership: the registry's cap counts every entry
 * but can only evict demand-free ones, so a controller that held demand for
 * every open tab would strip the cap of its only evictable population. The
 * controller holds exactly ONE mount unit on an entry while demand exists and
 * hands it back the moment it ends. The session then sits WARM (demand 0),
 * where the warm cap and five-minute parking apply exactly as before, and the
 * entry is SUSPENDED: it keeps its membership and its tab keeps its name, and
 * the controller does not re-acquire until a surface attaches or the user
 * retries. Re-acquiring on "no handle" would undo the release those policies
 * made. A SURFACED entry whose session was taken from under it (sign-out)
 * rebuilds once its inputs move, as a mounted provider's effect used to.
 *
 * Desktop ownership is claimed per TAB, and BEFORE the acquisition it gates -
 * so lazily, when a pane shows the tab or an unnamed tab's entry acquires -
 * and released when the tab leaves membership. Two windows may hold the same
 * epic under different tab ids.
 *
 * ## What moved here from the provider
 *
 * Desktop ownership claims (per TAB, before acquisition), the create-host seed
 * and effective-host selection, the plan-restriction backoff ladder, the
 * `failed` presentation, retry generation, owner-key rotation (R-1), warm-handle
 * adoption and the safe re-point (F1). They are controller state, not provider
 * callbacks: passing the provider's closures in would have preserved the mount
 * coupling this module exists to remove.
 *
 * ## Write-throughs
 *
 * A live session also owns the three things it knows that are read from
 * somewhere else: the tab record's name, the History / task-context title,
 * and the History home marker (`lib/registries/epic-session-write-throughs.ts`).
 * They were React effects - one in the mounted epic route, two in the
 * provider - so a title that landed on a never-activated tab reached the
 * strip through the registry but was persisted nowhere. One set is attached
 * per handle the entry HOLDS, for as long as it holds it (a warm, suspended
 * session is still live and still writes), moved on a re-point, and dropped
 * with the handle and at every auth boundary. The metadata hold only
 * OBSERVES the title now; the tab-name write-through is the one writer.
 *
 * ## Publish channels
 *
 * Two, and both are kept from the provider. An ACQUISITION publishes on a
 * microtask: consumers gated on the handle eager-read the projection the
 * instant the gate opens, so handing them the handle in the same tick that
 * acquired it runs them before any snapshot can apply. A PARK retracts
 * synchronously: it hands back a DESTROYED handle, and a deferred retraction
 * can be cancelled by the very unpark it exists for, leaving the disposed store
 * as the thing consumers read.
 *
 * ## Module placement
 *
 * Beside the registry singleton and the stamp maps, and importing them, so the
 * HMR co-lifetime holds: a warm handle the registry hands back must have its
 * construction stamp in the same module generation, or `requireConstructionHostStamp`
 * throws (F1). This module imports the registry; the registry never imports it.
 */
import { appLogger } from "@/lib/logger";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import { SESSION_SILENCE_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/remote/config";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { TITLE_GENERATION_PENDING_TIMEOUT_MS } from "@/stores/epics/canvas/canvas-title-timers";
import {
  claimDesktopEpicOwnership,
  getDesktopEpicOwnershipBridge,
  releaseDesktopEpicOwnership,
} from "@/lib/windows/desktop-epic-ownership";
import {
  attributeEpicSessionTransportClose,
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
  handleHostClients,
  handleHostIds,
  handleStreamClients,
  isEpicSessionHandleDead,
  subscribeEpicOwnershipReleased,
  type EpicSessionPresentationState,
} from "@/lib/registries/epic-session-registry";
import {
  createEpicSessionHandle,
  type EpicSessionRequesterTarget,
} from "@/lib/registries/epic-session-handle-factory";
import {
  isEpicParked,
  reportEpicParkRefused,
  subscribeEpicParking,
} from "@/lib/epics/epic-parking";
import { shouldMergeEpicRoomSwap } from "@/lib/epics/epic-room-swap";
import { armCarriesRootWrites } from "@/stores/epics/open-epic/runtime/epic-adapter-selection";
import { ESTABLISHING_DEADLINE_MS } from "@/lib/host/bounded-load-budgets";
import {
  createPlanRestrictedSessionRebuildBackoff,
  type PlanRestrictedSessionRebuildBackoff,
} from "@/lib/host/plan-restricted-session-rebuild-backoff";
import { openEpicKey } from "@/lib/persist";
import { adoptLegacyPersistedKey } from "@/lib/persist/zustand-persist-lifecycle";
import { sessionCreatedEpicHostId } from "@/lib/epics/session-created-epics";
import { isRealEpicTitle } from "@/lib/display-title";
import type { QueryClient } from "@tanstack/react-query";
import {
  attachEpicSessionWriteThroughs,
  readEpicSessionTitle,
  type EpicSessionWriteThroughs,
} from "@/lib/registries/epic-session-write-throughs";

/**
 * The failure card's Retry forcing a re-dial on a transport that reports
 * itself silent. A DIFFERENT reason from the factory's wake on purpose: this
 * one names an escalation the session's own verdict earned, and a support
 * bundle has to be able to tell the two apart.
 */
const EPIC_RETRY_FORCE_RECONNECT_REASON = "epic-retry";

/** Joins the parts of a comparison key; keys are compared, never parsed. */
const KEY_SEPARATOR = " | ";

/**
 * Everything the controller needs from the app that is NOT a fact about a tab
 * or a session - the provider's captured hooks, made explicit as a port the
 * app installs once (`providers/epic-session-controller-bridge.tsx`) and a
 * suite installs with fakes.
 *
 * Deliberately NOT the selection authority or the signed-in identity: both are
 * Zustand stores this module reads directly, because effective-host selection
 * is controller state now and a port for it would be a second reader of the
 * same store.
 */
export interface EpicSessionControllerEnvironment {
  /** The session's durable transport opener, referentially stable. */
  readonly openTransport: (
    hostId: string,
  ) => AttributableDurableStreamTransport;
  /**
   * A requester for an explicit host id, MEMOIZED per host: every consumer of
   * one host must address one client object, and the stamp
   * (`handleHostClients`) is compared by identity.
   */
  readonly resolveHostClient: (
    hostId: string,
  ) => HostClient<HostRpcRegistry> | null;
  /**
   * The host terminated the epic stream with `UNAUTHORIZED`. Re-validate the
   * live RequestContext; single-flight and idempotent.
   */
  readonly revalidateAuth: () => void;
  /**
   * The app's Query client, for the History / task-context / home
   * write-throughs a live session owns. App-lifetime, like the rest of this
   * port. `null` makes those write-throughs a no-op; the tab name needs none.
   */
  readonly queryClient: QueryClient | null;
}

/**
 * What one tab's provider observes. Referentially stable between changes so
 * `useSyncExternalStore` can bail out.
 */
export interface EpicSessionTabSnapshot {
  /**
   * The handle consumers may read, or `null`: no session yet, this tab's
   * desktop ownership not claimed, or the epic parked.
   */
  readonly handle: OpenEpicStoreHandle | null;
  /** The host the live session is served from, `null` before a session. */
  readonly sessionHostId: string | null;
  /**
   * The client the session's host resolves to - `null` while `handle` is,
   * so no consumer addresses a host the session is not on.
   */
  readonly sessionHostClient: HostClient<HostRpcRegistry> | null;
  readonly presentation: EpicSessionPresentationState;
}

/**
 * `unclaimed` is a member that has not needed a session yet: a hidden tab with
 * a real name claims nothing until a pane shows it, which is when it claimed
 * before tabs owned sessions. The claim is per TAB and comes BEFORE the
 * acquisition it gates, never at membership.
 */
type TabOwnership = "unclaimed" | "browser" | "claiming" | "claimed" | "denied";

interface TabMembership {
  ownership: TabOwnership;
  /** A desktop claim this tab holds and must release when it leaves. */
  claimHeld: boolean;
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
 * APPLIED AT EVERY TUPLE WRITER that assembles from raw inputs - the acquire
 * arm, the adoption arm and the replacement commit. The same-host guard checks
 * the host a reading was TAKEN FROM, not the honesty of a record already
 * labelled with this host, so a cross-host record written at the replacement
 * passes the guard and reaches the rotation arm, which is exactly the B5
 * discard.
 */
function ownerIdentityKeyForHost(
  hostId: string,
  ownerIdentityKey: string | null,
  ownerIdentityKeyHostId: string | null,
): string | null {
  return ownerIdentityKeyHostId === hostId ? ownerIdentityKey : null;
}

/**
 * The handle's construction host stamp, or a throw.
 *
 * The stamp is written once, inside the session factory, and it is what routes
 * RPCs and capability answers to the host that owns the stream; substituting
 * the caller's target instead would silently re-create F1, so absence is a
 * thrown invariant rather than a fallback. Reachable only if the write-once
 * invariant broke - this module, the stamp map and the registry that hands
 * back warm handles share one module lifetime, so no module replacement can
 * leave a surviving warm handle whose stamp was left behind.
 */
function requireConstructionHostStamp(handle: OpenEpicStoreHandle): string {
  const stamped = handleHostIds.get(handle);
  if (stamped === undefined || stamped === null) {
    throw new Error("epic session handle carries no construction host stamp");
  }
  return stamped;
}

/**
 * Whether the session has observed a REAL title. The same predicate that
 * decides whether a hidden tab has metadata worth a session at all, so a
 * host-synthesized placeholder cannot end a hold the tab record still needs.
 */
function sessionHasRealTitle(handle: OpenEpicStoreHandle): boolean {
  return isRealEpicTitle(readEpicSessionTitle(handle));
}

interface MetadataHold {
  readonly handle: OpenEpicStoreHandle;
  readonly unsubscribe: () => void;
  readonly timer: number;
}

/**
 * One in-flight acquisition or re-point, with the fences the provider's
 * effect cleanup used to provide: `cancelled` for every async tail, and
 * `cleanup` for the subscriptions, the deadline and a pending candidate.
 */
/** What one reconcile pass reads, taken once so its arms agree. */
interface ReconcileInputs {
  readonly userId: string | null;
  readonly targetHostId: string | null;
  readonly authorityAttached: boolean;
  readonly ownershipClaimed: boolean;
  readonly parked: boolean;
  readonly mounted: boolean;
  readonly ownerIdentityKey: string | null;
  readonly ownerIdentityKeyHostId: string | null;
}

/** The inputs a run was started for. */
interface RunInputs {
  readonly userId: string | null;
  readonly targetHostId: string;
  readonly ownerIdentityKey: string | null;
  readonly ownerIdentityKeyHostId: string | null;
  readonly mounted: boolean;
}

interface ActiveRun {
  cancelled: boolean;
  cleanup: () => void;
}

interface ControllerEntry {
  readonly epicId: string;
  readonly tabs: Map<string, TabMembership>;
  /**
   * The session this entry HOLDS - the synchronous truth every arm reads
   * (the provider's `sessionRef`). Updated in the same tick as the registry.
   */
  session: MountedSessionState | null;
  /**
   * The handle consumers SEE. Lags `session` by a microtask on acquisition
   * and leads it on a park - see the module doc on publish channels.
   */
  published: OpenEpicStoreHandle | null;
  /** Whether this controller holds its one mount unit on the registry entry. */
  demandHeld: boolean;
  /**
   * The session was released by a policy this controller must not undo -
   * parking, the warm cap, or sign-out - and nothing re-acquires until a
   * surface attaches or the user retries.
   */
  suspended: boolean;
  /** A `failed` presentation with no live handle, observable to a later surface. */
  constructionFailed: boolean;
  requestedHostId: string | null;
  /**
   * Whether `requestedHostId` is still the CREATE-HOST SEED rather than a
   * host the user asked for. Only the seed is given up, and on any of the
   * three signals that the create race no longer decides placement: a
   * derivation move, a Retry, or the user naming a host.
   */
  seededCreateHost: boolean;
  /** For the seed's give-up-on-move rule: the last non-null effective host. */
  lastEffectiveHostId: string | null;
  originalHostId: string | null;
  retryGeneration: number;
  presentation: EpicSessionPresentationState;
  /**
   * One ladder per entry, so handle replacement cannot reset its owner-level
   * backoff when a host repeatedly denies the plan. Cancelled on scope change
   * (identity, target, ownership) and when the last tab leaves.
   */
  readonly backoff: PlanRestrictedSessionRebuildBackoff;
  /** The scope the ladder was last armed for; a change cancels it. */
  backoffScopeKey: string | null;
  run: ActiveRun | null;
  runKey: string | null;
  /** The selection-gap sub-run: `establishing` bounded by a deadline, then `failed`. */
  gapDeadline: number | null;
  gapKey: string | null;
  metadataHold: MetadataHold | null;
  /** The client for `session?.hostId ?? targetHostId`, stamped onto the handle. */
  sessionHostClient: HostClient<HostRpcRegistry> | null;
  tabSnapshots: Map<string, EpicSessionTabSnapshot>;
  /** The last snapshot handed out per tab, for by-value stability. */
  readonly lastTabSnapshots: Map<string, EpicSessionTabSnapshot>;
  /**
   * The run inputs at the moment the entry was suspended. A SURFACED entry
   * re-acquires once they move (a new identity after sign-out, a new target),
   * exactly as a mounted provider's effect re-ran on its deps; a hidden entry
   * never does.
   */
  suspendedInputKey: string | null;
  /**
   * Unobserved metadata is a ONE-SHOT demand: spent once a session has been
   * acquired for it. A hold that expired does not retry on its own; the next
   * surface attach acquires as usual.
   */
  metadataDemandSpent: boolean;
  /**
   * The write-throughs attached to the handle this entry HOLDS, and what they
   * were attached for. One set per live session; see `syncWriteThroughs`.
   */
  writeThroughs: AttachedWriteThroughs | null;
}

interface AttachedWriteThroughs {
  readonly handle: OpenEpicStoreHandle;
  readonly queryClient: QueryClient | null;
  readonly cacheUserId: string | null;
  readonly authEpoch: number;
  /**
   * `null` only for the instant between this record being set and the
   * attachment existing: attaching writes at once, and that first write has
   * to find itself current.
   */
  attachment: EpicSessionWriteThroughs | null;
}

/** Diagnostic view of one entry, for the suites that pin residency. */
export interface EpicSessionEntryStatus {
  readonly epicId: string;
  readonly tabIds: ReadonlyArray<string>;
  readonly hasSession: boolean;
  readonly demandHeld: boolean;
  readonly suspended: boolean;
  readonly constructionFailed: boolean;
  readonly metadataHold: boolean;
  readonly presentation: EpicSessionPresentationState;
}

const NO_SESSION_PRESENTATION: EpicSessionPresentationState = {
  kind: "establishing",
  targetHostId: null,
  originalHostId: null,
};

/** What a provider reads for a tab this controller has no entry for. */
const NO_SESSION_SNAPSHOT: EpicSessionTabSnapshot = {
  handle: null,
  sessionHostId: null,
  sessionHostClient: null,
  presentation: NO_SESSION_PRESENTATION,
};

function presentationEquals(
  left: EpicSessionPresentationState,
  right: EpicSessionPresentationState,
): boolean {
  return (
    left.kind === right.kind &&
    left.targetHostId === right.targetHostId &&
    left.originalHostId === right.originalHostId
  );
}

function readOwnerIdentityKey(
  client: HostClient<HostRpcRegistry> | null,
): string | null {
  return remoteAwareOwnerIdentityKey(
    client?.getActiveHost() ?? null,
    client?.getRequestContextUserId() ?? null,
  );
}

export interface EpicSessionController {
  /**
   * Bring membership in line with the open tabs: one entry per epic, keyed by
   * epic, holding every open tab id for it. Told the set rather than reading
   * it, exactly as the parking module is, and by the same projection.
   */
  syncOpenTabs(open: ReadonlyMap<string, ReadonlyArray<string>>): void;
  /**
   * A surface (a pane, visible or retained) is showing this tab. Holds the
   * entry's residency for as long as the returned detach is not called, and
   * wakes a suspended entry.
   */
  attachSurface(epicId: string, tabId: string): () => void;
  readTabSnapshot(epicId: string, tabId: string): EpicSessionTabSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Another window owns this TAB id, so this window has discarded the tab.
   * The provider mounted for it navigates away; nothing else here can.
   */
  subscribeOwnershipDenied(
    listener: (epicId: string, tabId: string) => void,
  ): () => void;
  retry(epicId: string): void;
  openOnOriginalHost(epicId: string): void;
  installEnvironment(
    environment: EpicSessionControllerEnvironment | null,
  ): void;
  uninstallEnvironment(environment: EpicSessionControllerEnvironment): void;
  readEntryStatusForTests(epicId: string): EpicSessionEntryStatus | null;
  __resetForTests(): void;
}

function createEpicSessionController(): EpicSessionController {
  const registry = getOpenEpicRegistry();
  const entries = new Map<string, ControllerEntry>();
  /**
   * Surfaces are tracked apart from entries: a surface can attach a tick
   * before membership lands (a test harness opening the tab in a layout
   * effect) and must not be lost, and an entry that leaves and returns keeps
   * the panes that never unmounted.
   */
  const surfaces = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  const deniedListeners = new Set<(epicId: string, tabId: string) => void>();
  let environment: EpicSessionControllerEnvironment | null = null;
  /**
   * Re-entrancy: the registry notifies from inside its own transaction, and an
   * acquisition inside `reconcile` notifies too. A nested reconcile request is
   * queued and drained once the outer one returns, so no entry is reconciled
   * while an arm of its own run is still on the stack.
   */
  /**
   * Bumped at every auth boundary; captured before an await and re-checked
   * after it, so a continuation issued under one identity cannot act under
   * the next (or under none).
   */
  let authEpoch = 0;
  /**
   * Set by the TRANSITION into signed-out and cleared by the next identity.
   * Deliberately not `status === "signed-out"`: a fresh renderer starts there
   * with no identity, before hydration, and sessions have always been allowed
   * to open in that state. What is fenced is acting after a sign-out.
   */
  let signedOutFence = false;
  let reconciling = false;
  const pendingReconcile = new Set<string>();
  let reconcileAllPending = false;

  function emit(): void {
    for (const listener of Array.from(listeners)) listener();
  }

  function surfaceCount(epicId: string): number {
    return surfaces.get(epicId)?.size ?? 0;
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  function publishSnapshots(entry: ControllerEntry): void {
    // Every change to an entry ends here, so this is where the write-throughs
    // are brought back in line with the handle it holds.
    syncWriteThroughs(entry);
    entry.tabSnapshots = new Map();
    emit();
  }

  // ── Write-throughs ────────────────────────────────────────────────────────

  /** The handle this entry's write-throughs belong on right now, if any. */
  function writeThroughHandleFor(
    entry: ControllerEntry,
  ): OpenEpicStoreHandle | null {
    if (entries.get(entry.epicId) !== entry || signedOutFence) return null;
    const handle = entry.session?.handle ?? null;
    // A session built under another identity is on its way out (the run's
    // identity arm discards it); it writes nothing into this one's caches.
    if (handle === null || handle.userId !== readUserId()) return null;
    return handle;
  }

  function detachWriteThroughs(entry: ControllerEntry): void {
    const attached = entry.writeThroughs;
    if (attached === null) return;
    entry.writeThroughs = null;
    attached.attachment?.detach();
  }

  /**
   * ONE set of write-throughs per live session, for as long as the entry
   * holds it - not only while a pane shows it, and not only during the
   * metadata hold.
   *
   * Reconciled rather than attached-and-detached at each site: the target is
   * a pure function of the entry (the handle it holds, the Query client, the
   * cache user, the auth epoch), so every path that drops or replaces the
   * handle - suspend, park, cap eviction, a re-point's replacement, sign-out,
   * a failed construction, the last tab closing - tears them down by making
   * the target change, and none can forget to. A re-point MOVES them: the
   * replacement is a different handle.
   *
   * Keyed on the handle the entry HOLDS (`session`), which leads the
   * published one by a microtask. That lead is load-bearing: a warm handle
   * that already carries its title ends the metadata hold in the same tick it
   * is acquired, and the tab record has to be written before that hold lets
   * the session go.
   */
  function syncWriteThroughs(entry: ControllerEntry): void {
    const wanted = writeThroughHandleFor(entry);
    const queryClient = environment?.queryClient ?? null;
    const cacheUserId = useAuthStore.getState().contextMetadata?.userId ?? null;
    const attached = entry.writeThroughs;
    if (
      attached !== null &&
      attached.handle === wanted &&
      attached.queryClient === queryClient &&
      attached.cacheUserId === cacheUserId &&
      attached.authEpoch === authEpoch
    ) {
      // Same session: membership may have grown (a duplicate, a tab opened in
      // this window for an epic already live), so seed the newcomers.
      attached.attachment?.refreshTabNames();
      return;
    }
    detachWriteThroughs(entry);
    if (wanted === null) return;
    const record: AttachedWriteThroughs = {
      handle: wanted,
      queryClient,
      cacheUserId,
      authEpoch,
      attachment: null,
    };
    // Set BEFORE attaching: attaching writes at once, and `isCurrent` has to
    // find this record installed for that first write.
    entry.writeThroughs = record;
    record.attachment = attachEpicSessionWriteThroughs({
      epicId: entry.epicId,
      handle: wanted,
      readTabIds: () => Array.from(entry.tabs.keys()),
      queryClient,
      cacheUserId,
      // Re-checked at WRITE time: a notification already in flight when the
      // handle is dropped or the identity ends must not write.
      isCurrent: () =>
        entry.writeThroughs === record &&
        record.authEpoch === authEpoch &&
        !signedOutFence &&
        entry.session?.handle === wanted,
    });
  }

  function tabSnapshotFor(
    entry: ControllerEntry,
    tabId: string,
  ): EpicSessionTabSnapshot {
    const cached = entry.tabSnapshots.get(tabId);
    if (cached !== undefined) return cached;
    const membership = entry.tabs.get(tabId);
    const ownershipClaimed =
      membership !== undefined &&
      (membership.ownership === "claimed" ||
        membership.ownership === "browser");
    const handle =
      ownershipClaimed && !isEpicParked(entry.epicId) ? entry.published : null;
    const next: EpicSessionTabSnapshot = {
      handle,
      // Follows the PUBLISHED session, as the provider's state did: `null`
      // in the microtask between an acquisition and its publish.
      sessionHostId:
        entry.published === null ? null : (entry.session?.hostId ?? null),
      sessionHostClient: handle === null ? null : entry.sessionHostClient,
      presentation: entry.presentation,
    };
    // Stable BY VALUE across invalidations: every reconcile pass invalidates
    // the cache, and a fresh object per pass would re-render every provider
    // of this epic on each selection or host-row notification.
    const previous = entry.lastTabSnapshots.get(tabId);
    const snapshot =
      previous !== undefined &&
      previous.handle === next.handle &&
      previous.sessionHostId === next.sessionHostId &&
      previous.sessionHostClient === next.sessionHostClient &&
      previous.presentation === next.presentation
        ? previous
        : next;
    entry.tabSnapshots.set(tabId, snapshot);
    entry.lastTabSnapshots.set(tabId, snapshot);
    return snapshot;
  }

  function present(
    entry: ControllerEntry,
    next: EpicSessionPresentationState,
  ): void {
    // Idempotent by value: a run re-presents on every pass, and a fresh object
    // per pass would wake every subscriber for nothing.
    if (presentationEquals(entry.presentation, next)) return;
    entry.presentation = next;
    publishSnapshots(entry);
  }

  // ── Environment, selection and identity ───────────────────────────────────

  function resolveClient(
    hostId: string | null,
  ): HostClient<HostRpcRegistry> | null {
    if (hostId === null || environment === null) return null;
    return environment.resolveHostClient(hostId);
  }

  function readUserId(): string | null {
    return useAuthStore.getState().profile?.userId ?? null;
  }

  function adoptLegacyOpenEpicKey(epicId: string, userId: string): void {
    // Both non-null, explicitly: `openEpicKey(null, …)` is the ANONYMOUS
    // bucket, and adopting that into an account's bucket would be its own
    // leak. Consulted once, at handle creation.
    const legacyEmail = useAuthStore.getState().profile?.email ?? null;
    if (legacyEmail === null) return;
    adoptLegacyPersistedKey(
      openEpicKey(userId, epicId),
      openEpicKey(legacyEmail, epicId),
    );
  }

  /**
   * The create-host seed answers ONE question - which host can serve this epic
   * while its cloud record is still being written - and must not outrank a
   * later derivation move. Given up on the MOVE, not on a timer: `null` is
   * the authority's DETACHED default rather than a move, so the first non-null
   * answer is adopted as the baseline instead of acted on.
   */
  function observeEffectiveHostMove(
    entry: ControllerEntry,
    effectiveHostId: string | null,
  ): void {
    if (effectiveHostId === null) return;
    const previous = entry.lastEffectiveHostId;
    entry.lastEffectiveHostId = effectiveHostId;
    if (previous === null || previous === effectiveHostId) return;
    if (!entry.seededCreateHost) return;
    entry.seededCreateHost = false;
    entry.requestedHostId = null;
  }

  // ── Desktop ownership, per tab ────────────────────────────────────────────

  /**
   * Claim the tabs that are about to need a session: one a pane is showing,
   * or an unnamed one whose entry is acquiring for its metadata. Everything
   * else stays `unclaimed`, as a hidden tab always was.
   */
  function claimTabsInDemand(entry: ControllerEntry): void {
    const surfaced = surfaces.get(entry.epicId);
    for (const [tabId, membership] of entry.tabs) {
      if (membership.ownership !== "unclaimed") continue;
      const shown = surfaced?.has(tabId) === true;
      const holdsMetadataDemand = !entry.suspended && !tabHasRealName(tabId);
      if (shown || holdsMetadataDemand) claimTab(entry, tabId);
    }
  }

  function claimTab(entry: ControllerEntry, tabId: string): void {
    const membership = entry.tabs.get(tabId);
    if (membership === undefined) return;
    if (getDesktopEpicOwnershipBridge() === null) {
      membership.ownership = "browser";
      return;
    }
    membership.ownership = "claiming";
    // Captured BEFORE the await, both of them. The membership OBJECT, not the
    // tab id: a tab closed and reopened under the same id is a new membership
    // with its own claim, and an old reply - a denial above all, which
    // discards the tab - must not land on it. The auth epoch, because a
    // long-lived controller has no effect cleanup to cancel this continuation
    // when the identity it was issued under ends.
    const issuedEpoch = authEpoch;
    void claimDesktopEpicOwnership(tabId, entry.epicId).then((claim) => {
      const live = entries.get(entry.epicId);
      const current = live?.tabs.get(tabId);
      if (
        live !== entry ||
        current !== membership ||
        issuedEpoch !== authEpoch
      ) {
        // A grant nobody holds is handed back - unless a NEWER membership of
        // the same tab id is already holding or seeking the claim, in which
        // case it is that membership's to keep or release.
        const heldByNewer =
          live === entry &&
          current !== undefined &&
          (current.ownership === "claiming" || current.ownership === "claimed");
        if (claim.ok && !heldByNewer) void releaseDesktopEpicOwnership(tabId);
        return;
      }
      if (claim.ok) {
        membership.claimHeld = true;
        membership.ownership = "claimed";
        requestReconcile(entry.epicId);
        return;
      }
      membership.ownership = "denied";
      denyTab(entry, tabId, claim.currentOwner);
    });
  }

  /**
   * Another window owns this TAB, so this one gives the tab up. Not "another
   * window has this epic open": `EpicWindowOwnership.claim` keys on `tabId`
   * and never compares `epicId`, so a denial means the same tab id exists in
   * two windows (a move/restore race). Two windows CAN hold the same epic live
   * at once with different tab ids.
   *
   * Involuntary either way - no confirmation was shown - so retained buffers
   * stay: the departing membership releases with `"keep"`.
   */
  function denyTab(
    entry: ControllerEntry,
    tabId: string,
    currentOwner: string,
  ): void {
    const bridge = getDesktopEpicOwnershipBridge();
    // Told BEFORE the tab record goes, so a provider mounted for it can still
    // find its own tab in the event.
    for (const listener of Array.from(deniedListeners)) {
      listener(entry.epicId, tabId);
    }
    const cleanupPatch = useEpicCanvasStore.getState().discardTabState(tabId);
    void (async () => {
      if (bridge !== null && cleanupPatch !== null) {
        await bridge.perWindowState.update(cleanupPatch);
      }
      if (bridge !== null) await bridge.requestFocus(currentOwner);
    })();
  }

  /**
   * Put every desktop membership of `entry` back to `unclaimed`, as a FRESH
   * membership object so a claim still in flight for the old one is dropped
   * by `claimTab`'s identity fence. `browser`/`denied` are left alone: there
   * is nothing to claim, or the tab is already on its way out.
   *
   * `releaseHeld` says whether the claims still have to be handed back here
   * (an auth boundary) or already were by whoever told us (the registry's
   * release listener).
   */
  function resetDesktopMemberships(
    entry: ControllerEntry,
    releaseHeld: boolean,
  ): void {
    for (const [tabId, membership] of Array.from(entry.tabs)) {
      if (
        membership.ownership !== "claimed" &&
        membership.ownership !== "claiming"
      ) {
        continue;
      }
      if (releaseHeld) releaseTabClaim(tabId, membership);
      entry.tabs.set(tabId, { ownership: "unclaimed", claimHeld: false });
    }
  }

  /**
   * The registry released this epic's desktop ownership: a cap eviction, a
   * dead retirement, an identity discard - every route out of the registry
   * except a re-point and a park (`pendingPark`), which keep it on purpose.
   *
   * ONE owner for the claimed flag, reconciled to what actually happened: the
   * memberships go back to `unclaimed`, so the next demand RE-CLAIMS before it
   * acquires and another window's denial is seen. Left `claimed`, a re-shown
   * tab would skip the claim and publish a session for a tab that now belongs
   * to someone else.
   */
  function onOwnershipReleased(epicId: string): void {
    const entry = entries.get(epicId);
    if (entry === undefined) return;
    resetDesktopMemberships(entry, false);
    publishSnapshots(entry);
    requestReconcile(epicId);
  }

  /**
   * The identity these entries were built under has ended (sign-out, or a
   * different user). The provider got this boundary from being unmounted with
   * the auth-gated surface; the controller outlives that surface - its bridge
   * is mounted above it - so it is stated:
   *
   *  - every pending continuation is invalidated (`authEpoch`, and each run);
   *  - the ladder is disarmed, so nothing retries into the next identity;
   *  - the create-host seed is dropped - it was a fact about the last user's
   *    create race;
   *  - desktop claims are handed back and re-issued on the next demand;
   *  - a hidden entry suspends. A surfaced one resumes when its inputs move,
   *    which for a user switch is this same notification.
   *
   * Sessions themselves are not touched here: `disposeAll` (sign-out) and the
   * run's identity arm (user switch) own that, as before.
   */
  function onAuthBoundary(): void {
    authEpoch += 1;
    for (const entry of Array.from(entries.values())) {
      cancelRun(entry);
      cancelGapDeadline(entry);
      // Nothing writes after the identity ends - the Query-cache subscription
      // above all, which would otherwise outlive the sign-out.
      detachWriteThroughs(entry);
      entry.backoff.cancel();
      entry.requestedHostId = null;
      entry.seededCreateHost = false;
      resetDesktopMemberships(entry, true);
      if (surfaceCount(entry.epicId) === 0) suspend(entry);
      publishSnapshots(entry);
    }
  }

  function releaseTabClaim(tabId: string, membership: TabMembership): void {
    if (membership.claimHeld) {
      membership.claimHeld = false;
      void releaseDesktopEpicOwnership(tabId);
    }
  }

  // ── Membership ────────────────────────────────────────────────────────────

  function createEntry(epicId: string): ControllerEntry {
    const requestedHostId = sessionCreatedEpicHostId(epicId);
    const effectiveHostId =
      useSelectionAuthorityStore.getState().effectiveHostId;
    return {
      epicId,
      tabs: new Map(),
      session: null,
      published: null,
      demandHeld: false,
      suspended: false,
      constructionFailed: false,
      requestedHostId,
      seededCreateHost: requestedHostId !== null,
      lastEffectiveHostId: effectiveHostId,
      originalHostId: null,
      retryGeneration: 0,
      presentation: {
        kind: "establishing",
        targetHostId: requestedHostId ?? effectiveHostId,
        originalHostId: null,
      },
      backoff: createPlanRestrictedSessionRebuildBackoff(),
      backoffScopeKey: null,
      run: null,
      runKey: null,
      gapDeadline: null,
      gapKey: null,
      metadataHold: null,
      sessionHostClient: null,
      tabSnapshots: new Map(),
      lastTabSnapshots: new Map(),
      suspendedInputKey: null,
      metadataDemandSpent: false,
      writeThroughs: null,
    };
  }

  function syncOpenTabs(
    open: ReadonlyMap<string, ReadonlyArray<string>>,
  ): void {
    const touched: string[] = [];
    for (const [epicId, tabIds] of open) {
      let entry = entries.get(epicId);
      const created = entry === undefined;
      if (entry === undefined) {
        entry = createEntry(epicId);
        entries.set(epicId, entry);
      }
      const joined = joinTabs(entry, tabIds);
      decideJoinDemand(entry, created, joined);
      if (joined.length > 0 && !created) restartRunIfSessionless(entry);
      const departed = departTabs(entry, tabIds);
      if (joined.length > 0 || departed) touched.push(epicId);
    }
    for (const [epicId, entry] of Array.from(entries)) {
      if (open.has(epicId)) continue;
      leave(entry);
    }
    for (const epicId of touched) requestReconcile(epicId);
  }

  /**
   * A FRESH demand - a new pane, a new tab - on an entry with no live session
   * acquires, whatever the run key says. This is the corpse window: a runtime
   * fatal leaves the entry `failed` under an unchanged key until Retry, and a
   * surface that arrives meanwhile must get a rebuilt handle from the seam
   * rather than inherit the wait.
   */
  function restartRunIfSessionless(entry: ControllerEntry): void {
    const session = entry.session;
    if (session !== null && !isEpicSessionHandleDead(session.handle)) return;
    cancelRun(entry);
  }

  /** Add the tabs new to this entry; returns the ids added. */
  function joinTabs(
    entry: ControllerEntry,
    tabIds: ReadonlyArray<string>,
  ): ReadonlyArray<string> {
    const joined: string[] = [];
    for (const tabId of tabIds) {
      if (entry.tabs.has(tabId)) continue;
      entry.tabs.set(tabId, {
        // No desktop bridge means nothing to claim, now or later.
        ownership:
          getDesktopEpicOwnershipBridge() === null ? "browser" : "unclaimed",
        claimHeld: false,
      });
      joined.push(tabId);
    }
    return joined;
  }

  /**
   * MEMBERSHIP is unconditional; a SESSION needs demand, and demand has two
   * sources: a pane showing the tab, or unobserved metadata (the tab record
   * has no real name yet). A hidden tab with a real name has neither, so its
   * entry starts suspended - exactly what it was before tabs owned sessions,
   * and what keeps N restored tabs from building N workers at boot.
   */
  function decideJoinDemand(
    entry: ControllerEntry,
    created: boolean,
    joined: ReadonlyArray<string>,
  ): void {
    const joinedUnnamed = joined.some((tabId) => !tabHasRealName(tabId));
    if (created) {
      if (surfaceCount(entry.epicId) === 0 && !joinedUnnamed) suspend(entry);
      return;
    }
    // An unnamed tab joining an entry that never had a session is the same
    // demand arriving late. One that was parked or evicted stays released.
    if (!joinedUnnamed || !entry.suspended) return;
    if (entry.metadataDemandSpent || isEpicParked(entry.epicId)) return;
    entry.suspended = false;
  }

  /** Drop the tabs no longer open; returns whether any left. */
  function departTabs(
    entry: ControllerEntry,
    tabIds: ReadonlyArray<string>,
  ): boolean {
    let departed = false;
    for (const [tabId, membership] of Array.from(entry.tabs)) {
      if (tabIds.includes(tabId)) continue;
      // A departing membership releases only ITS claim; the session stays
      // for the tabs that remain.
      entry.tabs.delete(tabId);
      entry.lastTabSnapshots.delete(tabId);
      releaseTabClaim(tabId, membership);
      departed = true;
    }
    return departed;
  }

  function tabHasRealName(tabId: string): boolean {
    return isRealEpicTitle(useEpicCanvasStore.getState().tabsById[tabId]?.name);
  }

  function readTargetHostId(entry: ControllerEntry): string | null {
    return (
      entry.requestedHostId ??
      useSelectionAuthorityStore.getState().effectiveHostId
    );
  }

  /** The inputs a SURFACED suspended entry watches to know it may rebuild. */
  function readInputKey(entry: ControllerEntry): string {
    return [
      readUserId() ?? "",
      readTargetHostId(entry) ?? "",
      String(entry.retryGeneration),
    ].join(KEY_SEPARATOR);
  }

  function suspend(entry: ControllerEntry): void {
    entry.suspended = true;
    entry.suspendedInputKey = readInputKey(entry);
  }

  /** The last tab left: release the session and forget the entry. */
  function leave(entry: ControllerEntry): void {
    entries.delete(entry.epicId);
    detachWriteThroughs(entry);
    // Decided from the tabs that are leaving NOW, not remembered on the entry:
    // a denial of one tab must not turn a later, confirmed close of another
    // into a "keep".
    const departing = Array.from(entry.tabs.values());
    const involuntary =
      departing.length > 0 &&
      departing.every((tab) => tab.ownership === "denied");
    cancelRun(entry);
    cancelGapDeadline(entry);
    cancelMetadataHold(entry);
    entry.backoff.cancel();
    for (const [tabId, membership] of entry.tabs) {
      releaseTabClaim(tabId, membership);
    }
    entry.tabs.clear();
    entry.session = null;
    entry.published = null;
    entry.demandHeld = false;
    // Tab close is the one release path where a decision was offered: the
    // close confirmation reads `epicHasUnsyncedEdits`, which covers retained
    // buffers, so a user-driven leave discards them too. The involuntary
    // path (a denied ownership claim) keeps them.
    registry.release(entry.epicId, involuntary ? "keep" : "discard", null);
    publishSnapshots(entry);
  }

  // ── Demand ────────────────────────────────────────────────────────────────

  function wantsDemand(entry: ControllerEntry): boolean {
    return surfaceCount(entry.epicId) > 0 || entry.metadataHold !== null;
  }

  /**
   * Drop the mount unit once nothing wants residency. Taking one is the
   * acquire arm's job, because taking demand IS an acquisition
   * (`acquireMounted`, with its `retireIfDead`).
   */
  function settleDemand(entry: ControllerEntry): void {
    if (wantsDemand(entry)) return;
    if (!entry.demandHeld) {
      // A hidden session held at no demand (a Retry that adopted a warm
      // handle): the same rule, there is just no unit to hand back.
      if (entry.session !== null && !entry.suspended) suspend(entry);
      return;
    }
    entry.demandHeld = false;
    // Nothing demands residency any more, so the controller stops owning the
    // question: the session sits warm for the cap and parking to decide, and
    // if either takes it, nothing here brings it back until a pane looks.
    suspend(entry);
    cancelRun(entry);
    // May prune THIS entry: it is now demand-free, and the cap decides.
    registry.releaseMounted(entry.epicId);
  }

  function needsMetadataHold(entry: ControllerEntry): boolean {
    if (entry.metadataDemandSpent) return false;
    return Array.from(entry.tabs.keys()).some(
      (tabId) => !tabHasRealName(tabId),
    );
  }

  function cancelMetadataHold(entry: ControllerEntry): void {
    const hold = entry.metadataHold;
    if (hold === null) return;
    entry.metadataHold = null;
    hold.unsubscribe();
    window.clearTimeout(hold.timer);
  }

  /**
   * Keep a freshly built HIDDEN session resident until its first non-empty
   * title is observed, bounded by the pending-title backstop. The title read
   * is the store's own `epic.title` - the doc/lane title the generated title
   * is written to - not the workspace-context light, which the host fills
   * with a placeholder.
   */
  function startMetadataHold(
    entry: ControllerEntry,
    handle: OpenEpicStoreHandle,
  ): void {
    cancelMetadataHold(entry);
    const end = (): void => {
      if (entry.metadataHold?.handle !== handle) return;
      // Ran to its end - a real title, or the backstop. A hold that was
      // cancelled (a park, an eviction, sign-out) spends nothing.
      entry.metadataDemandSpent = true;
      cancelMetadataHold(entry);
      settleDemand(entry);
      publishSnapshots(entry);
    };
    const observe = (): void => {
      // Observed only. The title is WRITTEN by the session's tab-name
      // write-through, which was attached before this hold and so runs first
      // on the same notification: one writer, and the record is real by the
      // time the hold lets the session go.
      if (!sessionHasRealTitle(handle)) return;
      end();
    };
    const unsubscribe = handle.store.subscribe(observe);
    const timer = window.setTimeout(end, TITLE_GENERATION_PENDING_TIMEOUT_MS);
    entry.metadataHold = { handle, unsubscribe, timer };
    observe();
  }

  // ── Surfaces ──────────────────────────────────────────────────────────────

  function attachSurface(epicId: string, tabId: string): () => void {
    let set = surfaces.get(epicId);
    if (set === undefined) {
      set = new Set();
      surfaces.set(epicId, set);
    }
    set.add(tabId);
    const entry = entries.get(epicId);
    if (entry !== undefined) {
      // A pane is looking: a parked or evicted session is rebuilt, cold.
      entry.suspended = false;
      restartRunIfSessionless(entry);
    }
    requestReconcile(epicId);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      const current = surfaces.get(epicId);
      if (current === undefined) return;
      current.delete(tabId);
      if (current.size === 0) surfaces.delete(epicId);
      requestReconcile(epicId);
    };
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  function requestReconcile(epicId: string): void {
    pendingReconcile.add(epicId);
    drainReconcile();
  }

  function requestReconcileAll(): void {
    reconcileAllPending = true;
    drainReconcile();
  }

  function drainReconcile(): void {
    if (reconciling) return;
    reconciling = true;
    try {
      // Bounded: each pass clears what it drains, and an arm that requests a
      // reconcile of its own entry converges (a stable run key is a no-op).
      for (let guard = 0; guard < 64; guard += 1) {
        if (reconcileAllPending) {
          reconcileAllPending = false;
          pendingReconcile.clear();
          for (const entry of Array.from(entries.values())) reconcile(entry);
          continue;
        }
        if (pendingReconcile.size === 0) break;
        const epicIds = Array.from(pendingReconcile);
        pendingReconcile.clear();
        for (const epicId of epicIds) {
          const entry = entries.get(epicId);
          if (entry !== undefined) reconcile(entry);
        }
      }
    } finally {
      reconciling = false;
    }
  }

  function cancelRun(entry: ControllerEntry): void {
    const run = entry.run;
    entry.run = null;
    entry.runKey = null;
    if (run === null) return;
    run.cancelled = true;
    run.cleanup();
  }

  function cancelGapDeadline(entry: ControllerEntry): void {
    if (entry.gapDeadline !== null) window.clearTimeout(entry.gapDeadline);
    entry.gapDeadline = null;
    entry.gapKey = null;
  }

  /**
   * A selection gap must be visible, but the authority's `null` carries TWO
   * meanings and only one is a gap: until this window's kernel has ATTACHED,
   * nobody has answered yet. Hold `establishing` while detached - bounded by
   * the same deadline, since an unbounded skeleton is the defect - and fail
   * at once only once the authority IS attached and still names no host.
   */
  function syncGapPresentation(
    entry: ControllerEntry,
    inputs: ReconcileInputs,
  ): void {
    const { authorityAttached, ownershipClaimed, targetHostId } = inputs;
    // Only for an entry that would otherwise be acquiring: a suspended hidden
    // tab has nobody to show a gap to, and N restored tabs must not arm N
    // deadlines at boot.
    const wantsSession = inputs.mounted || !entry.suspended;
    const key =
      wantsSession && ownershipClaimed && targetHostId === null
        ? `${authorityAttached ? 1 : 0}:${entry.retryGeneration}`
        : null;
    if (key === entry.gapKey) return;
    cancelGapDeadline(entry);
    entry.gapKey = key;
    if (key === null) return;
    const presentGap = (): void => {
      present(entry, {
        kind: "failed",
        targetHostId: null,
        originalHostId: entry.originalHostId,
      });
    };
    if (authorityAttached) {
      presentGap();
      return;
    }
    present(entry, {
      kind: "establishing",
      targetHostId: null,
      originalHostId: entry.originalHostId,
    });
    entry.gapDeadline = window.setTimeout(() => {
      entry.gapDeadline = null;
      presentGap();
    }, ESTABLISHING_DEADLINE_MS);
  }

  /** Everything one reconcile pass reads, taken once so its arms agree. */
  function readReconcileInputs(entry: ControllerEntry): ReconcileInputs {
    const selection = useSelectionAuthorityStore.getState();
    observeEffectiveHostMove(entry, selection.effectiveHostId);
    const targetHostId = entry.requestedHostId ?? selection.effectiveHostId;
    const sessionOrTargetHostId = entry.session?.hostId ?? targetHostId;
    entry.sessionHostClient = resolveClient(sessionOrTargetHostId);
    return {
      userId: readUserId(),
      targetHostId,
      authorityAttached: selection.attached,
      ownershipClaimed: Array.from(entry.tabs.values()).some(
        (tab) => tab.ownership === "claimed" || tab.ownership === "browser",
      ),
      parked: isEpicParked(entry.epicId),
      mounted: surfaceCount(entry.epicId) > 0,
      // Owner-identity discriminator (R-1), read off THE SESSION'S host - the
      // same client the stream runs on, not the app-wide one - and paired
      // with the host the reading DESCRIBES, so the two cannot drift.
      ownerIdentityKey: readOwnerIdentityKey(entry.sessionHostClient),
      ownerIdentityKeyHostId: sessionOrTargetHostId,
    };
  }

  /**
   * The ladder is cancelled when the scope it was armed for changes - the
   * provider's reset effect, keyed the same way.
   */
  function syncBackoffScope(
    entry: ControllerEntry,
    inputs: ReconcileInputs,
  ): void {
    const scopeKey = [
      inputs.ownershipClaimed ? "1" : "0",
      inputs.userId ?? "",
      inputs.targetHostId ?? "",
    ].join(KEY_SEPARATOR);
    const previous = entry.backoffScopeKey;
    entry.backoffScopeKey = scopeKey;
    if (previous !== null && previous !== scopeKey) entry.backoff.cancel();
  }

  /**
   * A SURFACED entry whose session was taken from underneath it (sign-out's
   * `disposeAll`) rebuilds once its inputs move - a new identity, a new
   * target - which is when a mounted provider's effect used to re-run. A
   * hidden entry never does: only a pane or the user brings it back.
   */
  function resumeSurfacedIfInputsMoved(
    entry: ControllerEntry,
    inputs: ReconcileInputs,
  ): void {
    if (!entry.suspended || !inputs.mounted || inputs.parked) return;
    if (entry.suspendedInputKey === readInputKey(entry)) return;
    entry.suspended = false;
  }

  /**
   * The identity of the run these inputs call for, or `null` for none. A
   * change cancels the run in flight - what the provider's effect deps did.
   */
  function computeRunKey(
    entry: ControllerEntry,
    inputs: ReconcileInputs,
  ): string | null {
    if (!inputs.ownershipClaimed || inputs.parked || entry.suspended) {
      return null;
    }
    if (inputs.targetHostId === null || environment === null) return null;
    // No acquisition, and so no construction failure to arm a ladder with,
    // after a sign-out and before the next identity.
    if (signedOutFence) return null;
    return [
      inputs.userId ?? "",
      inputs.targetHostId,
      String(entry.retryGeneration),
      inputs.ownerIdentityKey ?? "",
      inputs.ownerIdentityKeyHostId ?? "",
      inputs.mounted ? "mounted" : "hidden",
      // Taking demand is an acquisition, so the key has to move when a
      // surface starts wanting a session the controller holds no unit on.
      wantsDemand(entry) && !entry.demandHeld ? "wants" : "",
    ].join(KEY_SEPARATOR);
  }

  function reconcile(entry: ControllerEntry): void {
    if (entries.get(entry.epicId) !== entry) return;
    // A handle whose runtime worker died is not a session; it is a corpse
    // every arm below would treat as live. FORGETTING ONLY: the retirement
    // belongs to `acquireMounted`, the one line that hands a handle out.
    if (
      entry.session !== null &&
      isEpicSessionHandleDead(entry.session.handle)
    ) {
      forgetSession(entry);
    }
    claimTabsInDemand(entry);
    const inputs = readReconcileInputs(entry);
    syncBackoffScope(entry, inputs);
    syncGapPresentation(entry, inputs);
    resumeSurfacedIfInputsMoved(entry, inputs);

    const runKey = computeRunKey(entry, inputs);
    if (runKey !== entry.runKey) {
      cancelRun(entry);
      entry.runKey = runKey;
      if (runKey !== null && inputs.targetHostId !== null) {
        startRun(entry, {
          userId: inputs.userId,
          targetHostId: inputs.targetHostId,
          ownerIdentityKey: inputs.ownerIdentityKey,
          ownerIdentityKeyHostId: inputs.ownerIdentityKeyHostId,
          mounted: inputs.mounted,
        });
      }
    }
    settleDemand(entry);
    restampHostClient(entry);
    publishSnapshots(entry);
  }

  /** Clear THIS controller's reference; the registry decides the retirement. */
  function forgetSession(entry: ControllerEntry): void {
    entry.session = null;
    entry.published = null;
    entry.demandHeld = false;
    cancelMetadataHold(entry);
    // At once, not at the next publish: the handle is no longer this entry's.
    detachWriteThroughs(entry);
  }

  /**
   * Stamp the SAME client the snapshot provides onto the handle, for the
   * imperative callers outside any subtree (the DnD reparent commit) that
   * must address the host the session's records live on. Re-stamped on every
   * change, unlike `handleHostIds`: the host id is the handle's transport
   * binding and must not drift, the client is a requester for that binding
   * and legitimately rotates.
   */
  function restampHostClient(entry: ControllerEntry): void {
    if (entry.published === null) return;
    handleHostClients.set(entry.published, entry.sessionHostClient);
  }

  /** PUBLISHED ON A MICROTASK - see the module doc on publish channels. */
  function publishHandle(
    entry: ControllerEntry,
    run: ActiveRun,
    handle: OpenEpicStoreHandle,
  ): void {
    // `session` is already the synchronous truth; this only moves what
    // consumers see.
    queueMicrotask(() => {
      if (run.cancelled) return;
      if (entries.get(entry.epicId) !== entry) return;
      if (entry.session?.handle !== handle) return;
      entry.published = handle;
      restampHostClient(entry);
      publishSnapshots(entry);
    });
  }

  /** The factory a run hands `acquireMounted`, and the re-point calls itself. */
  function handleFactoryFor(
    entry: ControllerEntry,
    env: EpicSessionControllerEnvironment,
    inputs: RunInputs,
  ): () => OpenEpicStoreHandle {
    const { epicId } = entry;
    const { targetHostId, userId } = inputs;
    return () =>
      createEpicSessionHandle({
        epicId,
        // The host THIS handle is constructed against, passed as the
        // handle's own host so its requester keeps meaning that host after
        // the entry has re-pointed away from it.
        hostId: targetHostId,
        userId,
        openTransport: env.openTransport,
        // READ AT CALL TIME, never captured: the cross-host refusal depends
        // on seeing the entry's target and session as they are when asked.
        readRequesterTarget: (): EpicSessionRequesterTarget => {
          const liveTargetHostId = readTargetHostId(entry);
          const sessionHostId = entry.session?.hostId ?? null;
          return {
            targetHostId: liveTargetHostId,
            targetHostClient: resolveClient(liveTargetHostId),
            sessionHostId,
            sessionHostClient: resolveClient(sessionHostId),
          };
        },
        onAuthError: () => {
          environment?.revalidateAuth();
        },
        adoptLegacyPersistKey: (adoptForUserId) => {
          adoptLegacyOpenEpicKey(epicId, adoptForUserId);
        },
        onPlanRestrictedDenial: (owner) => {
          entry.backoff.request(owner, () => {
            owner.retryTransport();
          });
        },
        markHealthy: () => {
          entry.backoff.markHealthy();
        },
        // `failed` is the presentation that carries the Retry affordance; the
        // factory has already marked the handle so the next acquisition pass
        // retires it rather than re-presenting the corpse as `ready`.
        onRuntimeFatal: () => {
          present(entry, {
            kind: "failed",
            targetHostId,
            originalHostId: entry.originalHostId,
          });
        },
        // No presentation: a clean session rebuilding after a deadline the
        // user never saw should not flash a failure. The acquire pass presents
        // `establishing` on its own.
        onRetryTransport: () => {
          bumpRetry(entry);
        },
      });
  }

  /**
   * Identity changes are security boundaries, not re-points: discard the old
   * user/owner session before opening another stream. The two arms differ on
   * RETAINED buffers: a different `userId` is another person at the keyboard
   * (`disposeAll`'s policy); an owner-identity rotation is detected on ONE
   * host while retained buffers can belong to others.
   */
  function discardForIdentityChange(
    entry: ControllerEntry,
    current: MountedSessionState,
    userId: string | null,
  ): void {
    const userChanged = current.handle.userId !== userId;
    forgetSession(entry);
    if (userChanged) {
      registry.releaseForSignOut(entry.epicId, "discard", null);
      return;
    }
    registry.releaseForRetryRebuild(entry.epicId, "keep", {
      hostStamp: current.hostId,
      ownerIdentityKey: current.ownerIdentityKey,
    });
  }

  /**
   * Construction threw. The entry stays observable as `failed` with no live
   * handle, so a surface mounting later shows Retry, and the retry schedule
   * is the entry's own ladder - no React, and not on every notification.
   *
   * The attempt that just failed IS the ladder's immediate rung (a Worker
   * constructor that threw will not succeed a microtask later), so it is
   * claimed with a no-op and the rebuild rides the first delayed rung.
   */
  function failConstruction(
    entry: ControllerEntry,
    targetHostId: string,
    error: unknown,
  ): void {
    appLogger.error(
      "epic session worker failed to start",
      { epicId: entry.epicId },
      error instanceof Error ? error : new Error(String(error)),
    );
    forgetSession(entry);
    entry.constructionFailed = true;
    present(entry, {
      kind: "failed",
      targetHostId,
      originalHostId: entry.originalHostId,
    });
    entry.backoff.request({}, () => undefined);
    entry.backoff.request({}, () => {
      bumpRetry(entry);
    });
  }

  /**
   * Take the entry's mount unit through THE SEAM (`acquireMounted`, with its
   * `retireIfDead`), adopting a warm handle or building a fresh one.
   */
  function acquireForRun(args: {
    readonly entry: ControllerEntry;
    readonly run: ActiveRun;
    readonly inputs: RunInputs;
    readonly createHandle: () => OpenEpicStoreHandle;
  }): void {
    const { entry, run, inputs, createHandle } = args;
    const { epicId } = entry;
    const { targetHostId } = inputs;
    // GUARDED, because `createHandle` runs synchronously inside this call
    // and the very first thing it does is construct a Worker, which throws
    // outright where the runtime has none or a CSP refuses the script URL.
    let nextHandle: OpenEpicStoreHandle;
    try {
      nextHandle = registry.acquireMounted(epicId, createHandle);
    } catch (error: unknown) {
      failConstruction(entry, targetHostId, error);
      return;
    }
    entry.demandHeld = true;
    entry.constructionFailed = false;
    // The stamp is written once, at construction. When the registry returns
    // a WARM handle the factory never ran and the stamp names the host the
    // handle's transport was built for - not necessarily `targetHostId`.
    // Recording the stamp rather than the target is the F1 fix: a warm
    // handle bound elsewhere takes the safe re-point arm on the next pass
    // instead of streaming from one host while labelled with another.
    const stampedHostId = requireConstructionHostStamp(nextHandle);
    const nextSession: MountedSessionState = {
      handle: nextHandle,
      hostId: stampedHostId,
      ownerIdentityKey: ownerIdentityKeyForHost(
        stampedHostId,
        inputs.ownerIdentityKey,
        inputs.ownerIdentityKeyHostId,
      ),
    };
    entry.session = nextSession;
    // The recovery affordance ("Open on original host") must name a host
    // this session actually served - for a warm adoption, the handle's
    // bound host rather than wherever the window moved meanwhile.
    entry.originalHostId ??= nextSession.hostId;
    // BEFORE the hold: a warm handle that already carries its title ends the
    // hold in its first observation, and the tab record must be real by then.
    syncWriteThroughs(entry);
    // Unobserved metadata is its OWN demand source, not a property of being
    // hidden: a session acquired while a pane happens to be showing an unnamed
    // tab still has a title to observe, and the pane can leave first. So the
    // bounded hold starts whatever the surface count, and the one-shot is
    // spent only by a hold that ran to its end.
    if (needsMetadataHold(entry) && entry.metadataHold?.handle !== nextHandle) {
      startMetadataHold(entry, nextHandle);
      // The hold can end inside its own first observation (a title already
      // real), which drops the demand and lets the cap take the session.
      if (entry.session !== nextSession) return;
    }
    entry.sessionHostClient = resolveClient(nextSession.hostId);
    if (entry.published !== nextHandle) publishHandle(entry, run, nextHandle);
    present(entry, {
      kind: "ready",
      targetHostId,
      originalHostId: entry.originalHostId,
    });
    // A warm handle bound elsewhere re-points on the NEXT pass, which the
    // stamp forces: re-run now rather than wait for an unrelated input. A
    // hidden one does not re-point, but its tuple was recorded honest-absent
    // (the reading described the target, not the handle's host) and still has
    // to be completed.
    if (nextSession.hostId === targetHostId) return;
    if (inputs.mounted) requestReconcileRun(entry);
    else scheduleOwnerIdentityCompletion(entry);
  }

  /**
   * A tuple recorded honest-ABSENT (R-1, B5) has to be COMPLETED from its own
   * host's reading before any rotation of that host can be seen - otherwise
   * the first rotation is read as the initial completion, and the old worker
   * and document are carried across an identity boundary.
   *
   * The provider got this for free: `setSession(next)` re-rendered, the render
   * read the new host's key, and the effect re-ran. Nothing re-renders a
   * controller, and the registry's own notification lands inside
   * `replaceMounted`, BEFORE `entry.session` moves, so it cannot be the
   * trigger. Stated instead: one reconcile, which reads the key off the
   * session's new host and takes the `completed` arm.
   */
  function scheduleOwnerIdentityCompletion(entry: ControllerEntry): void {
    requestReconcile(entry.epicId);
  }

  /**
   * R-1: see `readOwnerIdentityVerdict` for the invariant this enforces.
   * Returns the session the run continues with - `null` when an identity
   * change discarded it.
   */
  function settleSessionIdentity(
    entry: ControllerEntry,
    inputs: RunInputs,
  ): MountedSessionState | null {
    const verdict = readOwnerIdentityVerdict(
      entry.session,
      inputs.ownerIdentityKey,
      inputs.ownerIdentityKeyHostId,
    );
    if (verdict.kind === "completed") {
      // A write, not a terminal arm: control continues to the host
      // comparison in this same run. Honest by construction - the verdict is
      // only reachable after the same-host check, so the key provably
      // describes the session's own host already.
      entry.session = verdict.session;
    }
    const current = entry.session;
    if (current === null) return null;
    const identityChanged =
      current.handle.userId !== inputs.userId || verdict.kind === "rotated";
    if (!identityChanged) return current;
    discardForIdentityChange(entry, current, inputs.userId);
    return null;
  }

  function startRun(entry: ControllerEntry, inputs: RunInputs): void {
    const env = environment;
    if (env === null) return;
    const { targetHostId } = inputs;
    const run: ActiveRun = { cancelled: false, cleanup: () => undefined };
    entry.run = run;
    const createHandle = handleFactoryFor(entry, env, inputs);
    const current = settleSessionIdentity(entry, inputs);
    if (current === null || (wantsDemand(entry) && !entry.demandHeld)) {
      acquireForRun({ entry, run, inputs, createHandle });
      return;
    }
    // Held but not yet shown: the run that acquired it was superseded before
    // its publish microtask ran (a surface attached in the same tick).
    if (entry.published !== current.handle) {
      publishHandle(entry, run, current.handle);
    }
    if (current.hostId === targetHostId) {
      present(entry, {
        kind: "ready",
        targetHostId,
        originalHostId: entry.originalHostId,
      });
      return;
    }
    // A hidden session keeps its warm handle and takes the safe re-point arm
    // when a surface attaches - a derivation move is not a reason to churn
    // every hidden session's transport, and it never was: an unmounted
    // provider re-pointed nothing.
    if (!inputs.mounted) return;
    startRepoint({ entry, run, current, inputs, createHandle });
  }

  /**
   * Restart the run for an entry whose acquisition adopted a warm handle bound
   * to another host: the same inputs, one pass later, take the re-point arm.
   */
  function requestReconcileRun(entry: ControllerEntry): void {
    cancelRun(entry);
    requestReconcile(entry.epicId);
  }

  function bumpRetry(entry: ControllerEntry): void {
    entry.retryGeneration += 1;
    requestReconcile(entry.epicId);
  }

  function startRepoint(args: {
    readonly entry: ControllerEntry;
    readonly run: ActiveRun;
    readonly current: MountedSessionState;
    readonly inputs: RunInputs;
    readonly createHandle: () => OpenEpicStoreHandle;
  }): void {
    const { entry, run, current, inputs, createHandle } = args;
    const { epicId } = entry;
    const { targetHostId, ownerIdentityKey, ownerIdentityKeyHostId } = inputs;
    // The previous handle remains registered and published while its
    // successor establishes. The successor is deliberately outside the
    // registry until a complete snapshot makes an atomic replacement possible.
    let nextHandle: OpenEpicStoreHandle;
    try {
      nextHandle = createHandle();
    } catch (error: unknown) {
      appLogger.error(
        "epic session worker failed to start",
        { epicId },
        error instanceof Error ? error : new Error(String(error)),
      );
      present(entry, {
        kind: "failed",
        targetHostId,
        originalHostId: entry.originalHostId,
      });
      return;
    }
    const disposeRepointCandidate = (): void => {
      attributeEpicSessionTransportClose(nextHandle, "repoint");
      nextHandle.dispose();
    };
    present(entry, {
      kind: "establishing",
      targetHostId,
      originalHostId: entry.originalHostId,
    });
    let settled = false;
    const disposePending = (): void => {
      if (settled) return;
      settled = true;
      disposeRepointCandidate();
    };
    /**
     * The registry's mounted handle changed underneath this run to something
     * that is neither the outgoing handle nor this candidate. One controller
     * per renderer means no sibling races a re-point any more, but the arm is
     * kept: it is the same "handle gone underneath us" observation the
     * registry listener makes, and adopting is strictly safer than presenting
     * `establishing` forever on a handle the registry no longer holds.
     */
    const adoptWinner = (winner: OpenEpicStoreHandle): void => {
      settled = true;
      disposeRepointCandidate();
      if (isEpicSessionHandleDead(winner)) {
        present(entry, {
          kind: "failed",
          targetHostId,
          originalHostId: entry.originalHostId,
        });
        return;
      }
      const stampedHostId = requireConstructionHostStamp(winner);
      const nextSession: MountedSessionState = {
        handle: winner,
        hostId: stampedHostId,
        ownerIdentityKey: ownerIdentityKeyForHost(
          stampedHostId,
          ownerIdentityKey,
          ownerIdentityKeyHostId,
        ),
      };
      entry.session = nextSession;
      entry.published = winner;
      entry.sessionHostClient = resolveClient(stampedHostId);
      restampHostClient(entry);
      if (stampedHostId === targetHostId) {
        present(entry, {
          kind: "ready",
          targetHostId,
          originalHostId: entry.originalHostId,
        });
      }
      publishSnapshots(entry);
      scheduleOwnerIdentityCompletion(entry);
    };
    const commitReplacement = (): void => {
      if (run.cancelled || settled) return;
      if (entry.session !== current) {
        disposePending();
        return;
      }
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
      // Whether to ATTEMPT the transfer - not whether it happened; the
      // outcome is only known in the tail.
      const shouldTransferEdits = shouldMergeEpicRoomSwap(
        { roomId: previousRoomId },
        { roomId: nextRoomId },
      );
      void transferThenComplete(shouldTransferEdits, current, targetHostId);
    };

    async function transferThenComplete(
      shouldTransferEdits: boolean,
      outgoing: MountedSessionState,
      hostId: string,
    ): Promise<void> {
      let editsTransferredToReplacement = false;
      // The candidate's ARM decides whether a root apply is a transfer at
      // all, RE-READ ACROSS EVERY AWAIT: a lane probe can resolve mid-flight,
      // and on the lane arm a root apply lands in a document whose outbound
      // path drops it. The flag is a data-loss guard, so the unknown answer
      // is the conservative one.
      const destinationCarriesRootWrites = (): boolean =>
        armCarriesRootWrites(nextHandle.store.getState().installedArm);
      if (shouldTransferEdits && destinationCarriesRootWrites()) {
        try {
          const update = await outgoing.handle.encodeRootState();
          editsTransferredToReplacement =
            destinationCarriesRootWrites() &&
            (await nextHandle.applyRootUpdate(update, true)) &&
            destinationCarriesRootWrites();
        } catch {
          // The honest false: the edits still live only in the outgoing
          // handle, which the retention path must be told.
          editsTransferredToReplacement = false;
        }
      }
      if (run.cancelled || entries.get(epicId) !== entry) {
        // OWNERSHIP changed hands when `settled` was set: from then on THIS
        // function owns `nextHandle` on every exit, and the cleanup's
        // `disposePending()` is a no-op it cannot rely on.
        disposeRepointCandidate();
        return;
      }
      // A SECOND liveness question: not whether this re-point is still
      // wanted, but whether the thing it is about to install still exists.
      if (isEpicSessionHandleDead(nextHandle)) {
        disposeRepointCandidate();
        present(entry, {
          kind: "failed",
          targetHostId: hostId,
          originalHostId: entry.originalHostId,
        });
        return;
      }
      // Identity of the handle being REPLACED, for the retention (F10): the
      // construction stamp, never `current.hostId`. Carries the merge OUTCOME
      // too, from the same boolean the merge branched on.
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
        const winner = registry.peek(epicId);
        if (winner !== null && winner !== outgoing.handle) {
          adoptWinner(winner);
          return;
        }
        disposeRepointCandidate();
        present(entry, {
          kind: "failed",
          targetHostId: hostId,
          originalHostId: entry.originalHostId,
        });
        return;
      }
      const nextSession: MountedSessionState = {
        handle: nextHandle,
        hostId,
        // The captured reading describes the host this session was on when
        // the re-point STARTED, so recording it pairs the replacement with
        // the previous host's key and the next pass discards the handle that
        // is holding the merged document (B5). Honest-absent instead: the
        // completion fills the tuple from the new host's own reading on the
        // next pass, same handle, no rebuild.
        ownerIdentityKey: ownerIdentityKeyForHost(
          hostId,
          ownerIdentityKey,
          ownerIdentityKeyHostId,
        ),
      };
      entry.session = nextSession;
      entry.published = nextHandle;
      entry.sessionHostClient = resolveClient(hostId);
      restampHostClient(entry);
      // Re-point during a residency hold: the hold restarts on the replacement.
      if (entry.metadataHold !== null) startMetadataHold(entry, nextHandle);
      present(entry, {
        kind: "ready",
        targetHostId: hostId,
        originalHostId: entry.originalHostId,
      });
      publishSnapshots(entry);
      scheduleOwnerIdentityCompletion(entry);
    }

    const unsubscribe = nextHandle.store.subscribe(commitReplacement);
    // Woken by the registry as well, so a change underneath is seen the
    // moment it lands - not only once the candidate loads its snapshot.
    const unsubscribeRegistry = registry.subscribe(commitReplacement);
    const deadline = window.setTimeout(() => {
      if (run.cancelled || settled) return;
      disposePending();
      present(entry, {
        kind: "failed",
        targetHostId,
        originalHostId: entry.originalHostId,
      });
    }, ESTABLISHING_DEADLINE_MS);
    run.cleanup = () => {
      window.clearTimeout(deadline);
      unsubscribe();
      unsubscribeRegistry();
      disposePending();
    };
    commitReplacement();
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  function retry(epicId: string): void {
    const entry = entries.get(epicId);
    if (entry === undefined) return;
    // A user-authored Retry supersedes an automatic backed-off retry.
    entry.backoff.cancel();
    // Reaching Retry means the seeded open FAILED at the one job the seed
    // has, so give it up here too; a host the user named stays.
    if (entry.seededCreateHost) {
      entry.seededCreateHost = false;
      entry.requestedHostId = null;
    }
    // A retry after a park or an eviction rebuilds: the user asked.
    entry.suspended = false;
    // The re-acquire pass reuses a WARM handle on the same host, which is
    // the right answer for every failure the card reports except one: a
    // transport whose host has stopped answering. Ask the socket first and
    // force a re-dial when it says it is silent. Read off the HELD handle,
    // which a warm adoption and a replacement both reach.
    const heldHandle = entry.session?.handle;
    const streamClient =
      heldHandle === undefined
        ? undefined
        : handleStreamClients.get(heldHandle);
    if (streamClient?.isSilentFor?.(SESSION_SILENCE_TIMEOUT_MS) === true) {
      streamClient.reconnectAll(EPIC_RETRY_FORCE_RECONNECT_REASON, {
        probeFirst: false,
        wakeProbe: null,
      });
    }
    bumpRetry(entry);
  }

  function openOnOriginalHost(epicId: string): void {
    const entry = entries.get(epicId);
    if (entry === undefined) return;
    const originalHostId = entry.originalHostId;
    if (originalHostId === null) return;
    entry.backoff.cancel();
    // An explicit request replaces the seed and stops being one.
    entry.seededCreateHost = false;
    entry.requestedHostId = originalHostId;
    entry.suspended = false;
    bumpRetry(entry);
  }

  // ── Parking ───────────────────────────────────────────────────────────────

  /**
   * PARKED: no pane of this epic has been visible in any window for the park
   * window, so the parking module has released the session. This drops THIS
   * controller's reference and retracts the published handle SYNCHRONOUSLY;
   * nothing is re-acquired here. Showing the tab attaches a surface, which
   * clears `suspended`, and the next run builds a fresh handle - a cold open,
   * which is what a shown parked tab is meant to look like.
   *
   * The release is RE-ASSERTED rather than assumed, for the one order where
   * it is not already a no-op: a session acquired AFTER the parking release
   * (a host that only answered once the epic had already sat unwatched for
   * the whole window). A refusal means the epic became dirty or busy in that
   * gap; the signal is taken back down and the parking module retries on the
   * registry's own eligibility edge.
   */
  function onParkingChanged(epicId: string): void {
    const entry = entries.get(epicId);
    if (entry === undefined) return;
    if (isEpicParked(epicId)) {
      if (!registry.park(epicId)) {
        reportEpicParkRefused(epicId);
        return;
      }
      cancelRun(entry);
      forgetSession(entry);
      suspend(entry);
      present(entry, {
        kind: "establishing",
        targetHostId:
          entry.requestedHostId ??
          useSelectionAuthorityStore.getState().effectiveHostId,
        originalHostId: entry.originalHostId,
      });
      publishSnapshots(entry);
      return;
    }
    // Unparked: a surface is looking somewhere. This window rebuilds only if
    // one of ITS panes is attached; otherwise the tab stays released, as it
    // did when nothing was mounted for it.
    if (surfaceCount(epicId) > 0) entry.suspended = false;
    requestReconcile(epicId);
  }

  // ── The registry underneath ───────────────────────────────────────────────

  /**
   * The registry moved without this controller asking: the cap pruned a warm
   * session, sign-out disposed everything, or a park landed. The entry keeps
   * its membership and becomes SUSPENDED: no re-acquisition until a surface
   * attaches or the user retries, so the release those policies made stands.
   */
  function onRegistryChanged(): void {
    for (const entry of Array.from(entries.values())) {
      const session = entry.session;
      if (session === null) continue;
      const mounted = registry.peek(entry.epicId);
      if (mounted === session.handle) continue;
      if (mounted !== null) {
        // A replacement landing through this controller's own re-point tail
        // updates `session` before it notifies; anything else is that tail's
        // adoption arm's to observe.
        continue;
      }
      cancelRun(entry);
      forgetSession(entry);
      suspend(entry);
      present(entry, {
        kind: "establishing",
        targetHostId:
          entry.requestedHostId ??
          useSelectionAuthorityStore.getState().effectiveHostId,
        originalHostId: entry.originalHostId,
      });
      publishSnapshots(entry);
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  registry.subscribe(onRegistryChanged);
  subscribeEpicParking(onParkingChanged);
  useSelectionAuthorityStore.subscribe(requestReconcileAll);
  useAuthStore.subscribe((state, previous) => {
    const userId = state.profile?.userId ?? null;
    const previousUserId = previous.profile?.userId ?? null;
    const signedOutNow =
      state.status === "signed-out" && previous.status !== "signed-out";
    const identityEnded = previousUserId !== null && previousUserId !== userId;
    const boundary = signedOutNow || identityEnded;
    // The fence FIRST: the boundary republishes every entry, and that must
    // not re-attach a write-through under a sign-out.
    signedOutFence =
      state.status === "signed-out" && (signedOutFence || boundary);
    if (boundary) onAuthBoundary();
    const emailMoved = state.profile?.email !== previous.profile?.email;
    if (boundary || userId !== previousUserId || emailMoved) {
      requestReconcileAll();
    }
  });
  subscribeEpicOwnershipReleased(onOwnershipReleased);
  // A same-host public-key rotation is a ROW change (R-1), observed the same
  // way a host move is.
  subscribeAnyHostRowChanged(requestReconcileAll);

  return {
    syncOpenTabs,
    attachSurface,
    readTabSnapshot: (epicId, tabId) => {
      const entry = entries.get(epicId);
      if (entry === undefined) return NO_SESSION_SNAPSHOT;
      return tabSnapshotFor(entry, tabId);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeOwnershipDenied: (listener) => {
      deniedListeners.add(listener);
      return () => {
        deniedListeners.delete(listener);
      };
    },
    retry,
    openOnOriginalHost,
    installEnvironment: (next) => {
      environment = next;
      // Idempotent (one function, a Set underneath), and repeated here so the
      // subscription is tied to having an environment rather than to module
      // load: a registry reset that clears its listeners is healed by the
      // next install instead of silently ending R-1's rotation detection.
      subscribeAnyHostRowChanged(requestReconcileAll);
      requestReconcileAll();
    },
    uninstallEnvironment: (installed) => {
      if (environment !== installed) return;
      environment = null;
      requestReconcileAll();
    },
    readEntryStatusForTests: (epicId) => {
      const entry = entries.get(epicId);
      if (entry === undefined) return null;
      return {
        epicId,
        tabIds: Array.from(entry.tabs.keys()),
        hasSession: entry.session !== null,
        demandHeld: entry.demandHeld,
        suspended: entry.suspended,
        constructionFailed: entry.constructionFailed,
        metadataHold: entry.metadataHold !== null,
        presentation: entry.presentation,
      };
    },
    __resetForTests: () => {
      for (const entry of Array.from(entries.values())) {
        cancelRun(entry);
        cancelGapDeadline(entry);
        cancelMetadataHold(entry);
        detachWriteThroughs(entry);
        entry.backoff.cancel();
      }
      entries.clear();
      surfaces.clear();
      pendingReconcile.clear();
      reconcileAllPending = false;
      authEpoch += 1;
      signedOutFence = false;
      emit();
    },
  };
}

/**
 * The renderer's one controller. Module-scoped like the registry it drives,
 * for the same reason: membership outlives every route transition, and the
 * HMR co-lifetime with the stamp maps is what makes a warm handle's stamp
 * readable (F1).
 */
export const epicSessionController: EpicSessionController =
  createEpicSessionController();

export function getEpicSessionController(): EpicSessionController {
  return epicSessionController;
}

export function installEpicSessionControllerEnvironment(
  environment: EpicSessionControllerEnvironment | null,
): void {
  epicSessionController.installEnvironment(environment);
}

/** Remove `environment` if it is still the installed one. */
export function uninstallEpicSessionControllerEnvironment(
  environment: EpicSessionControllerEnvironment,
): void {
  epicSessionController.uninstallEnvironment(environment);
}

export function __resetEpicSessionControllerForTests(): void {
  epicSessionController.__resetForTests();
}
