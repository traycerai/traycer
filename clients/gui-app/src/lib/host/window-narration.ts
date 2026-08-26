import type {
  HostLeaseSnapshot,
  SelectionIncompatibility,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";
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
    }
  | {
      /**
       * THIS APP is the outdated leg, and the host said so in structured
       * terms: it refused the connection at its client-compatibility EPOCH
       * gate.
       *
       * A separate variant from `update-host` rather than a flag on it,
       * because every action question has the opposite answer. `update-host`
       * offers to re-install the host; here the host is the NEWER leg by
       * construction, so that action can only fail. The remedy is the app
       * updater, and nothing about the host is worth showing.
       *
       * It is also distinct from the generic `client-outdated` skew
       * `hostUpdateSkew` can infer from version strings. That inference is a
       * guess from two SemVers with no shared ordering; this is the host
       * NAMING what it needs and what to install, which is why it takes
       * precedence over the inference wherever both could apply.
       */
      readonly kind: "update-client";
      readonly hostId: string;
      readonly isTargetHost: boolean;
      readonly requirement: ClientCompatibilityRequirement;
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
  /**
   * THIS MACHINE's host id, or null when there is none.
   *
   * Carried separately from {@link localHostExpected} because they answer
   * different questions and one cannot stand in for the other:
   * `localHostExpected` is "can this shell boot SOME local host", a property
   * of the shell, and stays true on a desktop whose target is a remote
   * machine. Only this field can settle whether the host the restarting-target
   * arm is waiting on is the one this app can actually start.
   */
  readonly localHostId: string | null;
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
    return incompatibleVariant(target.hostId, target.dead.detail, true);
  }
  const allPlanRestricted =
    leases.length > 0 &&
    leases.every((lease) => lease.dead?.reason === "plan-restricted");
  if (allPlanRestricted) {
    return { kind: "plan-restricted" };
  }
  for (const lease of leases) {
    if (lease.dead?.reason === "incompatible") {
      // Arm 3: the target is unusable for some other reason and THIS is
      // merely the recoverable incompatible one. A different machine from
      // the one this window's lifecycle affordances act on.
      return incompatibleVariant(lease.hostId, lease.dead.detail, false);
    }
  }
  return { kind: "offline" };
}

/**
 * Which of the two incompatibility variants a dead lease is.
 *
 * The structured epoch requirement WINS whenever the host supplied one, and
 * the precedence is not a preference: it is the difference between the host
 * saying "your app is too old, install X" and this app guessing which leg is
 * behind by comparing two version strings that have no shared ordering. The
 * guess is what the generic arm still does, correctly, for every
 * incompatibility a host cannot describe - a method-manifest disagreement, or
 * any host predating the epoch gate.
 */
function incompatibleVariant(
  hostId: string,
  detail: SelectionIncompatibility,
  isTargetHost: boolean,
): WindowNarrationVariant {
  if (detail.clientCompatibility !== null) {
    return {
      kind: "update-client",
      hostId,
      isTargetHost,
      requirement: detail.clientCompatibility,
    };
  }
  return { kind: "update-host", hostId, isTargetHost, detail };
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
    //
    // UNLESS THE LOCAL TARGET ITSELF IS RESTARTING, which is a start in
    // progress stated by the authority's own lease rather than inferred from
    // the absence of conclusions. The authority holds ∅ for a bounded window
    // while a never-proven local target cycles (its cold-start hold),
    // deliberately declining a usable fallback so the app does not hop and hop
    // back - so during that hold ∅ does NOT mean "nothing can serve this
    // window", and the scan below would say so anyway the moment the account
    // contains one dead machine (a retired laptop). That is the same reasoning
    // the non-∅ cold-start arm already applies further down: whatever else is
    // wrong out there belongs to the surface chip or the tile, not to the
    // window's launch story.
    //
    // ⚠ THE TARGET MUST BE THIS MACHINE, and `localHostExpected` cannot
    // establish that - it says the SHELL can boot some local host, which stays
    // true on a desktop whose target is a remote. Without the identity check,
    // a preferred REMOTE cycling while the rest of the fleet is offline read
    // as a launch: the authority skips its (local-only) hold and derives a
    // real ∅, while this arm relabelled that verdict `cold-start` and put the
    // local provisioning card - Retry, install progress, the bootstrap log -
    // in front of a machine this app cannot start, withholding the offline
    // recovery until the remote's restart episode expired. The narrator's
    // grace and the authority's hold have to be gated on the SAME premise, or
    // one of them is narrating a state the other never entered.
    //
    // ⚠ ONLY WHERE THE SCAN WOULD HAVE SAID `offline` ANYWAY, and that gate is
    // the difference between softening a verdict and SUPPRESSING one. This arm
    // has no clock: it reads a lease status the outage signal can hold for
    // `LOCAL_EXPECTED_OUTAGE_CEILING_MS` (15 minutes), far past the authority's
    // 20-second hold, so anything it hides it can hide for the whole outage. On
    // `offline` there is nothing to hide - the startup card carries the same
    // recovery, promoting to Retry + Open settings at
    // `LOCAL_HOST_SLOW_START_THRESHOLD_MS` and adding Report issue once the
    // install settles in failure - and "Starting Traycer…" is the truer
    // sentence while the boot is genuinely running. `update-host` is the
    // opposite: a version fix the user could walk NOW (arm 3 of the scan - an
    // incompatible OTHER host while the target cycles), and a local restart is
    // not a reason to withhold it for a quarter of an hour.
    //
    // Asking `deriveNoHostVariant` rather than enumerating dead reasons is
    // deliberate. `plan-restricted` happens to be unreachable in this
    // population today (its arm needs EVERY lease dead, and a
    // `restarting-expected` target is not), so an enumeration written against
    // what is reachable now would be a rule that quietly stops matching when
    // that precedence moves. Deferring to the scan itself makes a new variant
    // actionable by default, which is the safe direction to be wrong in.
    const targetLease = findLease(input.leases, input.targetHostId);
    const noHostVariant = deriveNoHostVariant(input.leases, input.targetHostId);
    const localTargetRestarting =
      input.targetHostId !== null &&
      input.targetHostId === input.localHostId &&
      targetLease?.status === "restarting-expected";
    if (
      !input.hasBeenServed &&
      input.localHostExpected &&
      noHostVariant.kind === "offline" &&
      (localTargetRestarting ||
        input.leases.every((lease) => lease.status !== "dead"))
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
      variant: noHostVariant,
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
