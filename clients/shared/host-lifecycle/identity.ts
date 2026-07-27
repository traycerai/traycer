// Positive Traycer identity attestation for eviction targets (plan F10,
// macOS annex §1.3 / §2.1 hard rule).
//
// A `cli-or-other` (or Linux unit / Windows task) is evictable only when we
// have *positive* evidence it is a Traycer registration — never by path
// alone, never by "looks like our label prefix".

/**
 * Result of inspecting a registration's content (plist body, unit file,
 * task XML / ProgramArguments from launchctl print, etc.).
 */
export type TraycerIdentityAttestation =
  | {
      readonly kind: "attested";
      readonly signals: readonly IdentitySignal[];
    }
  | {
      readonly kind: "not-traycer";
      readonly reason: string;
    }
  | {
      readonly kind: "indeterminate";
      readonly cause: string;
    };

export type IdentitySignal =
  | { readonly kind: "content-tag"; readonly value: string }
  | { readonly kind: "label"; readonly value: string }
  | { readonly kind: "program-arguments"; readonly tokens: readonly string[] }
  | { readonly kind: "exec-start"; readonly tokens: readonly string[] }
  | { readonly kind: "task-name"; readonly value: string };

/** Closed set of labels the lifecycle layer owns for a given environment. */
export type TraycerLabelIds = {
  readonly cliRaw: string;
  readonly agent: string;
  readonly fallback: string;
};

/**
 * Derive the three macOS/Linux label ids for a base CLI label
 * (`ai.traycer.host` or `ai.traycer.host.<env>`). Fallback is new (F7).
 */
export function traycerLabelIdsForBase(baseLabelId: string): TraycerLabelIds {
  return {
    cliRaw: baseLabelId,
    agent: `${baseLabelId}.agent`,
    fallback: `${baseLabelId}.fallback`,
  };
}

const TRAYCER_CONTENT_TAG = "ai.traycer.host-lifecycle";
const HOST_START_TAIL = ["host", "start"] as const;
const HOST_START_WITH_LABEL_TAIL = [
  "host",
  "start",
  "--service-label",
] as const;
const COMPATIBLE_HOST_START_SCRIPT_PREFIX =
  '"$0" "$@" host start --help 2>&1 | /usr/bin/grep -Fq --';

/**
 * Positive attestation from a LaunchAgent / unit-style command line.
 * Requires either an explicit content-tag OR a command line ending in
 * `host start` (legacy) or `host start --service-label <this-label>`.
 */
