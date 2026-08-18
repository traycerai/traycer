import type {
  HostLeaseSnapshot,
  SelectionIncompatibility,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  describeVersionSkew,
  type VersionSkewCopy,
} from "@/lib/host/version-skew-copy";

/**
 * WHAT THE WINDOW NARRATOR SAYS, as a pure function of the authority's
 * projection (status narration, D10).
 *
 * Exactly one narrator per scope: this module owns the WINDOW scope, and the
 * window scope owns exactly two facts - "nothing can serve this window" and
 * "nothing has served it yet". Everything else (a single host dying while
 * others work, a switch, a probe) is narrated at the surface or tile that owns
 * it and must never reach here.
 *
 * Deliberately hook-free and store-free. The whole verdict is a function of
 * four authority values plus one per-window latch, so it is decided here and
 * tested here; `use-window-narration.ts` only supplies the inputs. Keeping the
 * derivation out of React is what lets the variant precedence below be pinned
 * directly rather than through a rendered surface.
 */

/**
 * Which of the two window-scope facts is being narrated.
 *
 * - `no-usable-host` - the authority's ∅ verdict: it derived no effective host
 *   at all. Reachable at any point in a window's life, including long after
 *   the app has been working.
 * - `cold-start` - an effective host exists but has never served this window.
 *   This arm exists because ∅ ALONE CANNOT DRIVE COLD START:
 *   `isUsableForSelection` counts `connecting` as usable, and the engine
 *   deliberately keeps an ensure-in-flight host usable so ∅ never shows for a
 *   host it is booting FOR the user. So during a first launch the authority
 *   names a host, ∅ is false, and a strictly-∅ modal would be invisible for
 *   exactly the state this surface is supposed to own.
 */
export type WindowNarrationCause = "no-usable-host" | "cold-start";

/**
 * The three variants, and the actions each may offer.
 *
 * `update-host` carries the lease's own structured detail rather than a
 * message string: it is the SAME `SelectionIncompatibility` the compat probe
 * reported, travelling from the authority to this surface intact, so the card
 * can name versions instead of restating a reason sentence.
 */
export type WindowNarrationVariant =
  | { readonly kind: "offline" }
  | { readonly kind: "plan-restricted" }
  | {
      readonly kind: "update-host";
      readonly hostId: string;
      /**
       * Whether `hostId` is the host this window was TARGETING, or merely
       * another incompatible one the fallback arm found.
       *
       * Required, never defaulted: the two arms below produce an identical
       * shape while meaning different things, and a consumer that inherits
       * that meaning silently is exactly how the local "Update host" action
       * ended up bound to a remote machine. The compiler now refuses to let a
       * new arm skip the question.
       *
       * `false` does NOT mean "remote" - it means "not the machine whose
       * lifecycle this window can act on", which is the only distinction an
       * action-side guard can safely make here.
       */
      readonly isTargetHost: boolean;
      readonly detail: SelectionIncompatibility;
    };

export type WindowNarrationState =
  | { readonly kind: "silent" }
  | {
      readonly kind: "narrating";
      readonly cause: WindowNarrationCause;
      readonly variant: WindowNarrationVariant;
    };

export interface WindowNarrationInput {
  /**
   * Whether this window's selection kernel has published a snapshot.
   *
   * The gate on every arm below. A null effective host means two unrelated
   * things and only this tells them apart: `false` is the store's DETACHED
   * default (nobody has answered yet - bootstrap), `true` with a null host is
   * the real ∅. Narrating a failure on the first is the flash P2.4 §7 fixed
   * one layer down; this surface is app-wide, so the same mistake here would
   * flash a full modal on every cold open.
   */
  readonly attached: boolean;
  readonly effectiveHostId: string | null;
  /** Preferred, or the local host when preferred is null (M5), or null. */
  readonly targetHostId: string | null;
  readonly leases: readonly HostLeaseSnapshot[];
  /**
   * Whether a lease has served this window at least once (see
   * {@link isServingLease}). Per-window runtime state, exactly like the
   * readiness gate's `hasBeenReady` latch: a reload re-arms the cold-start
   * arm, and a brand-new window that cannot yet be served correctly shows the
   * narrator.
   *
   * It is what stops the window narrator from re-opening on every later
   * not-ready blip. After the app has worked once, a host that goes quiet is
   * the tile's story (bounded loading, P3.3) - not a modal over the whole
   * window - unless the fleet empties out into ∅.
   */
  readonly hasBeenServed: boolean;
  /**
   * Whether this shell can boot a local host at all (`runnerHost.hasLocalHost`
   * on desktop; false on web/mobile). Gates the pre-serve ∅ grace below: on a
   * shell with no local lifecycle, an empty concluded fleet really is "no host
   * is available", and softening it to "starting" would promise a boot that
   * cannot happen.
   */
  readonly localHostExpected: boolean;
}

