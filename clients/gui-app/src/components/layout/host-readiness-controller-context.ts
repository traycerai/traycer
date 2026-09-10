import { createContext, use } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { MutationProgress } from "@traycer-clients/shared/platform/runner-host";
import type { HostStatusSnapshot } from "@/lib/host/compatibility-state";
import { dialableHostEndpointFor } from "@/lib/host/transport-key";
import { admitsLocalPlane, type AuthStatus } from "@/stores/auth/auth-store";

export type HostReadinessScope = "none" | "default-host" | "tab-host";

/**
 * COMPATIBILITY IS NOT A READINESS KIND (D13, P3.2).
 *
 * There used to be three more members here - `compatibility-checking`,
 * `compatibility-error`, `incompatible-host` - and a `readinessForCompatibility`
 * that projected the probe's verdict into this union, so a compat answer could
 * hold the whole window behind a full-screen card.
 *
 * The verdict now travels to the SELECTION AUTHORITY instead
 * (`compatibility-state.ts` reports it as evidence; the engine derives a
 * `dead: { reason: "incompatible" }` lease from it, ranked above a live
 * session). An incompatible host is therefore never usable, never a failover
 * candidate, and the window narrator - not this gate - says so.
 *
 * The consequence is deliberate and bounded: while the probe is in flight the
 * app mounts against a host that is dialable, and a later incompatible verdict
 * resolves through the engine (move off it, or ∅ with the modal's update-host
 * variant) rather than by blocking here. Blocking here is what put a second
 * narrator on screen for a fact the authority already owns.
 */
export type SurfaceReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "restoring-request-context" }
  | { readonly kind: "loading-host" }
  | { readonly kind: "mobile-no-host" }
  | { readonly kind: "unavailable-host" }
  | { readonly kind: "provisioning-host" }
  | { readonly kind: "provisioning-error" }
  | { readonly kind: "removed-host" };

/**
 * What the default-host surface is currently pointed at.
 *
 * Deliberately TRI-state. The predecessor was a boolean derived as
 * `targetEntry?.kind !== "remote"`, which answered `true` for an
 * `undefined` entry - so a target the app could not resolve at all inherited
 * every local-machine affordance: the bootstrap card with its respawn Retry,
 * the install-progress body, and the compat projection that turns a probe
 * failure into a full-screen `compatibility-error`. A switch aimed at a
 * remote host passes through exactly that unresolved window.
 *
 * `unknown` therefore behaves like `remote` by DEFAULT: pass readiness
 * through, offer no host-management action for a machine this app cannot
 * manage. The one exception is `localBootIntent` below - an unresolved target
 * the app is genuinely booting locally keeps its local lifecycle and its
 * install card, because a first-ever install has no directory entry until
 * provisioning creates one. `presentsLocalHostLifecycle` is where those two
 * facts are combined; read it rather than testing `targetKind` directly.
 */
export type HostTargetKind = "local" | "remote" | "unknown";

