import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import {
  chatPublicationDefinitiveReason,
  definitiveInvalidatesPublishedHead,
  type ChatPublicationDefinitiveReason,
} from "@/lib/chats/chat-publication-definitive";

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
   * version: unknown is not "unpublished", so nothing here may block.
   *
   * The host is then the only authority left, which is a description of THIS
   * arm rather than a general backstop this file may lean on: the host's own
   * coverage check is presence-only, so it does not refuse every fork this gate
   * declines to block. That is why a KNOWN-uncovered boundary is handled here
   * instead — see the `boundarySyncing` verdict.
   */
  | { readonly kind: "unknown" }
  /** Never published — no remote host can pull this transcript at all. */
  | { readonly kind: "unpublished" }
  /**
   * Published, but the head does not yet cover the chosen boundary. Transient
   * by construction: it clears within a publish sweep.
   */
  | { readonly kind: "boundaryUncovered" }
  /**
   * The host named a `definitive` reason, so this answer is FROZEN: waiting
   * cannot change it and re-asking cannot either. Distinct from `unknown` in
   * the direction that matters — `unknown` is "we never learned", this is "we
   * learned that it is over" — and distinct from `unpublished` in that it also
   * covers a chat published only PART of the way to the boundary.
   *
   * Deliberately NOT reachable from a frozen `covered`: see
   * `publicationStateFromResponse` and `definitiveInvalidatesPublishedHead`.
   */
  | {
      readonly kind: "definitivelyUnavailable";
      readonly reason: ChatPublicationDefinitiveReason;
    }
  /** Published, and the boundary is inside the published head. */
  | { readonly kind: "covered" };

/**
 * ONE verdict for a highlighted target, resolved from BOTH gates at once.
 *
 * The two gates have different subjects and therefore different presentations,
 * which is exactly why they are resolved together in one place rather than
 * `&&`-ed at each render site: every (version × publication) cell decided once,
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
   * A source-chat fact like `chatUnpublished`, and durable for a reason the
   * HOST named rather than one this client inferred from a snapshot: the
   * publication answer is frozen (`definitive`), so no amount of waiting or
   * re-asking moves it.
   *
   * Separate from `chatUnpublished` because the two say different things to a
   * user and only one of them is honest here. "It backs up automatically — try
   * again shortly" is exactly the sentence this verdict exists to stop showing;
   * the notice it carries is per-reason and never promises a wait.
   */
  | { readonly kind: "chatUnavailable"; readonly notice: string }
  /**
   * Also a source-chat fact, but TRANSIENT — it clears on its own within a
   * publish sweep.
   *
   * It BLOCKS SUBMIT, and leaves the row selectable. Both halves are
   * deliberate, and the block REVERSES an earlier decision this comment used to
   * defend, so the reversal is recorded here rather than quietly applied.
   *
   * **What the old reasoning got wrong.** It left submit enabled on the premise
   * that Layer 2 — the host's typed refusal — is the authority for an uncovered
   * boundary, so the worst case was one cheap doomed round trip answered by
   * `E_FORK_BOUNDARY_NOT_PUBLISHED`. That premise is false. The host's coverage
   * check is PRESENCE-only (`containsMessageId`), so a boundary turn that was
   * published mid-stream and has since finalized locally IS present in the
   * published head — at its partial version. The fork is then accepted, 200 OK,
   * and seeds a silently TRUNCATED turn. So the cost of not blocking was never
   * a visible error the user could act on; it was a wrong result that looks
   * right, which is the one outcome no amount of Layer 2 backstopping recovers.
   * (A host-side refusal for exactly this case lands alongside this change.
   * This half is what keeps the user out of the round trip to begin with.)
   *
   * **And the dead end it worried about is gone.** The second objection was
   * that the Fork button IS the retry affordance, so disabling it strands the
   * user with nothing to press. That held only while nothing re-asked. This
   * method now carries a CONDITION POLL LANE
   * (`CHAT_PUBLICATION_WAIT_POLL_LANE` in `host-method-policy-table.ts`) that
   * re-asks precisely while the answer is transient, so the button re-enables
   * on its own when the sweep lands. There is nothing to press because there is
   * nothing for the user to do — which is what the copy now says instead of
   * "retry shortly".
   *
   * The row stays SELECTABLE, unlike `chatUnpublished`. Nothing is wrong with
   * any host, the state is seconds long, and the row is where the user
   * configures the fork they are about to be allowed to make; making it inert
   * would throw that configuration away for a wait that outlasts it.
   */
  | { readonly kind: "boundarySyncing"; readonly notice: string };

