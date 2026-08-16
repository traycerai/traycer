import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

/**
 * Whether a host can serve the fork this dialog is about to send, decided from
 * the `epic.createChat` version it negotiated.
 *
 * A cross-host fork rides `sourceOwnerUserId` on the precise-boundary
 * `forkSource` arm, added in v1.2. A same-MAJOR downgrade Zod-STRIPS an unknown
 * field silently, so against a v1.1 host the request succeeds with the hint
 * gone and the cloud tier quietly refuses to seed the transcript - a fork that
 * looks fine and lost its history. That silence is why this is gated up front
 * rather than left to the host's refusal.
 */
export type ChatForkTargetSupport =
  | { readonly kind: "supported" }
  /**
   * No handshake with that host has completed yet, so nothing is known about
   * its build. Deliberately PERMISSIVE: rendering "needs update" here would
   * assert a fact this client does not have, and the state resolves itself on
   * the first completed RPC to the host - which, for a host-parametric surface,
   * is the moment the user picks it. If the target really is v1.1, the host
   * refuses with `E_FORK_CHECKPOINT_UNAVAILABLE` and the user sees an error
   * instead of a silently wrong result.
   */
  | { readonly kind: "unknown" }
  | {
      readonly kind: "refused";
      /** The one word the host row shows. */
      readonly word: string;
      /** The sentence the dialog shows for the SELECTED host. */
      readonly detail: string;
    };

/** The `epic.createChat` minor that carries the cross-host owner hint. */
const CHAT_FORK_REQUIRED_MINOR = 2;
const CHAT_FORK_MAJOR = 1;

export const CHAT_FORK_NEEDS_UPDATE_WORD = "needs update";

/**
 * `>=` the required minor, not `===`: a later 1.3 is still a superset of 1.2 by
 * the framework's minor-additivity rule, and pinning to one minor would disable
 * every host the moment the next one ships. An unrecognized MAJOR fails closed
 * - the contract is not one this client can reason about in either direction -
 * but says so as incompatibility rather than as "update it", which would be
 * advice pointing the wrong way for a host that is AHEAD.
 */
export function chatForkTargetSupport(
  version: NegotiatedMethodVersion,
): ChatForkTargetSupport {
  if (version === null) return { kind: "unknown" };
  if (version === false) {
    return {
      kind: "refused",
      word: CHAT_FORK_NEEDS_UPDATE_WORD,
      detail: "This host can't create agents yet - update it to fork here.",
    };
  }
  if (version.major !== CHAT_FORK_MAJOR) {
    return {
      kind: "refused",
      word: "incompatible",
      detail:
        "This host speaks a different version of the agent-create contract, so this app can't fork onto it.",
    };
  }
  if (version.minor < CHAT_FORK_REQUIRED_MINOR) {
    return {
      kind: "refused",
      word: CHAT_FORK_NEEDS_UPDATE_WORD,
      detail:
        "This host's build can't receive a fork from another machine. Update it and try again.",
    };
  }
  return { kind: "supported" };
}

/**
 * Per-host refusal words for the picker, built from the negotiated versions of
 * every host it lists.
 *
 * `sourceHostId` is exempt on purpose: a same-host fork sends no hint and needs
 * no v1.2 - it is the shape every host that can serve this dialog at all has
 * always understood. Gating the source row would disable the ONE row that is
 * always correct, on a build fact that does not apply to it.
 */
export function chatForkHostRefusals(input: {
  readonly versionByHostId: ReadonlyMap<string, NegotiatedMethodVersion>;
  readonly sourceHostId: string | null;
}): ReadonlyMap<string, string> {
  const refusals = new Map<string, string>();
  for (const [hostId, version] of input.versionByHostId) {
    if (hostId === input.sourceHostId) continue;
    const support = chatForkTargetSupport(version);
    if (support.kind !== "refused") continue;
    refusals.set(hostId, support.word);
  }
  return refusals;
}

/**
 * Copy for the one degradation a cross-host fork cannot plumb away.
 *
 * Both fork modes are bound to the SOURCE machine by meaning: an A/B fork
 * carries the source working tree's uncommitted changes into a new worktree,
 * and a Cross Question fork adopts the source working copy. Neither is
 * expressible on another machine - the changes live on this one's disk - so the
 * mode is withdrawn rather than silently reinterpreted as "fork off whatever
 * host B has checked out", which would produce a working copy the user never
 * asked for.
 */
export const CROSS_HOST_CARRY_CHANGES_NOTICE =
  "Uncommitted changes stay on the source machine, so this fork starts from the workspace you pick here.";

/** The workspace section's own explanation for the empty, unseeded state. */
export const CROSS_HOST_WORKSPACE_NOTICE =
  "Folder paths don't travel between machines - pick this host's workspace for the fork.";

/**
 * The fork also loses the provider's on-disk session cross-host (the target has
 * no session file to fork), so the first turn replays context instead of
 * resuming it. Stated where the user chooses, not discovered afterwards.
 */
export const CROSS_HOST_SHALLOW_FORK_NOTICE =
  "The fork copies the transcript; the provider session stays on the source machine.";