export interface DefaultHostReadinessPresentation {
  readonly targetKind: HostTargetKind;
  /**
   * Whether the app is booting THIS machine's own host - the only condition
   * under which a local-host lifecycle may be armed or a local-bootstrap
   * surface may be drawn.
   *
   * It exists because `targetKind` alone cannot answer that question while
   * the target is `unknown`. Two very different situations share that value:
   * a cold local start (nothing selected yet, or the selection names this
   * machine) and a remote host the user picked whose directory row has not
   * resolved. The first must run the local ensure and show the install card
   * with its progress and bootstrap.log path; the second must arm NOTHING
   * local - `convergeReady`, the removal-state read, and the one-shot attempt
   * latch all belong to a machine the user is not currently pointed at.
   * Derived from the directory's LIVE in-memory selection intent, which is
   * what makes the answer available before anything is bound - and correct
   * even when the best-effort persistence of that selection failed.
   */
  readonly localBootIntent: boolean;
  readonly localHostState: "unknown" | "ready" | "unavailable";
  readonly stage: "loading" | "slow";
  readonly progress: MutationProgress | null;
  /**
   * Last boot-progress event of the current provisioning attempt, non-null
   * only once that attempt has FAILED (when `progress` above has already
   * nulled out). The PROVISIONING-ERROR report reads it so a settled install
   * failure can still say where it died; live surfaces keep reading
   * `progress`.
   *
   * It is cleared only by a new attempt or a successful settle, so it can
   * outlive the surface that owned it - a host that failed to install and
   * then came up by some other route leaves it set. Consumers must therefore
   * scope it to the failure it explains rather than treating it as ambient
   * host state (see `includeRetainedProgress` in the readiness controller);
   * the provisioning-error card is safe because it renders only while that
   * attempt's error is still live.
   */
  readonly lastProgress: MutationProgress | null;
  readonly provisioningError: Error | null;
  readonly provisioning: boolean;
  readonly removed: boolean;
  readonly hostBusy: boolean;
  readonly canManageHost: boolean;
  readonly retryProvisioning: () => void;
  readonly forceProvisioning: () => void;
  readonly reinstall: () => void;
  readonly configureShell: () => void;
  /**
   * The recoveries for a window with nothing to point at, read by the window
   * modal's `offline` variant.
   *
   * They are host-MANAGEMENT-free on purpose: that state is reached when the
   * derivation had nowhere to go, which includes fleets holding only machines
   * this app cannot manage. Re-reading the registry and opening Settings ▸ Host
   * - which is where hosts are activated now - are what a user can do about
   * that from anywhere.
   *
   * They lost their third sibling with the gate's host-unavailable card:
   * `anyHostDialable`, which chose between two report families by scanning the
   * directory every render. Its question was directory vocabulary, and the
   * modal answers the same triage question from leases instead.
   */
  readonly refreshDirectory: () => void;
  readonly openSettings: () => void;
  // `requestRespawn`/`respawnPending` sat here too, owned once so two
  // default-host slots in a split shared one respawn lock. Their last renderer
  // was the host-boot body's slow-stage Retry, which P3.4 deleted along with
  // the wrappers - respawn is the desktop MENU command's job now (and the
  // health monitor's), both of which the window narrator already narrates
  // through the shared mutation lane.
  /**
   * The compat probe's last answer, kept for ONE consumer: the pre-filled
   * report's health line (`describeCompatHealth`).
   *
   * It is diagnostics, not narration. The fields that drove narration -
   * `errorMessage`, `retry`, `retrying` - went with the surfaces that read
   * them (the status strip and the gate's two compat cards, P3.2); leaving
   * them here would be the retry wiring orphaned rather than deleted. What a
   * user is TOLD about compatibility now comes from the lease's `incompatible`
   * arm, via the window narrator and the surface chip.
   */
  readonly compatibility: {
    readonly status: "checking" | "compatible" | "failed" | "incompatible";
    /**
     * `compatible` held from an earlier probe whose latest refetch failed.
     * A report says so - "compatible (degraded)" - because triage needs to
     * know the verdict was held rather than freshly answered. It is no longer
     * a user-facing state of its own (D11): a host that answered once and is
     * being re-probed is still working, and the strip that narrated it is
     * gone.
     */
    readonly degraded: boolean;
    /**
     * `failed` because the probe never reached the host, rather than because
     * the host rejected the handshake. Kept apart in the report for the reason
     * it was always kept apart: calling an unreachable host "incompatible" is
     * what made an offline host (traycer#858) and a load-stalled host
     * (traycer#860) both read as version problems.
     */
    readonly unreachable: boolean;
    /**
     * What the host's last `host.status` answer said about itself. Only a
     * `compatible` verdict has an answer to hold; the other states never
     * heard one, so this is null there. Carried for the pre-filled report's
     * health line - a busy host serving turns (traycer#860) must not read
     * like a host that never started.
     */
    readonly hostStatus: HostStatusSnapshot | null;
  };
}

