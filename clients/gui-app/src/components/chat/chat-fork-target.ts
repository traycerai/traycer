import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

/**
 * Whether a host can serve the fork this dialog is about to send, decided from
 * the `epic.createChat` version it negotiated.
 *
 * A cross-host fork rides `sourceOwnerUserId` on the precise-boundary
 * `forkSource` arm, added in v1.2 (v1.1 carries the field on the `"latest"` arm
 * only). A same-MAJOR downgrade Zod-STRIPS an unknown field silently, so against
 * a v1.1 host the request arrives with the hint gone.
 *
 * What that host then does is LOUD, not silent: `buildForkSeed` walls every
 * precise-boundary fork on `storageAPI.hasChat(sourceChatId)` before it reaches
 * any tier, and a cross-host target does not have the source chat - so it throws
 * `E_FORK_CHECKPOINT_UNAVAILABLE` and the user sees an error. This gate exists
 * to replace that error with a legible up-front refusal on the row itself, NOT
 * to prevent a silently-historyless fork. Getting that backwards is what makes
 * the `unknown` verdict below look like a hole; it is not one, and the variant's
 * own note explains why being permissive there is right.
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

/**
 * What the SOURCE host said about this chat's publication — or that it could
 * not be asked.
 *
 * Unlike the version read, this is a fact about the CHAT, not about any target:
 * it is identical for every remote host in the picker and does not vary by
 * which one is highlighted. That is why it never becomes a per-row refusal.
 */
export type ChatForkPublicationState =
  /**
   * No answer. The source host predates `epic.chatPublicationState` (the
   * optional-capability refusal `E_HOST_UNSUPPORTED`), is unreachable, or the
   * read is still in flight. Deliberately permissive, exactly like an unknown
   * version: unknown is not "unpublished", and Layer 2's typed refusal is the
   * backstop.
   */
  | { readonly kind: "unknown" }
  /** Never published — no remote host can pull this transcript at all. */
  | { readonly kind: "unpublished" }
  /**
   * Published, but the head does not yet cover the chosen boundary. Transient
   * by construction: it clears within a publish sweep.
   */
  | { readonly kind: "boundaryUncovered" }
  /** Published, and the boundary is inside the published head. */
  | { readonly kind: "covered" };

/**
 * ONE verdict for a highlighted target, resolved from BOTH gates at once.
 *
 * The two gates have different subjects and therefore different presentations,
 * which is exactly why they are resolved together in one place rather than
 * `&&`-ed at each render site: nine (version × publication) cells decided once,
 * with the precedence rule stated where it can be read.
 *
 * **Precedence: the more fundamental KNOWN fact leads; an unknown never
 * outranks a known one.** So an unknown build with a known-unpublished chat
 * says "this chat hasn't been backed up yet" — that fact is known and no target
 * could satisfy it, while asserting anything about the build would be the
 * dishonesty the tri-state exists to prevent. Unknown × unknown stays allowed.
 */
export type ChatForkTargetVerdict =
  | { readonly kind: "allowed" }
  /**
   * A fact about THIS host's build. Per-row: B can be old while C is current,
   * so it renders as the row's own word and picking another host can fix it.
   */
  | {
      readonly kind: "hostRefused";
      readonly word: string;
      readonly detail: string;
    }
  /**
   * A fact about the SOURCE CHAT, true of every remote target. Renders ONCE as
   * a dialog-level notice and marks the remote class unselectable — the rows
   * stay silent because nothing is wrong with any row, and stamping it on each
   * would invite the user to try a different host, which cannot help.
   */
  | { readonly kind: "chatUnpublished"; readonly notice: string }
  /**
   * Also a source-chat fact, but TRANSIENT — it clears on its own in seconds.
   *
   * It blocks NOTHING. The row stays selectable AND submit stays enabled; this
   * verdict only speaks. Two reasons, and the first is the load-bearing one:
   *
   * 1. **Blocking here would make Layer 1 authoritative for a case the design
   *    says it is not.** Layer 1 is pre-submit UX; Layer 2 — the host's typed
   *    refusal — is the authority. A notice is precise pre-submit UX on its
   *    own; blocking is not required to deliver it, and claiming the block
   *    inverts the layering.
   * 2. It would be a dead end. The Fork button IS the retry affordance, so
   *    disabling it leaves the user reading "retry shortly" with nothing to
   *    press, waiting on a background refetch. The cost of not blocking is one
   *    cheap doomed round trip that comes back as `E_FORK_BOUNDARY_NOT_PUBLISHED`
   *    and renders inline exactly as it already does; the cost of blocking is a
   *    new control for a state that resolves itself in seconds.
   *
   * This does NOT generalize to `chatUnpublished`: that is durable, so there is
   * nothing to wait through and no dead end — which is why the two publication
   * states differ in BOTH row and submit treatment, for the same underlying
   * reason of how long each lasts.
   */
  | { readonly kind: "boundarySyncing"; readonly notice: string };

export const CHAT_NOT_BACKED_UP_NOTICE =
  "This chat hasn't been backed up yet, so another machine can't read its history. It backs up automatically — try again shortly.";

export const BOUNDARY_SYNCING_NOTICE =
  "Still syncing this turn — retry shortly.";