export const CHAT_NOT_BACKED_UP_NOTICE =
  "This chat hasn't been backed up yet, so another machine can't read its history. It backs up automatically — try again shortly.";

/**
 * Describes a WAIT, not a retry.
 *
 * "Retry shortly" was written when this state left Fork enabled, so it named an
 * action the user had. Now that it blocks submit (see the `boundarySyncing`
 * variant), the same words would point at a button that is greyed out — the
 * dead end the old comment predicted. The poll lane is what makes the promise
 * true, so the sentence says what will happen rather than what to press.
 */
export const BOUNDARY_SYNCING_NOTICE =
  "Still syncing this turn to the cloud — forking to another machine unlocks as soon as it lands.";

/**
 * The four terminal sentences, one per `definitive` reason.
 *
 * None of them tells the user to wait, and that is the whole point: the state
 * they describe cannot clear on this connection, so "try again shortly" — the
 * copy every one of these used to be indistinguishable from — is false for all
 * four. Each says what is actually true of its own reason instead, and names
 * the one thing that COULD change it where such a thing exists.
 */
export const CHAT_DELETED_NOTICE =
  "This agent was deleted on its host, so its history can't be forked to another machine.";

export const CHAT_LINEAGE_SUPERSEDED_NOTICE =
  "Another copy of this agent took over its cloud backup, so this one's history can't be forked to another machine. Fork from that copy instead.";

/**
 * Honest about the one recovery that exists. The publisher will not retry
 * within this host process, so waiting on this connection genuinely never
 * clears it — but a host restart can, and the user is the person who can do
 * that.
 */
export const CHAT_BACKUP_HALTED_NOTICE =
  "This agent's cloud backup has stopped, so this turn can't be forked to another machine. Waiting won't restart it — restarting the host might.";

/**
 * A reason a newer host named that this build has no copy for. Says only what
 * this client actually knows — the backup will not finish and waiting will not
 * help — rather than guessing at a cause.
 */
export const CHAT_BACKUP_UNAVAILABLE_NOTICE =
  "This agent's cloud backup can't finish, so this turn can't be forked to another machine. Waiting won't change that.";

export function chatPublicationDefinitiveNotice(
  reason: ChatPublicationDefinitiveReason,
): string {
  if (reason === "chat-deleted") return CHAT_DELETED_NOTICE;
  if (reason === "lineage-superseded") return CHAT_LINEAGE_SUPERSEDED_NOTICE;
  if (reason === "backup-halted") return CHAT_BACKUP_HALTED_NOTICE;
  return CHAT_BACKUP_UNAVAILABLE_NOTICE;
}

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
  /** Frozen by a host-named `definitive` reason. Durable, like `unpublished`. */
  | { readonly kind: "unavailable"; readonly notice: string }
  | { readonly kind: "syncing"; readonly notice: string };

export function chatForkRemoteClassState(
  publication: ChatForkPublicationState,
): ChatForkRemoteClassState {
  if (publication.kind === "definitivelyUnavailable") {
    return {
      kind: "unavailable",
      notice: chatPublicationDefinitiveNotice(publication.reason),
    };
  }
  if (publication.kind === "unpublished") {
    return { kind: "unpublished", notice: CHAT_NOT_BACKED_UP_NOTICE };
  }
  if (publication.kind === "boundaryUncovered") {
    return { kind: "syncing", notice: BOUNDARY_SYNCING_NOTICE };
  }
  return { kind: "open" };
}

/**
 * Whether the remote class is out of reach — durable refusals only.
 *
 * This is the ROW-INERTNESS question, and it is narrower than "can this be
 * submitted". `syncing` blocks submit (see the `boundarySyncing` variant) yet
 * deliberately stays selectable: the wait is seconds long and the row is where
 * the user configures the fork the poll lane is about to unblock, so killing
 * the row would discard that work. The two durable states have nothing to wait
 * through, so there is no configuration worth preserving.
 */