export interface HostReadinessController {
  readonly readinessFor: (
    scope: HostReadinessScope,
    tabHostId: string | null,
  ) => SurfaceReadiness;
  readonly defaultHostPresentation: DefaultHostReadinessPresentation;
  /**
   * Whether default-host readiness has reached `ready` at least once in this
   * window - the gate's latch, LIFTED here because two surfaces need it.
   *
   * It lived as `useState` inside `DefaultHostReadyGate`, which was correct
   * while the gate was its only reader. The window modal now has to know
   * whether the gate is drawing a card (see {@link gateDrawsOwnCard}), and
   * that answer depends on this latch: before it, the gate draws its card for a
   * gate-owned kind; after it, the gate steps aside entirely and the modal is
   * the only narrator. A modal that suppressed itself on the KIND alone would
   * go silent in the second case too, leaving a failure nobody narrates.
   *
   * Still adjusted DURING RENDER by its owner (React's documented "adjusting
   * state when props change" pattern) rather than in an effect: the gate's whole
   * output is a function of it, so it has to be render-visible, and React re-runs
   * the render immediately - before committing - instead of painting an
   * un-latched frame first.
   *
   * MONOTONIC, and the widened re-render scope depends on that. It goes `false`
   * -> `true` exactly once per mount and is never set back, so lifting it costs
   * one extra render of this context's consumers per window rather than a
   * repeated global invalidation. A future change that could clear it would turn
   * that cost into a recurring one.
   */
  readonly hasBeenDefaultHostReady: boolean;
}

/**
 * Whether the default-host gate is replacing the app right now.
 *
 * Exported and shared rather than re-derived per caller, in the image of
 * {@link windowNarratorOwns}: ONE function, several readers. Two independent
 * derivations of "what is on screen" is what let a gate card and a window modal
 * narrate the same provisioning failure at once, so a second copy of this
 * predicate would be the same defect planted by hand.
 */
export function gateBlocksApp(args: {
  readonly readiness: SurfaceReadiness;
  readonly hasBeenReady: boolean;
  readonly signedIn: boolean;
  readonly bypassed: boolean;
}): boolean {
  // Only a signed-in user can HAVE a ready default host, so blocking anyone
  // else would hide the sign-in surface behind a host that cannot exist yet.
  if (!args.signedIn) return false;
  // Settings is the escape hatch for a host that cannot start - its Shell page
  // edits the launch config through the CLI with no running host involved.
  if (args.bypassed) return false;
  if (args.readiness.kind === "ready") return false;
  // After the first `ready` render the gate LATCHES and never replaces the app
  // again; `mobile-no-host` is the one kind that keeps its full-screen surface.
  if (args.hasBeenReady && !keepsSplashAfterLatch(args.readiness.kind)) {
    return false;
  }
  return true;
}

/**
 * Whether the gate is drawing a CARD of its own - which is a different question
 * from whether it is blocking.
 *
 * For a narrator-owned kind the gate still blocks (the app must not mount
 * against a host that cannot serve it) but draws only the frame, leaving the
 * words to the window modal. So "blocks" and "draws a card" come apart, and the
 * modal needs the second one: it must stand down exactly when this card is on
 * screen, and only then.
 *
 * Defined over the whole gate-drawn SET rather than a kind at a time. Every kind
 * `windowNarratorOwns` does not claim co-renders with the modal identically, so
 * naming one of them in a caller would fix one row and leave its neighbour
 * broken - while a test named for the fix passed. Any deliberate exclusion
 * belongs in here, with its reason, not at a call site.
 */