/**
 * What is true of EVERY remote target, independent of which host is currently
 * highlighted.
 *
 * Separate from the selection verdict below because it has a different SUBJECT.
 * Publication is a fact about the source chat: it does not vary by target, it
 * is knowable the moment the dialog opens, and it must be true on first paint
 * so nobody reaches for a host that could never have worked. Routing it through
 * the selection verdict made it wait for a highlight, so picking a host was
 * what appeared to break the picker — the same subject error as putting a
 * source-chat fact in a per-host column, one layer up.
 *
 * Takes no `isCrossHost` on purpose. "Is this chat readable from another
 * machine" has the same answer whichever row the user is standing on.
 */
export type ChatForkRemoteClassState =
  | { readonly kind: "open" }
  | { readonly kind: "unpublished"; readonly notice: string }
  | { readonly kind: "syncing"; readonly notice: string };

export function chatForkRemoteClassState(
  publication: ChatForkPublicationState,
): ChatForkRemoteClassState {
  if (publication.kind === "unpublished") {
    return { kind: "unpublished", notice: CHAT_NOT_BACKED_UP_NOTICE };
  }
  if (publication.kind === "boundaryUncovered") {
    return { kind: "syncing", notice: BOUNDARY_SYNCING_NOTICE };
  }
  return { kind: "open" };
}

/** Whether the remote class is out of reach — durable refusals only. */
export function remoteClassIsUnreachable(
  state: ChatForkRemoteClassState,
): boolean {
  return state.kind === "unpublished";
}

/** The dialog-level sentence for the class, or `null` when it has none. */
export function remoteClassNotice(
  state: ChatForkRemoteClassState,
): string | null {
  return state.kind === "open" ? null : state.notice;
}

/**
 * The whole gate, for one highlighted target.
 *
 * `isCrossHost === false` short-circuits to allowed: a same-host fork is served
 * from the source host's own store tier, so it needs neither the V12 contract
 * nor any publication at all. Gating it on the chat's backup state would block
 * the one fork that cannot fail for that reason.
 */
export function chatForkTargetVerdict(input: {
  readonly isCrossHost: boolean;
  readonly version: NegotiatedMethodVersion;
  readonly publication: ChatForkPublicationState;
}): ChatForkTargetVerdict {
  // A same-host fork is served from the source host's own store tier, so it
  // needs neither the V12 contract nor any publication at all. It stays
  // submittable even when the chat has never been backed up - blocking a LOCAL
  // fork on a CLOUD fact would be the subject error in its most damaging form.
  if (!input.isCrossHost) return { kind: "allowed" };
  // Known and universal first: no choice of target can make an unpublished
  // chat readable, so it outranks a per-host build fact even a known one.
  if (input.publication.kind === "unpublished") {
    return { kind: "chatUnpublished", notice: CHAT_NOT_BACKED_UP_NOTICE };
  }
  const support = chatForkTargetSupport(input.version);
  if (support.kind === "refused") {
    return {
      kind: "hostRefused",
      word: support.word,
      detail: support.detail,
    };
  }
  // Transient last among the knowns, and it blocks NOTHING - it only speaks.
  // Layer 1 is pre-submit UX; the host's typed refusal is the authority, so
  // claiming a block here would move that authority. See the variant's note.
  if (input.publication.kind === "boundaryUncovered") {
    return { kind: "boundarySyncing", notice: BOUNDARY_SYNCING_NOTICE };
  }
  return { kind: "allowed" };
}

/**
 * Whether this verdict lets the fork be submitted.
 *
 * `boundarySyncing` is deliberately submittable — see the variant's own note.
 * Only the two DURABLE refusals block: a target whose build cannot carry the
 * fork, and a chat no remote host can read at all. Both are conditions that
 * waiting does not fix.
 */
export function verdictAllowsSubmit(verdict: ChatForkTargetVerdict): boolean {
  return verdict.kind === "allowed" || verdict.kind === "boundarySyncing";
}

/**
 * The dialog-level sentence, or `null` when the verdict has nothing to say at
 * that level. A `hostRefused` verdict deliberately returns `null` here: its
 * explanation belongs on the row it is about.
 */
export function verdictNotice(verdict: ChatForkTargetVerdict): string | null {
  if (verdict.kind === "chatUnpublished") return verdict.notice;
  if (verdict.kind === "boundarySyncing") return verdict.notice;
  return null;
}

/**
 * Reads the wire response into the state the gate reasons about.
 *
 * `boundaryCovered === null` means NO ANSWER WAS COMPUTED, and it has TWO
 * causes that `published` distinguishes: no boundary was named, or the chat has
 * never been published at all — in which case `null` comes back even though a
 * boundary WAS asked, because there is no head to measure against. Reading
 * `published` first is what makes both safe here, and it is why the `published`
 * check below comes before the `boundaryCovered` one rather than beside it.
 *
 * Mapping `null` to `covered` is therefore only correct in the published case,
 * which is the only case it can reach. Collapsing it to `boundaryUncovered`
 * would block a fork on a question the client never posed.
 *
 * `publishedThroughTs` is deliberately unread: it is display metadata, and no
 * clock comparison exists anywhere in this feature.
 */
export function publicationStateFromResponse(response: {
  readonly published: boolean;
  readonly boundaryCovered: boolean | null;
}): ChatForkPublicationState {
  if (!response.published) return { kind: "unpublished" };
  if (response.boundaryCovered === false) return { kind: "boundaryUncovered" };
  return { kind: "covered" };
}