export function attestTraycerRegistration(input: {
  readonly labelId: string | null;
  readonly knownLabels: TraycerLabelIds | null;
  readonly programArguments: readonly string[] | null;
  readonly contentTag: string | null;
  readonly sourceText: string | null;
}): TraycerIdentityAttestation {
  const signals: IdentitySignal[] = [];

  if (input.contentTag !== null) {
    if (input.contentTag === TRAYCER_CONTENT_TAG) {
      signals.push({ kind: "content-tag", value: input.contentTag });
    } else {
      return {
        kind: "not-traycer",
        reason: `foreign content-tag: ${input.contentTag}`,
      };
    }
  }

  // Optional in-body content tag for future plists that embed it as a
  // Comment / X-Traycer-ContentTag key. Detect without requiring it.
  if (
    input.contentTag === null &&
    input.sourceText !== null &&
    input.sourceText.includes(TRAYCER_CONTENT_TAG)
  ) {
    signals.push({ kind: "content-tag", value: TRAYCER_CONTENT_TAG });
  }

  if (input.labelId !== null) {
    if (input.knownLabels !== null) {
      const known = input.knownLabels;
      if (
        input.labelId === known.cliRaw ||
        input.labelId === known.agent ||
        input.labelId === known.fallback
      ) {
        signals.push({ kind: "label", value: input.labelId });
      } else if (!isTraycerLabelShape(input.labelId)) {
        return {
          kind: "not-traycer",
          reason: `label '${input.labelId}' is outside the Traycer host namespace`,
        };
      } else {
        // In namespace but not the expected triple for this environment —
        // still a positive Traycer signal (e.g. cross-env collision scan).
        signals.push({ kind: "label", value: input.labelId });
      }
    } else if (isTraycerLabelShape(input.labelId)) {
      signals.push({ kind: "label", value: input.labelId });
    }
  }

  if (input.programArguments !== null) {
    if (isHostStartInvocation(input.programArguments, input.labelId)) {
      signals.push({
        kind: "program-arguments",
        tokens: input.programArguments,
      });
    } else if (input.programArguments.length > 0) {
      // Non-empty args that do not end in `host start` are a positive
      // refutation — *unless* an ownership signal (our content tag, or one of
      // our labels) has already fired.
      //
      // DECISION (macOS annex §2.1.2), recorded rather than left emergent:
      // an ownership signal deliberately **suppresses** argument-based
      // refutation. A job squatting on one of our exact labels while running
      // a foreign program is still ours to evict — the label is the thing we
      // own, and refusing to evict a squatter is how a lockout survives a
      // repair. The inverse (evicting on a label *shape* alone, with no
      // invocation evidence) stays forbidden and is enforced by the
      // strong-signal gate below.
      //
      // Written as a named condition because the previous form
      // (`if (signals.length === 0)`) made this a side effect of push order:
      // moving the label block below this one would silently reverse it.
      if (!hasOwnershipSignal(signals)) {
        return {
          kind: "not-traycer",
          reason:
            "ProgramArguments do not end with a recognised 'host start' invocation",
        };
      }
    }
  }

  if (signals.length === 0) {
    return {
      kind: "indeterminate",
      cause: "no positive Traycer identity signals found",
    };
  }

  // Eviction safety: require at least one *invocation* signal (args /
  // content-tag) OR a label match that is one of our three known ids.
  // Label-shape alone without args is not enough to bootout.
  const hasStrongSignal = signals.some(
    (s) =>
      s.kind === "content-tag" ||
      s.kind === "program-arguments" ||
      s.kind === "exec-start" ||
      s.kind === "task-name" ||
      (s.kind === "label" &&
        input.knownLabels !== null &&
        (s.value === input.knownLabels.cliRaw ||
          s.value === input.knownLabels.agent ||
          s.value === input.knownLabels.fallback)),
  );

  if (!hasStrongSignal) {
    return {
      kind: "indeterminate",
      cause: "label shape alone is not positive identity for eviction",
    };
  }

  return { kind: "attested", signals };
}

/**
 * Ownership signals: evidence that the *registration slot* is ours, as
 * distinct from evidence about what it currently invokes. Only these suppress
 * argument-based refutation (annex §2.1.2).
 */
function hasOwnershipSignal(signals: readonly IdentitySignal[]): boolean {
  return signals.some(
    (signal) => signal.kind === "content-tag" || signal.kind === "label",
  );
}

/**
 * True only when attestation is positively Traycer — the eviction gate.
 * `indeterminate` and `not-traycer` both refuse eviction.
 */
export function isEvictableTraycerIdentity(
  attestation: TraycerIdentityAttestation,
): boolean {
  return attestation.kind === "attested";
}

export function isTraycerLabelShape(labelId: string): boolean {
  return (
    labelId === "ai.traycer.host" ||
    labelId.startsWith("ai.traycer.host.") ||
    labelId.startsWith("ai.traycer.host-")
  );
}

function isHostStartInvocation(
  args: readonly string[],
  labelId: string | null,
): boolean {
  if (
    args.length >= 4 &&
    labelId !== null &&
    args[0] === "/bin/sh" &&
    args[1] === "-c" &&
    args[2]?.startsWith(COMPATIBLE_HOST_START_SCRIPT_PREFIX) &&
    args[2].includes("--service-label") &&
    args[2].includes(labelId)
  ) {
    return true;
  }
  if (args.length < 2) return false;
  const a = args[args.length - 2];
  const b = args[args.length - 1];
  if (a === HOST_START_TAIL[0] && b === HOST_START_TAIL[1]) return true;
  if (args.length < 4 || labelId === null) return false;
  return (
    args[args.length - 4] === HOST_START_WITH_LABEL_TAIL[0] &&
    args[args.length - 3] === HOST_START_WITH_LABEL_TAIL[1] &&
    args[args.length - 2] === HOST_START_WITH_LABEL_TAIL[2] &&
    args[args.length - 1] === labelId
  );
}

export const TRAYCER_HOST_CONTENT_TAG = TRAYCER_CONTENT_TAG;