export function gateCardReadiness(args: {
  readonly readiness: SurfaceReadiness;
  readonly hasBeenReady: boolean;
  readonly signedIn: boolean;
  readonly bypassed: boolean;
}): GateDrawnReadiness | null {
  if (!gateBlocksApp(args)) return null;
  // Returns the NARROWED readiness rather than a boolean, and that is the whole
  // reason for this shape. `GateDrawnReadiness` excludes `ready` and every
  // narrator-owned kind, so answering with the value means the gate's renderer
  // can only ever be handed a kind it is allowed to draw - a COMPILE error
  // otherwise. That guarantee is why the type exists: it caught two full-screen
  // renderers sitting compiled-but-unreachable back when reachability was a
  // runtime predicate and nothing could see it. A boolean would have made the
  // caller re-narrow, which is one more place to get it wrong.
  if (args.readiness.kind === "ready") return null;
  if (windowNarratorOwns(args.readiness)) return null;
  return args.readiness;
}

/**
 * The boolean form, for readers that only need to know whether to stand down.
 *
 * A wrapper rather than a second implementation: the window modal suppresses
 * itself exactly when this card is on screen, and both surfaces must be answering
 * the same question with the same code.
 */
export function gateDrawsOwnCard(args: {
  readonly readiness: SurfaceReadiness;
  readonly hasBeenReady: boolean;
  readonly signedIn: boolean;
  readonly bypassed: boolean;
}): boolean {
  return gateCardReadiness(args) !== null;
}

const READY: SurfaceReadiness = { kind: "ready" };

const EMPTY_DEFAULT_HOST_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

export const HostReadinessControllerContext =
  createContext<HostReadinessController>({
    readinessFor: () => READY,
    defaultHostPresentation: EMPTY_DEFAULT_HOST_PRESENTATION,
    hasBeenDefaultHostReady: false,
  });

export function useHostReadinessController(): HostReadinessController {
  return use(HostReadinessControllerContext);
}

export function useSurfaceReadiness(
  scope: HostReadinessScope,
  tabHostId: string | null,
): SurfaceReadiness {
  return useHostReadinessController().readinessFor(scope, tabHostId);
}

/**
 * Delegated to `dialableHostEndpoint` rather than answered here, because this
 * predicate decides whether a surface renders at all (`unavailable-host`) and
 * the transport decides whether the socket opens. Two independent spellings of
 * "dialable" is how those two came apart: this one refused anything the
 * directory did not call `available`, so a failed liveness read blanked working
 * panels into a dead-end card while the stream one layer down was happily
 * connected to the same host.
 *
 * Coarse is the right SHAPE here — a surface either has a route or it does not,
 * and there is no per-reason copy to render behind this boolean. It just has to
 * be the same coarse answer the dial gives.
 *
 * `hasReadySession` is supplied by the caller rather than read from the
 * pull-only session cache here: this predicate is evaluated inside memoized
 * render paths (the controller's context value, `resolveSurfaceReadiness`),
 * and a readiness flip changes no value those paths otherwise subscribe to -
 * a direct cache read froze the answer until an unrelated re-render. The
 * provider subscribes through `useRemoteSessionsPollReadiness` and threads
 * the current answers down.
 */
export function isHostDialable(
  entry: HostDirectoryEntry | undefined,
  hasReadySession: boolean,
): boolean {
  return (
    entry !== undefined &&
    dialableHostEndpointFor(entry, hasReadySession) !== null
  );
}

/**
 * The effective host's lease, or `null` when the authority has not reached a
 * usable verdict about it.
 *
 * `null` covers three different situations that must all defer to the weaker
 * evidence rather than terminate the derivation: the kernel has not attached,
 * no lease exists for this host, and the lease says `connecting` — the
 * contract's non-committal state, which is also what an unknown status parses
 * to at the raw boundary. Reading any of them as failure would turn "we have
 * not found out yet" into a closed window.
 */
function defaultHostLease(args: {
  readonly activeHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  readonly authorityAttached: boolean;
}): HostLeaseSnapshot | null {
  if (!args.authorityAttached || args.activeHostId === null) return null;
  const lease = args.leases.find(
    (candidate) => candidate.hostId === args.activeHostId,
  );
  if (lease === undefined || lease.status === "connecting") return null;
  return lease;
}