export function remoteClassIsUnreachable(
  state: ChatForkRemoteClassState,
): boolean {
  return state.kind === "unpublished" || state.kind === "unavailable";
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
  // Frozen first, ahead of `unpublished`: it is the same universal subject and
  // strictly more informative. A chat the host has called definitively over is
  // one no target and no wait can help, and saying "it backs up automatically"
  // about it is the exact falsehood this arm was added to retire.
  if (input.publication.kind === "definitivelyUnavailable") {
    return {
      kind: "chatUnavailable",
      notice: chatPublicationDefinitiveNotice(input.publication.reason),
    };
  }
  // Known and universal next: no choice of target can make an unpublished
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
  // Transient last among the knowns. It BLOCKS SUBMIT while leaving the row
  // selectable - the host's presence-only coverage check means an uncovered
  // boundary can be ACCEPTED and seed a truncated turn, so Layer 2 is not the
  // backstop this branch once assumed. See the variant's note.
  if (input.publication.kind === "boundaryUncovered") {
    return { kind: "boundarySyncing", notice: BOUNDARY_SYNCING_NOTICE };
  }
  return { kind: "allowed" };
}

/**
 * Whether this verdict lets the fork be submitted.
 *
 * EVERY refusal blocks now, including the transient one. `boundarySyncing` used
 * to be exempt on the ground that the host would refuse an uncovered boundary
 * anyway; it does not — its check is presence-only, so an uncovered boundary
 * can be ACCEPTED and seed a truncated turn. See the variant's own note for the
 * full reversal. The distinction the two durable refusals still carry is over
 * the ROW, not the button: `remoteClassIsUnreachable`.
 */
export function verdictAllowsSubmit(verdict: ChatForkTargetVerdict): boolean {
  return verdict.kind === "allowed";
}

/**
 * The dialog-level sentence, or `null` when the verdict has nothing to say at
 * that level. A `hostRefused` verdict deliberately returns `null` here: its
 * explanation belongs on the row it is about.
 */
export function verdictNotice(verdict: ChatForkTargetVerdict): string | null {
  if (verdict.kind === "chatUnpublished") return verdict.notice;
  if (verdict.kind === "chatUnavailable") return verdict.notice;
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
function ordinaryPublicationState(response: {
  readonly published: boolean;
  readonly boundaryCovered: boolean | null;
}): ChatForkPublicationState {
  if (!response.published) return { kind: "unpublished" };
  if (response.boundaryCovered === false) return { kind: "boundaryUncovered" };
  return { kind: "covered" };
}

/**
 * The whole read of the wire response: the ordinary three-way above, plus the
 * one field that says whether it can still move.
 *
 * `definitive` is applied ON TOP of the ordinary reading rather than instead of
 * it, and the ordering is the point. The field means "this ANSWER is frozen",
 * not "this chat is finished", so a chat frozen at `covered` is a chat a remote
 * host can still pull — short-circuiting on `definitive` before reading
 * `published` / `boundaryCovered` would refuse that fork on the strength of
 * good news. The two reasons that DO invalidate the head whatever it covers are
 * named by `definitiveInvalidatesPublishedHead`, next to the protocol wording
 * they come from.
 *
 * The tri-state discipline is untouched underneath: `published` is still read
 * first, and `boundaryCovered: null` still never collapses to `false`.
 *
 * `definitive` is widened to `string` rather than typed as the wire enum, and
 * declared OPTIONAL, for the two compatibility reasons documented on
 * `chatPublicationDefinitiveReason`. The optionality is not laxness: a host
 * built before the field negotiates the same method version, so its response
 * takes the un-parsed same-version path and genuinely arrives without the key.
 * An absent field is the ordinary reading, never a reason.
 */
export function publicationStateFromResponse(response: {
  readonly published: boolean;
  readonly boundaryCovered: boolean | null;
  readonly definitive?: string | null;
}): ChatForkPublicationState {
  const ordinary = ordinaryPublicationState(response);
  const reason = chatPublicationDefinitiveReason(response.definitive);
  if (reason === null) return ordinary;
  if (
    ordinary.kind === "covered" &&
    !definitiveInvalidatesPublishedHead(reason)
  )
    return ordinary;
  return { kind: "definitivelyUnavailable", reason };
}