/**
 * Whether this lease is currently serving the window.
 *
 * `degraded` counts, and that is not an oversight. A degraded lease is a host
 * that ANSWERED - the engine keeps it usable and the window genuinely works on
 * it - so treating it as unserved would hold the cold-start modal over a
 * working app until the probe cleared, which is the lockout class this whole
 * surface exists to prevent. `connecting` and `restarting-expected` are holds,
 * not service: the first has no proof of life yet, the second is a host mid-
 * cycle. `dead` is never service.
 */
export function isServingLease(lease: HostLeaseSnapshot | null): boolean {
  if (lease === null) return false;
  return lease.status === "ready" || lease.status === "degraded";
}

export function findLease(
  leases: readonly HostLeaseSnapshot[],
  hostId: string | null,
): HostLeaseSnapshot | null {
  if (hostId === null) return null;
  return leases.find((lease) => lease.hostId === hostId) ?? null;
}

/**
 * The variant precedence (C4, and the ticket's three acceptance bullets).
 *
 * Ordered, total, and deterministic:
 *
 *  1. The TARGET host is dead because it is incompatible -> `update-host` on
 *     it. Target-first so the card names the machine the user was actually
 *     trying to use, rather than whichever incompatible row sorts first.
 *  2. Every lease is dead AND every reason is `plan-restricted` ->
 *     `plan-restricted`. "Every" is the point: this is the arm that must offer
 *     an upgrade and NO dead-retry affordances, and retrying is the right
 *     answer the moment one host is merely offline.
 *  3. Some OTHER lease is dead because it is incompatible -> `update-host` on
 *     it. Reached when the target is fine-but-unusable for another reason
 *     while an incompatible host is the recoverable one.
 *  4. Otherwise -> `offline`, the retryable arm.
 *
 * The mixed-fleet consequence is deliberate: a plan-restricted target beside a
 * merely-incompatible host falls through 2 (not ALL plan-restricted) into 3,
 * which prefers the path a user can walk without paying.
 *
 * An empty lease list answers `offline`, never `plan-restricted` - rule 2
 * requires at least one lease, because "every member of nothing is
 * plan-restricted" is vacuously true and would put an upgrade CTA in front of
 * a user whose fleet simply has not loaded.
 */
export function deriveNoHostVariant(
  leases: readonly HostLeaseSnapshot[],
  targetHostId: string | null,
): WindowNarrationVariant {
  const target = findLease(leases, targetHostId);
  if (target !== null && target.dead?.reason === "incompatible") {
    return {
      kind: "update-host",
      hostId: target.hostId,
      isTargetHost: true,
      detail: target.dead.detail,
    };
  }
  const allPlanRestricted =
    leases.length > 0 &&
    leases.every((lease) => lease.dead?.reason === "plan-restricted");
  if (allPlanRestricted) {
    return { kind: "plan-restricted" };
  }
  for (const lease of leases) {
    if (lease.dead?.reason === "incompatible") {
      return {
        kind: "update-host",
        hostId: lease.hostId,
        // Arm 3: the target is unusable for some other reason and THIS is
        // merely the recoverable incompatible one. A different machine from
        // the one this window's lifecycle affordances act on.
        isTargetHost: false,
        detail: lease.dead.detail,
      };
    }
  }
  return { kind: "offline" };
}