/**
 * The app-wide surface's readiness. Extracted from
 * {@link resolveSurfaceReadiness} so each arm is readable on its own - the two
 * scopes answer genuinely different questions, and reading leases in one of
 * them made a single function branch on both a route and a verdict.
 */
function defaultHostReadiness(args: {
  readonly activeHostId: string | null;
  readonly requestContextUserId: string | null;
  readonly directoryEntries: ReadonlyArray<HostDirectoryEntry>;
  readonly hasLocalHost: boolean;
  readonly hasMobileNoHost: boolean;
  readonly hasReadySessionFor: (hostId: string) => boolean;
  readonly leases: readonly HostLeaseSnapshot[];
  readonly authorityAttached: boolean;
}): SurfaceReadiness {
  const activeEntry = args.directoryEntries.find(
    (candidate) => candidate.hostId === args.activeHostId,
  );
  if (
    args.activeHostId !== null &&
    args.requestContextUserId !== null &&
    isHostDialable(
      activeEntry,
      activeEntry !== undefined && args.hasReadySessionFor(activeEntry.hostId),
    )
  ) {
    return READY;
  }
  if (!args.hasLocalHost && args.hasMobileNoHost) {
    return { kind: "mobile-no-host" };
  }
  // The authority's verdict, where it has one, decides which of the two
  // not-ready kinds this is. Without it the choice was made by a proxy -
  // "is there an id" - which answers `loading-host` for a host that is
  // definitively gone and `unavailable-host` for one that is merely still
  // connecting. A dead lease is not loading, and a connecting one is not
  // unavailable; the lease is the only layer that knows which.
  const lease = defaultHostLease(args);
  if (lease !== null) {
    return lease.status === "dead"
      ? { kind: "unavailable-host" }
      : { kind: "loading-host" };
  }
  return args.activeHostId === null
    ? { kind: "loading-host" }
    : { kind: "unavailable-host" };
}

export function resolveSurfaceReadiness(args: {
  readonly scope: HostReadinessScope;
  readonly tabHostId: string | null;
  readonly authStatus: AuthStatus;
  readonly activeHostId: string | null;
  readonly requestContextUserId: string | null;
  readonly directoryEntries: ReadonlyArray<HostDirectoryEntry>;
  readonly hasLocalHost: boolean;
  readonly hasMobileNoHost: boolean;
  /**
   * Reactive per-host answer to `hasReadyRemoteSession`, threaded from the
   * provider's `useRemoteSessionsPollReadiness` subscription (see
   * {@link isHostDialable} for why this is an input and not a cache read).
   */
  readonly hasReadySessionFor: (hostId: string) => boolean;
  /**
   * The authority's published leases, and whether it has attached at all.
   *
   * Consumed by the DEFAULT-HOST arm only. That arm's subject is the app-wide
   * effective host, which is precisely what the authority decides, so its
   * verdict is the better answer than a directory-membership guess. The
   * tab-host arm below deliberately does NOT read them: a tab is bound to its
   * host for life and asks a window-local question — "does a route to my host
   * exist" — which §1b keeps distinct from the app-wide lease on purpose.
   *
   * `attached: false` and a missing lease are ABSENCE OF EVIDENCE, never
   * death: before this window's kernel attaches every host answers `null`, and
   * a gate that read that as failure would blank the window on every cold
   * start. Both fall through to the dialability answer below.
   */
  readonly leases: readonly HostLeaseSnapshot[];
  readonly authorityAttached: boolean;
}): SurfaceReadiness {
  if (args.scope === "none") return READY;
  if (admitsLocalPlane(args.authStatus) && args.requestContextUserId === null) {
    return { kind: "restoring-request-context" };
  }
  if (args.scope === "default-host") return defaultHostReadiness(args);
  if (args.tabHostId === null) return { kind: "unavailable-host" };
  const entry = args.directoryEntries.find(
    (candidate) => candidate.hostId === args.tabHostId,
  );
  if (!isHostDialable(entry, args.hasReadySessionFor(args.tabHostId))) {
    return { kind: "unavailable-host" };
  }
  return args.requestContextUserId === null
    ? { kind: "restoring-request-context" }
    : READY;
}

