import { createContext, use } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { MutationProgress } from "@traycer-clients/shared/platform/runner-host";
import type { HostStatusSnapshot } from "@/lib/host/compatibility-state";
import type { AuthStatus } from "@/stores/auth/auth-store";
import { isHostReachable } from "@traycer-clients/shared/host-client/host-directory";

export type HostReadinessScope = "none" | "default-host" | "tab-host";

export type SurfaceReadiness =
  | { readonly kind: "ready" }
  | { readonly kind: "restoring-request-context" }
  | { readonly kind: "loading-host" }
  | { readonly kind: "mobile-no-host" }
  | { readonly kind: "unavailable-host" }
  | { readonly kind: "provisioning-host" }
  | { readonly kind: "provisioning-error" }
  | { readonly kind: "removed-host" }
  | { readonly kind: "compatibility-checking" }
  | { readonly kind: "compatibility-error" }
  | { readonly kind: "incompatible-host" };

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
   * The three recoveries for the residual "no host is dialable" card (D7).
   *
   * They are host-MANAGEMENT-free on purpose: that card is reached when the
   * auto-failover had nowhere to go, which includes directories holding only
   * machines this app cannot manage. Re-reading the registry, opening the
   * picker and opening settings are the three things a user can do about that
   * from anywhere, and the card carried none of them - it shipped with
   * `actions: []`.
   */
  readonly refreshDirectory: () => void;
  readonly openHostPicker: () => void;
  readonly openSettings: () => void;
  /**
   * Whether AT LEAST ONE entry in the merged directory can currently be
   * dialed.
   *
   * The host-unavailable card files a pre-filled report, and which failure it
   * names has to be a fact rather than an assumption about how the card was
   * reached. "No host in the directory could be reached" is false in two
   * states that reach the very same card: the two-read wait before an
   * auto-failover, where another host is dialable and about to be taken, and
   * this machine's own host booting while a remote is listed (which is never
   * failed away from). Filing a zero-hosts report from either one sends triage
   * after a directory-wide outage that is not happening.
   */
  readonly anyHostDialable: boolean;
  // Owned once by the readiness controller, not per slot: two default-host
  // members in a split must share one respawn mutation so a single click issues
  // exactly one request and locks the action in every slot.
  readonly requestRespawn: () => void;
  readonly respawnPending: boolean;
  readonly compatibility: {
    readonly status: "checking" | "compatible" | "failed" | "incompatible";
    readonly errorMessage: string | null;
    readonly retrying: boolean;
    readonly retry: () => void;
    /**
     * `compatible` held from an earlier probe whose latest refetch failed. The
     * surface stays open - the host answered this handshake already - and the
     * degraded connection is surfaced as a banner instead.
     */
    readonly degraded: boolean;
    /**
     * `failed` because the probe never reached the host, rather than because
     * the host rejected the handshake. Drives connection-shaped copy: calling
     * an unreachable host "incompatible" is what made an offline host
     * (traycer#858) and a load-stalled host (traycer#860) both read as version
     * problems.
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
  openHostPicker: () => undefined,
  openSettings: () => undefined,
  anyHostDialable: false,
  requestRespawn: () => undefined,
  respawnPending: false,
  compatibility: {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

export const HostReadinessControllerContext =
  createContext<HostReadinessController>({
    readinessFor: () => READY,
    defaultHostPresentation: EMPTY_DEFAULT_HOST_PRESENTATION,
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

export function isHostDialable(entry: HostDirectoryEntry | undefined): boolean {
  return (
    entry !== undefined &&
    // Dialability is `isHostReachable`, not `=== "available"`. A busy host has
    // the same pid and the same `websocketUrl`; the renderer's per-request
    // dials to it keep completing. Gating readiness on the probe result is
    // what let one timed-out probe take a whole session down (int #48).
    isHostReachable(entry.status) &&
    entry.websocketUrl !== null
  );
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
}): SurfaceReadiness {
  if (args.scope === "none") return READY;
  if (args.authStatus === "signed-in" && args.requestContextUserId === null) {
    return { kind: "restoring-request-context" };
  }
  if (args.scope === "default-host") {
    const activeEntry = args.directoryEntries.find(
      (candidate) => candidate.hostId === args.activeHostId,
    );
    if (
      args.activeHostId !== null &&
      args.requestContextUserId !== null &&
      isHostDialable(activeEntry)
    ) {
      return READY;
    }
    if (!args.hasLocalHost && args.hasMobileNoHost) {
      return { kind: "mobile-no-host" };
    }
    return args.activeHostId === null
      ? { kind: "loading-host" }
      : { kind: "unavailable-host" };
  }
  if (args.tabHostId === null) return { kind: "unavailable-host" };
  const entry = args.directoryEntries.find(
    (candidate) => candidate.hostId === args.tabHostId,
  );
  if (!isHostDialable(entry)) return { kind: "unavailable-host" };
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
  // `LocalHostGate` intentionally passes remote selections through. Its
  // compatibility and ensure actions manage the bundled local host, so
  // projecting those lifecycle states for a remote target would both block a
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

  if (args.readiness.kind === "ready") {
    // Compatibility alone decides here. `hostBusy` deliberately does NOT gate
    // readiness: a busy host is still dialable, and busy is surfaced as the
    // Refresh / Force-update actions by the presentation layer rather than by
    // holding the surface closed. It used to appear as a `hostBusy ||` disjunct
    // in front of this call, which read as a gate but was inert -
    // `readinessForCompatibility` returns READY for `compatible`, so the busy
    // branch and the fall-through produced the same answer.
    return readinessForCompatibility(args.presentation);
  }
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
 * Where a readiness kind is surfaced ONCE the default-host gate has latched
 * (i.e. the app has been ready at least once this window - see
 * `DefaultHostReadyGate`).
 *
 *  - `app`      - children, no strip.
 *  - `switching` - children, plus the amber strip: the app stays mounted and
 *                 interactive while this resolves.
 *  - `error`    - children, plus the red strip carrying the recovery action.
 *                 Deliberately NOT full-screen: tabs are host-bound for life
 *                 and are unaffected by a broken DEFAULT host, so replacing
 *                 the window to report one recreates the jarring break the
 *                 cold-start-only gate exists to remove.
 *  - `splash`   - keeps the full-screen surface even post-latch. Only
 *                 `mobile-no-host` qualifies: a mobile shell with no host at
 *                 all has no app to keep mounted.
 *
 * One exhaustive switch, shared by the gate (which reads `splash` vs the
 * rest) and the strip (which reads `switching` vs `error`), so the two can
 * never disagree about a kind and a NEW kind cannot be added without
 * classifying it here.
 *
 * `restoring-request-context` is in the `switching` row deliberately: it
 * fires whenever `requestContextUserId` goes transiently null while signed
 * in, and the gate's auth bypass does NOT cover it - left unclassified it
 * would be a surviving full-screen path after the latch.
 */
export type PostLatchSurface = "app" | "switching" | "error" | "splash";

export function postLatchSurfaceFor(
  kind: SurfaceReadiness["kind"],
): PostLatchSurface {
  switch (kind) {
    case "ready":
      return "app";
    case "compatibility-checking":
    case "loading-host":
    case "provisioning-host":
    case "unavailable-host":
    case "restoring-request-context":
      return "switching";
    case "compatibility-error":
    case "incompatible-host":
    case "provisioning-error":
    case "removed-host":
      return "error";
    case "mobile-no-host":
      return "splash";
  }
}

function readinessForCompatibility(
  presentation: DefaultHostReadinessPresentation,
): SurfaceReadiness {
  switch (presentation.compatibility.status) {
    case "checking":
      return { kind: "compatibility-checking" };
    case "compatible":
      return READY;
    case "failed":
      return { kind: "compatibility-error" };
    case "incompatible":
      return { kind: "incompatible-host" };
  }
}