/**
 * Which leg the version disagreement says is behind, for a lease-carried
 * incompatibility.
 *
 * Lives here, next to the variant that carries the detail, and takes the
 * client version as an ARGUMENT rather than reading the app manifest - that
 * keeps this module a pure function of its inputs, and keeps the answer out of
 * the component file (where exporting a non-component breaks fast refresh).
 *
 * It delegates to `describeVersionSkew` rather than re-deciding: the compat
 * card asks the same question, and two spellings of "who is behind" is exactly
 * how a card ends up offering an action that cannot help.
 */
export function hostUpdateSkew(
  detail: SelectionIncompatibility,
  clientAppVersion: string | null,
): VersionSkewCopy {
  return describeVersionSkew({
    hostAppVersion: detail.hostVersion,
    clientAppVersion,
    guidance: null,
  });
}

/**
 * Whether "Update host" is a real answer. Updating the host can never fix an
 * app that is itself the outdated leg, so the action is withheld there rather
 * than offered and failed.
 */
export function hostUpdateActionApplies(
  detail: SelectionIncompatibility,
  clientAppVersion: string | null,
): boolean {
  return (
    hostUpdateSkew(detail, clientAppVersion).direction !== "client-outdated"
  );
}

/**
 * The whole window-narrator verdict.
 *
 * Note there is no dismissal input, and that is the design: visibility is
 * DERIVED, so a recovery closes this surface by re-derivation and there is no
 * manual-retry path that could leave a stale modal over a working app. Nothing
 * in the tree may hold this open.
 */
export function deriveWindowNarration(
  input: WindowNarrationInput,
): WindowNarrationState {
  if (!input.attached) return { kind: "silent" };
  if (input.effectiveHostId === null) {
    // THE PRE-SERVE GRACE: before this window has ever been served, an ∅
    // whose fleet has not CONCLUDED anything is a start in progress, not a
    // verdict. Two launch shapes land here and both used to flash "No host
    // is available" with Retry and Report issue at every boot:
    //
    //  - the attach snapshot arriving before the fleet's first publish
    //    (empty lease list - the same vacuity `deriveNoHostVariant` refuses
    //    to read as plan-restricted), and
    //  - the launch reconcile cycling the local host (`restarting-expected`
    //    is unusable, and at cold start there is no incumbent to hold).
    //
    // A DEAD lease is a conclusion, so any dead lease disqualifies the grace
    // and the ∅ scan below runs - which is also what keeps `update-host` and
    // `plan-restricted` reachable at first launch: both derive from dead
    // leases. After the window has served once, ∅ is always the verdict arm;
    // the grace is strictly a launch statement.
    if (
      !input.hasBeenServed &&
      input.localHostExpected &&
      input.leases.every((lease) => lease.status !== "dead")
    ) {
      return {
        kind: "narrating",
        cause: "cold-start",
        variant: { kind: "offline" },
      };
    }
    return {
      kind: "narrating",
      cause: "no-usable-host",
      variant: deriveNoHostVariant(input.leases, input.targetHostId),
    };
  }
  if (input.hasBeenServed) return { kind: "silent" };
  if (isServingLease(findLease(input.leases, input.effectiveHostId))) {
    return { kind: "silent" };
  }
  // COLD START IS ALWAYS THE `offline` VARIANT, never the fleet scan.
  //
  // The scan answers "why can nothing serve this window", which is a question
  // only ∅ is asking. Here a host CAN serve it - it just has not finished
  // coming up - so running the precedence would let an unrelated fleet member
  // hijack the story: an account with one incompatible machine would greet
  // every first launch with "Host update needed" while its local host was
  // installing perfectly normally, and a dead PREFERRED host would do the same
  // while derivation was already bringing up local instead. Whatever else is
  // wrong out there is the surface chip's or the tile's to say; the window's
  // story at cold start is the host that is starting.
  return {
    kind: "narrating",
    cause: "cold-start",
    variant: { kind: "offline" },
  };
}