/**
 * Whether the default-host surface may show the LOCAL host's lifecycle - its
 * install progress, bootstrap.log, respawn Retry - and project that lifecycle
 * into readiness.
 *
 * A resolved local entry qualifies outright. An UNRESOLVED target qualifies
 * only under local-boot intent: a first-ever install has no directory row to
 * resolve until provisioning creates one, and refusing it there would replace
 * the install card (progress, bootstrap.log path - the traycer#862
 * diagnostics) with a bare "Starting local Traycer Host…" line for the whole
 * first run. An unresolved REMOTE pick never qualifies, which is the
 * misattribution this whole tri-state exists to close.
 *
 * Keyed on the intent, deliberately not on `provisioning`: that flag flips
 * off between the ensure settling and the host binding, and gating on it
 * would drop the card to the bare line mid-boot and then restore it.
 */
export function presentsLocalHostLifecycle(
  presentation: DefaultHostReadinessPresentation,
): boolean {
  return targetPresentsLocalHostLifecycle(
    presentation.targetKind,
    presentation.localBootIntent,
  );
}

/**
 * The same question asked of the two raw inputs, for callers that are still
 * BUILDING the presentation and so have nothing to pass the predicate above.
 *
 * It exists so there is exactly one definition. The projection, the strip's
 * respawn gate and the presentation's own `canManageHost` all have to answer
 * "are these lifecycle affordances about this machine" identically; when
 * `canManageHost` carried its own inline `targetKind === "local"` it silently
 * disagreed with the other two for the whole unresolved-boot window, which is
 * precisely when the local host is being managed.
 */
export function targetPresentsLocalHostLifecycle(
  targetKind: HostTargetKind,
  localBootIntent: boolean,
): boolean {
  if (targetKind === "local") return true;
  return targetKind === "unknown" && localBootIntent;
}

export function projectDefaultHostReadiness(args: {
  readonly readiness: SurfaceReadiness;
  readonly presentation: DefaultHostReadinessPresentation;
}): SurfaceReadiness {
  // A remote selection passes straight through. The local-host lifecycle this
  // projects - install, start, respawn - manages the BUNDLED host on this
  // machine, so projecting those states for a remote target would both block a
  // dialable remote host and offer an action against the wrong machine. An
  // unresolved target gets the same pass-through unless the app is genuinely
  // booting this machine's own host (see `presentsLocalHostLifecycle`).
  if (!presentsLocalHostLifecycle(args.presentation)) return args.readiness;

  // An in-flight ensure settles independently from transport readiness. It
  // therefore takes precedence over a transient dialable endpoint, exactly as
  // the pre-consolidation gate did: children and stream bridges wait until the
  // ensure result can classify busy/removed/error.
  if (args.presentation.provisioning) return { kind: "provisioning-host" };
  if (args.presentation.removed) return { kind: "removed-host" };

  // A dialable host is READY here, full stop. The compat probe used to get the
  // last word on this line (`readinessForCompatibility`), which is how a
  // version disagreement - a fact about SELECTION - ended up gating a surface.
  // It is the authority's input now; see the note on `SurfaceReadiness`.
  //
  // `hostBusy` has never gated readiness either, and still does not: a busy
  // host is dialable, and busy is an action-level fact, not a closed surface.
  if (
    args.readiness.kind !== "loading-host" &&
    args.readiness.kind !== "unavailable-host"
  ) {
    return args.readiness;
  }
  if (args.presentation.provisioningError !== null) {
    return { kind: "provisioning-error" };
  }
  if (
    args.readiness.kind === "loading-host" &&
    args.presentation.localHostState === "unavailable" &&
    args.presentation.stage === "slow"
  ) {
    return { kind: "unavailable-host" };
  }
  return args.readiness;
}

/**
 * Whether the WINDOW NARRATOR owns this readiness kind (status narration,
 * D10).
 *
 * Exactly one narrator per scope is the rule, and these three kinds are the
 * ones the global modal now speaks for: a window with no host yet, a window
 * whose host cannot be reached, and a window whose host is being installed.
 * The modal derives its own verdict from the authority's leases rather than
 * from readiness, so leaving the gate's full-screen splash on these kinds
 * would put two surfaces on screen describing the same fact in two
 * vocabularies - which is the layering this epic is deleting, rebuilt.
 *
 * The kinds NOT listed stay with the gate deliberately, each for its own
 * reason: `mobile-no-host` is a shell with no host concept at all (not a
 * lease state); `restoring-request-context` is an auth fact;
 * `provisioning-error` and `removed-host` are local lifecycle terminals that
 * P3.4 re-homes with the machinery that owns them. (The `compatibility-*`
 * pair that used to be listed here is gone entirely - see `SurfaceReadiness`.)
 * Adding a kind here without a matching modal variant would silently delete
 * its narration.
 */
export type WindowNarratedReadiness = Extract<
  SurfaceReadiness,
  {
    readonly kind: "loading-host" | "unavailable-host" | "provisioning-host";
  }
>;

/**
 * What is left for the GATE to draw: every kind that is neither `ready` nor
 * spoken for by the window narrator.
 *
 * This is the type that makes "one narrator per scope" structural. The gate's
 * renderers accept only this, so a kind the narrator owns cannot be rendered
 * here even by accident, and the reverse holds too: move a kind INTO
 * `windowNarratorOwns` and every gate renderer still handling it becomes a
 * compile error naming itself. It used to be a runtime predicate, which is
 * exactly why two full-screen renderers (`unavailableFallback`,
 * `SlowHostFallback`) sat compiled-but-unreachable after the narrator took
 * their kinds - nothing could see it.
 */
export type GateDrawnReadiness = Exclude<
  SurfaceReadiness,
  WindowNarratedReadiness | { readonly kind: "ready" }
>;

export function windowNarratorOwns(
  readiness: SurfaceReadiness,
): readiness is WindowNarratedReadiness {
  return (
    readiness.kind === "loading-host" ||
    readiness.kind === "unavailable-host" ||
    readiness.kind === "provisioning-host"
  );
}

/**
 * Whether this kind keeps the FULL-SCREEN surface even after the default-host
 * gate has latched (i.e. after the app has been ready at least once this
 * window - see `DefaultHostReadyGate`).
 *
 * Only `mobile-no-host` does: a mobile shell with no host concept at all has
 * no app worth keeping mounted, and it is not reachable from a desktop switch.
 * Everything else keeps the app mounted, because tabs are bound to their host
 * for life and are unaffected by a broken DEFAULT host - replacing the window
 * to report one recreates the jarring break the cold-start-only gate exists to
 * remove.
 *
 * This was a four-valued `PostLatchSurface` while the status strip existed:
 * two of its rows (`switching`, `error`) named which STRIP variant to draw
 * beside the children, and the strip was their only reader. With the strip
 * deleted (D11) one reader is left asking one question, so it is asked
 * directly. `restoring-request-context` answering `false` here is the same
 * deliberate classification it had before: it fires whenever
 * `requestContextUserId` goes transiently null while signed in, and the gate's
 * auth bypass does NOT cover it, so a `true` would be a surviving full-screen
 * path after the latch.
 */
export function keepsSplashAfterLatch(kind: SurfaceReadiness["kind"]): boolean {
  return kind === "mobile-no-host";
}
