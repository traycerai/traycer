import {
  FALLBACK_RUNG_KINDS,
  fallbackPolicySchema,
  type FallbackPolicy,
  type FallbackRungKind,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  reconcileKeyedGroups,
  revertKeyedGroups,
  toKeyedGroups,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";

/**
 * Which group an edit came from, so its status renders under the control that
 * produced it rather than once at the foot of the panel.
 *
 * The ticket's wording is "inline under the changed control", and a single
 * panel-wide line cannot satisfy it: this page has five groups, and a message
 * beneath the last one does not tell someone which of a dozen settings was
 * refused. The reducer therefore carries the origin of the edit - not the exact
 * control, which would be a second identity to keep in step, but the group,
 * which is the unit the user is looking at.
 */
export type FallbackPolicyField =
  | "enabled"
  | "ladder"
  | "behavior"
  | "tierGroups"
  | "overrides"
  // The danger zone is a group like any other for status purposes: a refused
  // reset has to say so under the button that was pressed, not under whichever
  // control happened to be edited last.
  | "danger";

/**
 * The panel's edit model.
 *
 * Every control in the Fallback section writes through this, so the ticket's
 * failure handling is decided once rather than per group. The ticket names two
 * kinds; the reducer distinguishes four, because the second kind kept turning
 * out not to be one thing:
 *
 *  - a **local validation failure** (blank family name, duplicate step,
 *    out-of-range bound) keeps the draft in the control, shows the error, and
 *    **persists nothing**;
 *  - a **host rejection** of a committed save shows the host's reason, and
 *    reverts the control to the last persisted value only when the draft on
 *    screen is still the one that was refused. Reverting unconditionally - as
 *    an earlier version of this said, and did - threw away typing the host had
 *    never judged;
 *  - **no answer at all** claims nothing about what is stored, because a
 *    dropped reply is not a refusal, and waits for a read-back;
 *  - **a refusal while an earlier answer is still missing** is both at once:
 *    the host really did reject this save, and nothing may yet be said about
 *    what it holds.
 *
 * After any of them, both the visible value and the persisted value are
 * recoverable from this state, which is what lets the panel say what is on
 * screen AND what is saved rather than leaving the user to guess which they are
 * looking at.
 */
export interface FallbackPolicyDraftState {
  /** The last policy the host confirmed. What a host rejection reverts to. */
  readonly persisted: FallbackPolicy;
  /**
   * What the controls render.
   *
   * Diverges from {@link FallbackPolicyDraftState.persisted} in four ways, not
   * the one this used to claim: while an edit is invalid (kept on screen with
   * its error), while a valid edit is typed but not yet committed, while a save
   * is in flight, and while a save's outcome is UNKNOWN - where the draft may
   * BE what the host stored and the whole point is that neither value may be
   * claimed until a read-back says.
   */
  readonly draft: FallbackPolicy;
  /**
   * All four steps, in the order the editor draws them - including the ones
   * that are turned off, which the wire `ladder` cannot represent because it
   * encodes enablement as PRESENCE.
   *
   * The cost, stated in the panel's own copy: turning a step off and reloading
   * loses where it sat, because only the enabled subset survives the round
   * trip. The alternative was a schema change to `{ kind, enabled }[]`, which
   * would have reached the host's validation and the engine's ladder walk for
   * a purely presentational fact.
   */
  readonly displayOrder: readonly FallbackRungKind[];
  /**
   * `draft.tierGroups` with a client-side identity on every candidate row, which
   * is the shape the groups editor renders.
   *
   * The same kind of state as {@link FallbackPolicyDraftState.displayOrder}: a
   * fact the editor needs that the wire format has nowhere to put. `TierCandidate`
   * is `{harnessId, modelFamily, reasoningEffort}` and carries no id, so a React
   * key has to come from somewhere - and content fails (two fresh rows are both
   * empty) while an index fails on a reorder, which these rows do. See
   * `fallback-tier-group-keys.ts`.
   *
   * Kept in step with `draft.tierGroups`, never derived from it on the fly: an
   * identity that is recomputed is not an identity.
   */
  readonly keyedTierGroups: readonly KeyedGroup[];
  /**
   * Set by a local validation failure. Nothing was sent.
   *
   * Cleared by the next `edited` that validates, and by a reply that is ABOUT
   * the draft on screen - never by one that judged an older revision, which has
   * not seen what the user is looking at. Wiping it there left an invalid draft
   * in the field with nothing beside it, reading as accepted.
   */
  readonly localError: string | null;
  /** Set by a save that did not succeed. See {@link FallbackSaveNotice}. */
  readonly hostError: FallbackSaveNotice | null;
  /**
   * Why everything on this page is out of date, or `null`.
   *
   * Set when a reset the host CONFIRMED could not be read back. Deliberately
   * NOT one more {@link FallbackSaveNoticeOutcome}, and the difference is
   * lifecycle rather than taxonomy: a save notice describes one request and is
   * correctly cleared by the next edit and the next save start, whereas this
   * describes the HOST'S ROW - replaced wholesale, and unread - which no
   * keystroke here can change. Sharing the channel would have meant carving an
   * exception into both of those arms, and a status line pinned to the danger
   * zone that a later refusal could not displace.
   *
   * So it renders as a panel-wide banner beside the unreadable-policy one,
   * which is the same kind of statement: what you are looking at is not what
   * the host has. Cleared by a successful read, by the remount such a read
   * triggers, and by a save that succeeds AND puts its own value on screen -
   * which is the matching-revision echo, and the old-revision echo that
   * corrects a refusal rollback. NOT by the third success path, the ordinary
   * moved-on one: there the host holds this reply's policy while the screen
   * holds a newer draft, so the values on display are still not the host's row
   * and the reset's result has still never been read. One sentence used to
   * cover those last two branches and was false of the first of them.
   *
   * Nor is it RAISED by a reset's failed read that a newer confirmed write has
   * already answered for - see
   * {@link FallbackPolicyDraftState.lastConfirmedRequestId}.
   *
   * Carries the revision as of the reset's DISPATCH, because its strongest
   * sentence is about where the values on screen came from and that sentence
   * expires the moment they change. "These are the settings from before the
   * reset" is true only while nothing has been submitted since the reset went
   * out; afterwards the screen holds the user's own edit, which a subsequent
   * save may well have stored. The banner still has something true to say then
   * - the reset's result has never been read - so it stays, with a weaker
   * second sentence rather than a false one. Dating that from the read's
   * FAILURE instead was wrong by a whole round trip: every ordinary control
   * stays live while the read is in flight.
   */
  readonly unrefreshedReset: FallbackUnrefreshedReset | null;
  /**
   * The newest request id whose success established
   * {@link FallbackPolicyDraftState.persisted}, or `null`.
   *
   * The same request-ORDER evidence `unknownSave` is discharged by, kept for
   * the one consumer that cannot reconstruct it: a reset's failed read-back
   * arrives long after the reset was dispatched, and must not raise a staleness
   * banner over a row that a LATER write has since established. Revisions
   * cannot answer that - they order the user's edits, not the requests - so
   * this is the id, minted in dispatch order like every other.
   */
  readonly lastConfirmedRequestId: number | null;
  /**
   * A revision at which the DISPLAYED values are known to equal the host's row,
   * or `null`.
   *
   * "Are the values on screen the ones the host has?" - and note that it is
   * about VALUES, which is why the sixth pass's reading of it (the revision a
   * confirmed REQUEST carried) was not enough. {@link adoptPolicyIntoView}
   * replaces `draft` without touching `revision`, so after either adoption path
   * the revision still names the edit that is no longer displayed, and a
   * confirmation recorded against the request's revision describes something
   * other than what the user is looking at (**D339**).
   *
   * Written at exactly three sites, each one a moment where the display and the
   * host's row are known to agree: `save-succeeded` when the confirmed
   * request's revision IS the display's; the correcting-rollback branch, which
   * puts the confirmed policy on screen; and `reconciled`'s ADOPTING arm, which
   * puts the read-back's policy on screen. The moved-on `reconciled` arm
   * writes nothing, because there the draft on screen was never dispatched at
   * all - {@link FallbackPolicyDraftState.persistedRevision} is stamped there
   * and is the field that must not be read as agreement.
   */
  readonly confirmedViewRevision: number | null;
  /**
   * The highest revision this editor has ever DISPATCHED, or `null` if it has
   * dispatched nothing.
   *
   * The positive evidence behind "hasn't been sent" (**D339**). Saying a
   * display was never sent is a claim, and before this field it was reached by
   * ELIMINATION - not the unanswered draft, not a rollback, not pending, not
   * confirmed - which is satisfied by three sequences where the values WERE
   * sent: a read-back that adopted them, a correcting rollback that adopted
   * them, and a settled-but-unconfirmed save whose only record
   * ({@link FallbackPolicyDraftState.pendingSaves}) was dropped when it
   * settled.
   *
   * `revision > lastDispatchedRevision` is the only thing that PROVES a display
   * unsent: revisions increase only on `edited`, and a dispatch stamps the
   * revision current at that moment, so a display above the high-water mark is
   * an edit made after everything this editor has ever sent.
   *
   * Stamped ONLY where a draft is dispatched - `carries: "draft"`. `reset` and
   * `restore` dispatch DEFAULTS, not the values on screen, so counting them
   * would make "what's on screen was sent" true of a display those requests
   * never carried: the same false-claim class D330 removed, arrived at from the
   * other side. After a reset the display is genuinely unsent, and the
   * staleness banner - not this field - owns the story of what the host did.
   */
  readonly lastDispatchedRevision: number | null;
  /**
   * The group the most recent edit came from - where this panel's one status
   * line renders, whether that line is an error or "Saving…".
   *
   * Deliberately not an `errorField`: scoping the error but not the spinner
   * would put the two halves of one outcome in different places, and scoping
   * neither would print "Saving…" under all five groups at once.
   *
   * It is a SINGLE field while {@link FallbackPolicyDraftState.pendingSaves} is
   * a list, and that asymmetry is deliberate rather than left over. Several
   * saves really can be in flight at once (FC3), but there is one person
   * looking at one place, so the panel keeps one status line and points it at
   * the group that was last acted on.
   *
   * The consequence when two saves overlap is accepted and visible: the second
   * one's field owns the line while both are in flight, and then the line MOVES
   * to whichever save settles - `applySaveFailed` assigns `action.field`, the
   * field the failing request came from, so an outcome is always reported under
   * the control that produced it. What the field cannot do is show two at once:
   * if the earlier save fails and the later one is still running, its notice
   * takes the line and the later save's "Saving…" is not drawn anywhere.
   */
  readonly activeField: FallbackPolicyField | null;
  /**
   * Bumped by every `edited`. Identifies WHICH draft a save is carrying.
   *
   * A save is a round trip, and the response echoes the policy that was SENT.
   * Writing that echo into `draft` unconditionally overwrites anything the user
   * changed while it was in flight - the value on screen jumps back to what they
   * had a moment ago, and nothing marks it as having happened. The revision is
   * how the reducer tells "this is the answer to the draft I am still showing"
   * from "this is the answer to a draft that has moved on".
   */
  readonly revision: number;
  /**
   * Every save that has been sent and not yet answered, oldest first.
   *
   * A LIST, not the single `savingRevision` this replaced, and the difference is
   * the whole of FC3. Every control on this page can commit while another save
   * is in flight, so two are ordinary: start A at revision 1, start B at
   * revision 2. One slot meant B's start overwrote A's marker, so when A's reply
   * arrived the reducer compared revision 2 against revision 2, decided the echo
   * answered the draft on screen, and wrote A's older policy over B's. A third
   * edit then started from that stale value and could permanently undo B.
   *
   * Correlating instead of serialising is deliberate: serialising would delay
   * the second request until the first settled, which changes WHEN a commit is
   * dispatched. Nothing about FC3 needs that, and the commit-on-blur/Enter rule
   * (D181) is pinned on the dispatch being synchronous with the gesture.
   */
  readonly pendingSaves: readonly PendingFallbackSave[];
  /**
   * The revision whose reply produced {@link FallbackPolicyDraftState.persisted}.
   *
   * Guards the OTHER direction of the same race. Replies are FIFO in practice,
   * but nothing in this reducer depends on that, and if B's reply is processed
   * before A's then A - the older value - would otherwise land in `persisted`
   * and become what the next refusal reverts to.
   *
   * An ORDERING watermark, and nothing else. It is emphatically NOT the answer
   * to "are the values on screen the confirmed ones" - the panel asked it that
   * for one pass and got a false answer in both directions, because a moved-on
   * `reconciled` stamps it while keeping a draft the host never saw, and the
   * correcting rollback adopts a confirmed policy without moving `revision`.
   * That question is answered by {@link fallbackPolicyValuesEqual}.
   */
  readonly persistedRevision: number;
  /**
   * The save whose outcome the host never told us, or `null`.
   *
   * Set only by a `save-failed` carrying {@link FallbackSaveNotice} outcome
   * `"unknown"` - a transport failure after the request was dispatched, where
   * the host may well have committed and lost the reply. It is the read-back's
   * ticket: a `reconciled` naming any other request is an answer to an episode
   * that has already been superseded, and is dropped.
   *
   * It is an OBLIGATION, and only evidence about the stored row discharges it:
   * a `reconciled` that names it, or a save dispatched LATER that succeeded.
   * Notably not: another request starting, or another request being refused.
   * Both used to clear it - starting did so directly, and a refusal did so in
   * effect by replacing the notice that carries the retry - and each left the
   * panel stating what was in force on the strength of a value the lost reply
   * may already have overwritten.
   */
  readonly unknownSave: UnknownFallbackSave | null;
  /**
   * The revision whose draft the host REFUSED, or `null`.
   *
   * "What the controls show is not something the user is still authoring" -
   * either a value the host rejected and we left standing, or the rollback we
   * put back in its place. Compared against the current
   * {@link FallbackPolicyDraftState.revision}: an `edited` moves that and clears
   * this, so the pair says "refused, and nothing typed since".
   *
   * A DEDICATED field rather than a read of `hostError.outcome`, which is what
   * the first attempt at this used and why a variant survived it. The notice
   * carries what to TELL the user, and the same refused draft can wear more
   * than one notice: a refusal arriving while an earlier save's outcome is
   * unknown keeps the `unknown` notice, because the uncertainty is the more
   * important thing to say and it is what keeps "Check again" on screen. Keying
   * the "is this a refused draft" question on that string therefore answered NO
   * for a genuinely refused draft, and the authoritative read-back that
   * followed cleared the ticket and the notice while leaving the refused value
   * on display - the page then showing a setting the host does not have, with
   * nothing left to say so. The two facts are independent, so they are stored
   * independently.
   */
  readonly refusedDraft: FallbackRefusedDraft | null;
  /**
   * The reset or restore whose own reply was lost and which nothing has
   * accounted for since, or `null` while the host's row is accounted for.
   *
   * This is DISPLAY AUTHORITY: the right of any sentence to say what the host
   * holds. An operation that does not carry what is on screen may already have
   * replaced the host's row, and a lost reply says nothing about WHEN it landed
   * - so until something re-reads the row, nothing displayed may be called what
   * the host has.
   *
   * Held HERE rather than read off `unknownSave`, which is the tenth pass's
   * correction and the reason this field exists at all. The obligation outlives
   * the notice that raised it: a ticket is REPLACED by the next failure, so
   * "reset lost, then a draft save lost" put a draft-carrying ticket in the slot
   * and the page went back to claiming the host's row - the rule was right and
   * its carrier was wrong. Nothing but confirming evidence clears this.
   *
   * Cleared by exactly three things, each of which establishes the row: a
   * successful read-back, a successful reset/restore reply, and the staleness
   * banner's read-again success (which remounts this editor, so it arrives as a
   * fresh initial state rather than as a transition). Deliberately NOT a
   * successful draft save: request ids order DISPATCH, not the order the host
   * applied things, so a save that went out after the lost reset can still have
   * been overwritten by it.
   */
  readonly unverifiedHostRow: FallbackSaveCarries | null;
  /**
   * The revision at which this reducer put an AUTHORITATIVE HOST POLICY in the
   * controls, or `null`.
   *
   * The other way the display can be a value the user did not author, beside
   * {@link FallbackPolicyDraftState.refusedDraft} - and the two are read
   * together, never apart, through {@link draftIsNotUserAuthored}. A rollback
   * is a value this reducer put back; an ADOPTION is a value this reducer took
   * from the host. Both are screens nobody typed, and every arm that asks "may
   * I replace what is on screen with the row the host has just told me about?"
   * has to answer yes to both.
   *
   * It exists because `refusedDraft` was carrying that question alone and is
   * cleared by the very branch that adopts. The correcting rollback clears the
   * refusal marker (correctly - the value on screen is no longer the refused
   * one) and left nothing in its place, so a SECOND newer reply saw an
   * unmarked display, read it as the user's own edit, and took the moved-on
   * arm: `persisted` advanced to that reply's policy while the controls kept
   * the first one, and `confirmedViewRevision` - stamped by the first adoption
   * and never moved - went on certifying the display as the host's row. The
   * page then said the stale controls were in force, with no reset, failed read
   * or lost reply anywhere in the sequence.
   *
   * Written at ONE site: the correcting-rollback branch of
   * {@link applySaveSucceeded}. The ordinary matching-revision echo
   * deliberately does not write it - what that puts on screen is the user's own
   * committed value, confirmed, which is a different thing from a policy
   * adopted over what they were looking at.
   *
   * ## `applyReconciled`'s adopting arm also adopts, and is deliberately unmarked
   *
   * That arm writes the read-back's policy into the controls too, so the
   * symmetry argument says it should stamp this field. It does not, and it does
   * not need to, because it sets `persistedRevision` to `state.revision` in the
   * same return. For any later `save-succeeded` to reach the branch that
   * consults {@link draftIsNotUserAuthored} it needs BOTH
   * `pending.revision !== state.revision` and
   * `pending.revision >= state.persistedRevision` - which after that arm means
   * `pending.revision > state.revision`. A pending save's revision is stamped
   * at `save-started` and the revision only ever increases, so no outstanding
   * reply can carry a higher one; every later reply lands on the
   * matching-revision echo path instead. The one action that does move the
   * revision is `edited`, and that is also the action that makes the display
   * the user's own and clears this field. So the adopted-but-unmarked display
   * cannot be overwritten.
   *
   * That protection is supplied by `persistedRevision`, in a different function,
   * and this paragraph is the only place it is written down - which makes the
   * next change to how that arm stamps `persistedRevision` load-bearing on
   * this field. **A second write here was considered and declined:** no recipe
   * could redden it, and an unfalsifiable write is what this file already
   * refused when it declined a defensive `confirmedViewRevision` clear on the
   * moved-on branch. The symmetry is worth less than the honesty about which
   * mechanism is doing the work.
   *
   * Cleared by `edited` and by nothing else. Note the clear is belt-and-braces
   * rather than load-bearing: {@link adoptedViewOnScreen} keys on the revision,
   * and `edited` bumps the revision on both of its returns, so the marker goes
   * stale on any edit whether or not it is nulled. Both mechanisms have to be
   * removed together before the CONTROL cell in `fallback-policy-draft.test.ts`
   * reddens - measured, as recipe 9c. The explicit clear stays because
   * `refusedDraft: null` sits beside it doing the identical job for the
   * identical reason, and that one is pre-existing: this is the file's idiom for
   * "an edit revokes what the reducer put there", not a defensive habit.
   */
  readonly adoptedView: FallbackAdoptedView | null;
}

/**
 * A host policy this reducer installed into the controls.
 *
 * A record with one field rather than a bare `number | null`, matching
 * {@link FallbackRefusedDraft} beside it: the two are read as a pair and a
 * shared shape keeps {@link adoptedViewOnScreen} and
 * {@link refusedDraftOnScreen} answering the same question the same way.
 */
export interface FallbackAdoptedView {
  /** The revision the adopted values sit at. */
  readonly revision: number;
}

/**
 * A refusal the host really made, and what this reducer did about it.
 *
 * ONE record rather than a revision beside a disposition flag, because the two
 * must agree: there is no such thing as a refused draft whose disposition is
 * unknown, and a pair of fields would let one be written without the other.
 * Both refusal arms that leave a judged value on screen construct this, and the
 * disposition is RECORDED at those two branches rather than inferred later from
 * whether the values happen to equal `persisted` - which is not the same
 * question (a refused draft can coincide with the persisted policy).
 */
export interface FallbackRefusedDraft {
  /** The revision the refused or restored value sits at. */
  readonly revision: number;
  /**
   * `true` when the reducer put `persisted` back in the controls, `false` when
   * the value the host REFUSED is still on screen because another outcome was
   * unknown and reverting would have replaced a true statement with a false one.
   *
   * The display's account turns on this and on nothing else: "your last saved
   * settings, put back" is a lie about a refused draft that was never restored.
   */
  readonly restoredPersisted: boolean;
}

/**
 * What a dispatched request sends. See the `save-started` action's own field.
 */
export type FallbackSaveCarries = "draft" | "reset" | "restore";

/** One dispatched, unanswered save. */
export interface PendingFallbackSave {
  readonly requestId: number;
  /**
   * Carried from the dispatch, not re-derived.
   *
   * A reply tells you nothing about what its request sent, and by the time one
   * arrives the only observable operation is whatever happened last - so this
   * travels with the record, exactly as `revision` does and for the same
   * reason.
   */
  readonly carries: FallbackSaveCarries;
  /** The revision the request carries - captured at `save-started`, because by
   * reply time the only observable revision is the current one, which is
   * exactly the fact under question. */
  readonly revision: number;
}

export interface UnknownFallbackSave {
  readonly requestId: number;
  /**
   * What the unanswered request sent, copied from its pending record.
   *
   * The notice's FIRST arm - "what's on screen is the unanswered draft" - is
   * only true of a `"draft"` request. A reset or restore whose own reply is
   * lost creates an unknown outcome at the display's revision while having
   * carried none of those values, and without this the page attaches the
   * reset's uncertainty to an edit the reset never saw (**D347**).
   */
  readonly carries: FallbackSaveCarries;
  /**
   * The revision at the moment the outcome became unknown.
   *
   * The read-back adopts the host's policy into `draft` while this is still the
   * current revision - i.e. the user has not typed since - OR while the screen
   * is showing a refusal rollback, which is a value this reducer put there
   * rather than one the user authored. Without that second case a refusal
   * landing during the read window leaves the rollback on screen for good: it
   * does not move the revision, so the check above reads "they have moved on"
   * about a draft nobody chose.
   */
  readonly revision: number;
}

/**
 * What a failed save is allowed to CLAIM, which is not the same question as
 * what went wrong.
 *
 * The panel used to answer every failure with "your last saved settings are
 * back on screen and still in force". That is a statement about the host's
 * stored row, and a dropped socket is not evidence for it: the request may have
 * been committed and only the reply lost. Saying it anyway is at its worst
 * exactly where it matters most - the user turns automatic fallback off, the
 * reply is lost, and the page tells them it is off while the host has it on.
 *
 *  - `refused-reverted` - the host answered and rejected the value, and nothing
 *    newer was on screen, so the control was returned to what is stored. Both
 *    halves of the old sentence are true.
 *  - `refused-kept` - the host answered and rejected an OLDER draft while the
 *    user has since changed the same page. The refusal is real and worth
 *    saying; the revert is not, because it would throw away typing the host
 *    never judged.
 *  - `unknown` - the request reached the wire and no answer came back. Nothing
 *    may be claimed about what is stored until a read-back says.
 *  - `refused-unverified` - the host answered and rejected THIS save while an
 *    EARLIER save's outcome is still unknown. Split out from `unknown`, which
 *    it used to borrow: both carry an outstanding ticket, but only this one
 *    carries a refusal the host actually made, and conflating them meant a
 *    later success that discharged the ticket could not tell "the notice this
 *    ticket owned" from "a refusal that is still true". The first must go when
 *    the ticket is settled; the second must not.
 *
 * A confirmed reset whose read-back failed is deliberately NOT one of these.
 * Every outcome here describes ONE save, which is why the next edit and the
 * next save start both clear it: by then it names a value that is no longer on
 * screen. That row was replaced on the host, which stays true however much is
 * typed afterwards, so it lives in
 * {@link FallbackPolicyDraftState.unrefreshedReset} instead of borrowing a
 * lifecycle that would erase it on the next keystroke.
 */
export type FallbackSaveNoticeOutcome =
  | "refused-reverted"
  | "refused-kept"
  | "unknown"
  | "refused-unverified";

/**
 * A confirmed reset this editor has not been able to read back.
 *
 * Both fields describe the RESET, not the moment its read failed, and that
 * distinction is the whole of the second R8 finding.
 */
export interface FallbackUnrefreshedReset {
  readonly message: string;
  /**
   * The draft revision as of the reset's DISPATCH - `pendingSaves`' entry for
   * it, not `state.revision` when the read came back.
   *
   * The banner's strongest sentence is "the settings below are the ones you had
   * before the reset", and that is a claim about where the displayed values
   * CAME FROM. Reading the revision at read-failure time dated it to the wrong
   * event: the read is a round trip and every ordinary control stays live
   * during it, so an edit submitted inside that window had already moved the
   * revision by the time the failure arrived. The banner then compared equal
   * and called a policy authored AFTER the reset - possibly already stored -
   * the settings from before it. Captured at dispatch, the comparison asks the
   * question it means to: has anything on screen changed since the reset went
   * out?
   */
  readonly revision: number;
  /**
   * The reset's own request id, so a later reply can be ordered against it.
   *
   * `lastConfirmedRequestId > requestId` is the test for "the policy the host
   * has confirmed was written AFTER this reset", which is what decides whether
   * a rollback to `persisted` is putting pre-reset values back on screen or a
   * post-reset one the host is actively using.
   */
  readonly requestId: number;
}

export interface FallbackSaveNotice {
  readonly message: string;
  readonly outcome: FallbackSaveNoticeOutcome;
}

/**
 * What the CLASSIFIER at the call site decided, before the reducer knows
 * whether a revert applies. Kept separate from
 * {@link FallbackSaveNoticeOutcome} so neither can be passed where the other
 * belongs, and the two are deliberately different SIZES: only the caller can
 * tell `refused` from `unknown`, and only the reducer can tell the three
 * refusal notices apart - whether it reverted, whether the user has moved on,
 * and whether an earlier reply is still missing.
 */
export type FallbackSaveFailureOutcome = "refused" | "unknown";

/**
 * Whether two policies hold the same settings.
 *
 * This exists because the panel needs to say "what is on screen is in force",
 * and that is a claim about VALUES. It was previously derived from
 * `revision === persistedRevision`, which is an ordering watermark and not the
 * same question - the two stop describing the same thing on both of this
 * reducer's adoption paths, in opposite directions:
 *
 *  - a moved-on `reconciled` stamps `persistedRevision = state.revision` while
 *    deliberately KEEPING the user's unsent draft, so the numbers compare equal
 *    over two different policies and an edit that never left the browser was
 *    reported as saved;
 *  - the correcting-rollback adopt writes the confirmed policy into `draft`
 *    without advancing `revision`, so the numbers differ over one identical
 *    policy and a value the host had just confirmed was reported as unsaved.
 *
 * A marker maintained across those paths would work until the next path forgot
 * to maintain it, which is the failure this batch has now produced four times.
 * Comparing the values cannot drift from the sentence it licenses.
 *
 * Field-by-field rather than a generic deep equal: the policy is eight fields
 * of known shape, and a structural walk would have to decide what to do about
 * key order and `undefined` on its own. `reasonOverrides` absent and
 * `reasonOverrides` empty both mean "no per-reason overrides" and compare
 * EQUAL here, because they render identically and the user cannot tell them
 * apart.
 *
 * The cost of enumerating is that a NEW policy field is equal to itself by
 * omission until someone adds it here, and every sentence this function
 * licenses is then false about an edit to that field alone: it would compare
 * equal to `persisted`, so `draftConfirmed` would call an unsaved change
 * stored, and `displayDispatchState` would call it `loaded-unchanged`. Eight is
 * the count as of `destinationExclusions`; if that number and the comparisons
 * below disagree, the comparisons are what is wrong.
 */
export function fallbackPolicyValuesEqual(
  a: FallbackPolicy,
  b: FallbackPolicy,
): boolean {
  if (
    a.enabled !== b.enabled ||
    a.graceWindowSeconds !== b.graceWindowSeconds ||
    a.maxWaitMinutes !== b.maxWaitMinutes ||
    a.returnToPreferred !== b.returnToPreferred
  ) {
    return false;
  }
  if (!sameRungOrder(a.ladder, b.ladder)) return false;
  if (!sameTierGroups(a.tierGroups, b.tierGroups)) return false;
  if (
    !sameDestinationExclusions(a.destinationExclusions, b.destinationExclusions)
  ) {
    return false;
  }
  return sameReasonOverrides(a.reasonOverrides, b.reasonOverrides);
}

/**
 * Whether two policies exclude the same destinations.
 *
 * As a SET, unlike `ladder` beside it, and the difference is what the field
 * means rather than a shortcut: the ladder's order is the order the engine
 * walks, while an exclusion list is a membership test. Two lists naming the
 * same providers in a different order render the same checkboxes and behave
 * identically, so calling them different would report an edit nobody made -
 * and the editor writes through a `Set`, which does not promise an order.
 *
 * Duplicates collapse for the same reason. They cannot be authored here, but a
 * policy written elsewhere can carry them and the second copy changes nothing
 * a user can see.
 */
function sameDestinationExclusions(
  a: FallbackPolicy["destinationExclusions"],
  b: FallbackPolicy["destinationExclusions"],
): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const harnessId of left) {
    if (!right.has(harnessId)) return false;
  }
  return true;
}

function sameRungOrder(
  a: readonly FallbackRungKind[],
  b: readonly FallbackRungKind[],
): boolean {
  return a.length === b.length && a.every((rung, at) => rung === b[at]);
}

function sameTierGroups(
  a: readonly TierGroup[],
  b: readonly TierGroup[],
): boolean {
  // Both indexed reads below are in range by construction - the lengths are
  // compared first and `every` walks only existing indices - which is why
  // neither has an `=== undefined` guard. `noUncheckedIndexedAccess` is off in
  // `tsconfig.app.json`, so those guards were unreachable code the type could
  // see through, not defence against a real absence.
  if (a.length !== b.length) return false;
  return a.every((group, at) => {
    const other = b[at];
    if (group.id !== other.id) return false;
    if (group.candidates.length !== other.candidates.length) return false;
    return group.candidates.every((candidate, candidateAt) => {
      const otherCandidate = other.candidates[candidateAt];
      return (
        candidate.harnessId === otherCandidate.harnessId &&
        candidate.modelFamily === otherCandidate.modelFamily &&
        candidate.reasoningEffort === otherCandidate.reasoningEffort
      );
    });
  });
}

function sameReasonOverrides(
  a: FallbackPolicy["reasonOverrides"],
  b: FallbackPolicy["reasonOverrides"],
): boolean {
  // Through `Object.entries` and a `Map` rather than indexing the partial
  // record by a string key, which would need a cast this repo does not allow.
  const left = new Map(Object.entries(a ?? {}));
  const right = new Map(Object.entries(b ?? {}));
  if (left.size !== right.size) return false;
  for (const [reason, value] of left) {
    if (!right.has(reason)) return false;
    const other = right.get(reason);
    // `Map.get`'s signature, not a real absence: `has` above already said the
    // key is present. The narrowing is what the two comparisons below need.
    //
    // There is deliberately no `value === undefined` half. Nothing can put an
    // explicit `undefined` in an override map: the schema's value is
    // `union([ladder, literal("off")])`, which rejects it on the way in, and
    // the editor's own writers delete the key (`withoutReason` rest-destructures
    // it away, `withOverrides` drops the whole field when empty) rather than
    // assigning it. So the type saying `value` is present is the type being
    // RIGHT, and the guard was unreachable - which is the opposite of the
    // reading where a flagged `=== undefined` means the type is too narrow.
    if (other === undefined) return false;
    if (value === "off" || other === "off") {
      if (value !== other) return false;
      continue;
    }
    if (!sameRungOrder(value, other)) return false;
  }
  return true;
}

/** Whether any save is awaiting a reply. One source of truth for the spinner. */
export function fallbackSaveInFlight(state: FallbackPolicyDraftState): boolean {
  return state.pendingSaves.length > 0;
}

/**
 * Identifies a save across its own round trip.
 *
 * Minted at the call site rather than read off the reducer, because `commit`
 * dispatches `edited` and `save-started` back to back and cannot observe the
 * revision the first one produced - the reducer has not run yet. The id is the
 * handle; the reducer pairs it with the revision itself.
 */
let nextSaveRequestId = 0;

export function createFallbackSaveRequestId(): number {
  nextSaveRequestId += 1;
  return nextSaveRequestId;
}

/**
 * Named rather than inlined into the union below because its arm is the only
 * one that branches four ways, so it lives in {@link applySaveFailed} instead
 * of in the reducer's `switch`.
 */
export interface FallbackSaveFailedAction {
  readonly type: "save-failed";
  readonly requestId: number;
  readonly message: string;
  readonly field: FallbackPolicyField;
  readonly outcome: FallbackSaveFailureOutcome;
}

export type FallbackPolicyDraftAction =
  | {
      readonly type: "edited";
      readonly policy: FallbackPolicy;
      readonly field: FallbackPolicyField;
      /**
       * The candidate identities after this edit, or `null` from a control that
       * does not touch model groups (every control outside the groups editor),
       * meaning the rows keep the identities they have.
       *
       * Required rather than optional so the question is answered at each of
       * the panel's commit sites: only the editor knows whether a row was
       * inserted, removed or moved, and reconstructing that here from the
       * policy alone is the index-keying this model exists to avoid.
       */
      readonly keyedTierGroups: readonly KeyedGroup[] | null;
    }
  | {
      readonly type: "reordered";
      readonly displayOrder: readonly FallbackRungKind[];
    }
  // Carries its own field rather than inheriting whatever `edited` last set:
  // the reset has no `edited` before it, so an inherited `activeField` would
  // leave its spinner rendering under some other group - or nowhere.
  | {
      readonly type: "save-started";
      readonly field: FallbackPolicyField;
      readonly requestId: number;
      /**
       * What this request sends, which is not always what is on screen.
       *
       * `"draft"` is the ordinary save and the only one that carries the
       * displayed values. `"reset"` and `"restore"` send server-chosen
       * defaults the display never held.
       *
       * Two consumers, and they read it at different widths.
       * {@link FallbackPolicyDraftState.lastDispatchedRevision} only asks
       * `=== "draft"`, because its question is whether the display was sent.
       * The `unknown` notice needs the OPERATION, because a lost reply has to
       * be described as the thing that was lost - calling a restore "the reset"
       * is the same false sentence this panel keeps being audited for, one
       * noun over.
       *
       * Required rather than defaulted, so a new dispatch site has to say which
       * it is.
       */
      readonly carries: FallbackSaveCarries;
    }
  | {
      readonly type: "save-succeeded";
      readonly requestId: number;
      readonly policy: FallbackPolicy;
    }
  | FallbackSaveFailedAction
  /**
   * The authoritative read-back after a save whose outcome was unknown.
   *
   * The ONLY action that installs a policy this editor did not send, and it is
   * gated for that reason: it must name the request that went unanswered
   * (`requestId`), and it may replace what is on screen only while the user has
   * not edited since - or while what is on screen is a refusal ROLLBACK, which
   * is this reducer's own value rather than the user's. The standing rule is
   * intact: a later read never yanks a control out from under someone mid-edit,
   * and a rollback is by definition not something they were editing. This is
   * the one state where NOT reading back means leaving a false claim on the
   * page.
   */
  | {
      readonly type: "reconciled";
      readonly requestId: number;
      readonly policy: FallbackPolicy;
    }
  /**
   * A reset the host CONFIRMED whose follow-up read failed.
   *
   * Separate from `save-failed` because the reset is not in doubt and must not
   * be reported as refused: the host has already replaced the policy. What
   * failed is the read that would let the editor show it, so the values still
   * rendered are known-stale rather than merely unconfirmed, and the recovery
   * is to read again - not to save anything.
   */
  | {
      readonly type: "reset-unrefreshed";
      readonly requestId: number;
      readonly message: string;
    };

/**
 * The editor's row order for a stored policy.
 *
 * Enabled steps in the order the ladder stores them, and the steps that are
 * turned off in the canonical order - placed **before the `notify` slot**, not
 * after the whole ladder. That second half is the reload behaviour
 * {@link FallbackPolicyDraftState.displayOrder} documents: a disabled step has
 * no stored position to restore, so it goes as late as it can.
 *
 * As late as it can is not the END, and that distinction is the whole point.
 * `notify` is the terminal step - the engine's ladder walk stops at the first
 * one it reaches - so a row sitting after it is a row that can never run. A
 * disabled step is exactly the row a user is about to turn back ON, and
 * appending it past `notify` handed them a step that reads as enabled and is
 * unreachable, with nothing on screen saying so. The wire format permits such
 * a ladder (`fallbackPolicySchema` checks length and uniqueness only) and the
 * host stores it verbatim, so nothing downstream repairs it either.
 *
 * An externally authored early `notify` still renders where it is stored: the
 * enabled steps keep their ladder order either side of it, and only the
 * disabled placeholders - which have no stored position to be honest about -
 * move to just before it. A ladder with no `notify` at all needs no insertion
 * point, and the canonical order already ends with `notify`, so the disabled
 * block lands correctly by itself.
 */
export function fallbackDisplayOrder(
  ladder: readonly FallbackRungKind[],
): readonly FallbackRungKind[] {
  // No de-duplication or membership filter on `ladder`: it arrives parsed
  // through `fallbackPolicySchema`, whose refine already rejects a repeated
  // step, so a guard here would be a branch no input can reach.
  const disabled = FALLBACK_RUNG_KINDS.filter((rung) => !ladder.includes(rung));
  const notifyAt = ladder.indexOf("notify");
  if (notifyAt === -1) return [...ladder, ...disabled];
  return [...ladder.slice(0, notifyAt), ...disabled, ...ladder.slice(notifyAt)];
}

/**
 * The row order to render for a policy that arrived from the host, given the
 * order the editor is currently showing.
 *
 * The question this answers is NOT "what order does this ladder imply" -
 * {@link fallbackDisplayOrder} answers that, and answering it here is the
 * defect. A save echo carries back the ladder that was just SENT, which
 * encodes enablement as PRESENCE and therefore cannot say where the turned-off
 * steps sat. Re-deriving from it moved them, so the sequence "turn a step off,
 * let the echo land, turn it back on" wrote a ladder in an order the user
 * never arranged.
 *
 * So: if the incoming ladder is what the order on screen ALREADY produces for
 * that set of enabled steps, the two agree about everything the ladder can
 * express and the local order is the strictly better-informed one - it also
 * knows where the disabled steps go. Keep it. Otherwise the incoming policy
 * genuinely reorders the ladder (a restore, or a policy written elsewhere) and
 * the local order is describing something else; derive afresh.
 */
export function fallbackDisplayOrderFor(
  displayOrder: readonly FallbackRungKind[],
  ladder: readonly FallbackRungKind[],
): readonly FallbackRungKind[] {
  const projected = fallbackLadderFrom(displayOrder, new Set(ladder));
  const agrees =
    projected.length === ladder.length &&
    projected.every((rung, at) => rung === ladder[at]);
  return agrees ? displayOrder : fallbackDisplayOrder(ladder);
}

/**
 * The order to commit when a step is turned back ON, which may not leave it
 * after the terminal `notify`.
 *
 * {@link fallbackDisplayOrder} puts DISABLED steps before the `notify` slot for
 * exactly this reason, but it only runs at hydration and on a ladder the local
 * order disagrees with - and neither happens on the path that matters. Hydrate
 * an externally authored `[profile, notify, tier]`: `tier` is ENABLED and
 * stored after `notify`, so the editor renders it there, honestly. Turn it off
 * and the local order keeps it there (correctly - a disable must not move a
 * row). The echo agrees with that order, so nothing re-derives. Turn it back on
 * and the ladder sent is `[profile, notify, tier]` again: a step below the step
 * that terminates the walk, which can never run, with nothing on screen saying
 * so. The wire schema permits it and the host stores it verbatim.
 *
 * So the repair belongs at the moment of ENABLING, which is the moment the row
 * stops being a placeholder and starts being a step that is supposed to run.
 * A policy merely being DISPLAYED is never rewritten - an externally authored
 * early `notify` keeps its enabled steps exactly where the host stored them.
 *
 * This is not the only way a row can end up under `notify`, and an earlier
 * version of this comment claimed it was, on the reasoning that
 * `moveFallbackRung` holds the `notify` slot fixed. Fixing the slot stops
 * `notify` from moving; it does nothing about the other rows moving PAST it,
 * which a drag or the arrows could do until {@link moveFallbackRung} was given
 * the boundary rule it now carries. The two repairs are separate because the
 * moments are: enabling promotes one row that was already placed, and a move is
 * refused rather than adjusted.
 */
export function fallbackDisplayOrderEnabling(
  displayOrder: readonly FallbackRungKind[],
  rung: FallbackRungKind,
): readonly FallbackRungKind[] {
  // `notify` is the terminal step, not a participant: enabling it cannot put it
  // after itself, and it has no handle to be moved by.
  if (rung === "notify") return displayOrder;
  const notifyAt = displayOrder.indexOf("notify");
  const rungAt = displayOrder.indexOf(rung);
  // No terminal step in the order, or the row already runs before it.
  if (notifyAt === -1 || rungAt === -1 || rungAt < notifyAt)
    return displayOrder;
  const without = displayOrder.filter((kind) => kind !== rung);
  const insertAt = without.indexOf("notify");
  return [...without.slice(0, insertAt), rung, ...without.slice(insertAt)];
}

/**
 * The ladder a display order and an enabled set produce.
 *
 * The one direction that matters: order and enablement are edited separately on
 * screen (drag / arrows vs a per-step switch) and collapse into a single array
 * on the wire, so turning a step off must not also move it.
 */
export function fallbackLadderFrom(
  displayOrder: readonly FallbackRungKind[],
  enabled: ReadonlySet<FallbackRungKind>,
): readonly FallbackRungKind[] {
  return displayOrder.filter((rung) => enabled.has(rung));
}

/**
 * How many movable steps sit above the fixed `notify` slot.
 *
 * Every entry before `notify` in the display order is movable, so its position
 * IS the count. With no `notify` in the order there is no boundary to speak of
 * and every movable index is on the near side, which the movable length
 * expresses without a second branch at the call sites.
 *
 * Exported because the editor needs the same number to decide which arrows can
 * do anything: a button that is drawn active and refused by
 * {@link moveFallbackRung} would be the boundary rule enforced twice and
 * announced never.
 */
export function fallbackMovableBoundary(
  displayOrder: readonly FallbackRungKind[],
): number {
  const notifyAt = displayOrder.indexOf("notify");
  return notifyAt === -1 ? displayOrder.length : notifyAt;
}

/**
 * Move one step within the order, leaving `notify` where it is and refusing to
 * carry anything across it.
 *
 * `notify` has no handle and no arrows (it is the step that always runs last
 * when nothing else worked), so it is not a participant in reordering - but it
 * still OCCUPIES a slot, and the wire format can place it anywhere. Reordering
 * the movable steps around a fixed `notify` slot is what lets the editor render
 * a stored ladder honestly instead of quietly rewriting one whose `notify` is
 * not last. In the ordinary case - every policy this panel writes, and the
 * host's own default - `notify` is last, every movable row is above it, and
 * this is a plain array move.
 *
 * ## The boundary
 *
 * Holding the slot fixed is NOT the same as stopping rows from crossing it, and
 * the difference only shows on an externally authored early `notify`. Hydrate
 * `[profile, notify, tier]`, rendered `[profile, wait, notify, tier]`: the
 * movable list is `[profile, wait, tier]` and the fixed slot sits between its
 * second and third entries. Move `profile` to the end of that list and the rows
 * written back around the slot are `[wait, tier, notify, profile]` - an enabled
 * step that ran a moment ago, now after the step that terminates the walk, from
 * a gesture that said nothing about `notify`. The same splice can do it WITHOUT
 * touching the row it harms: dragging `tier` to the top shifts `wait` down into
 * the slot below the boundary, so clamping the moved row alone would not close
 * it either.
 *
 * So a move whose ends lie on opposite sides of the slot is refused outright,
 * rather than clamped to the boundary. Clamping would answer a drag the user
 * can see with a position they did not choose; refusing leaves the list exactly
 * as it was drawn, which is the same answer the arrows give by being disabled
 * at the boundary. Nothing is rewritten either way - the honest rendering of an
 * externally authored ladder survives, which is the whole reason the slot is
 * fixed instead of normalised to the end.
 *
 * The refusal cannot fire on a ladder this panel wrote: `notify` is last there,
 * so every movable index is on the near side and the boundary test is always
 * satisfied.
 *
 * `fromIndex` and `toIndex` are positions among the MOVABLE steps, not into
 * `displayOrder`, so a caller never has to know where the fixed slot is.
 */
export function moveFallbackRung(
  displayOrder: readonly FallbackRungKind[],
  fromIndex: number,
  toIndex: number,
): readonly FallbackRungKind[] {
  const movable = displayOrder.filter((rung) => rung !== "notify");
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= movable.length ||
    toIndex >= movable.length ||
    fromIndex === toIndex
  ) {
    return displayOrder;
  }
  const boundary = fallbackMovableBoundary(displayOrder);
  if (fromIndex < boundary !== toIndex < boundary) return displayOrder;
  const reordered = [...movable];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  let next = 0;
  return displayOrder.map((rung) =>
    rung === "notify" ? rung : reordered[next++],
  );
}

export type FallbackPolicyValidation =
  | { readonly kind: "valid" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Whether a draft is savable, decided by the WIRE SCHEMA rather than by a
 * hand-written copy of its rules.
 *
 * `fallbackPolicySchema` carries every constraint the host enforces - the
 * ladder's uniqueness refine, the two numeric ranges, the trimmed-non-empty
 * family name, the unique group ids - and re-deriving them here is how the two
 * would drift the first time a bound moves. So the schema decides valid or not
 * and this function only turns the failure into a sentence a person can act on.
 *
 * Validating locally at all (rather than letting the host refuse) is what keeps
 * the draft: a rejected save reverts the control, and reverting someone's
 * half-typed family name because it is half-typed is the behaviour the ticket
 * separates the two failure kinds to prevent.
 */
export function validateFallbackPolicyDraft(
  draft: FallbackPolicy,
): FallbackPolicyValidation {
  const parsed = fallbackPolicySchema.safeParse(draft);
  if (parsed.success) return { kind: "valid" };
  const issue = parsed.error.issues[0];
  return { kind: "invalid", message: draftIssueMessage(issue.path, draft) };
}

/**
 * One sentence per constraint the user can actually violate, NAMING THE ROW it
 * is about.
 *
 * Keyed on the failing path rather than on zod's own message, which names
 * fields and bounds in schema vocabulary ("Fallback rungs must be unique") that
 * this surface deliberately does not use.
 *
 * The row identity is AX8's half. Validation is whole-policy - one blank family
 * name blocks every commit on the page, including the master switch - so the
 * one error line a user gets has to say WHICH of a dozen rows is holding the
 * page, and "A model needs a family name" does not. That is worst for the
 * keyboard: the row is identifiable visually by where the error sits relative
 * to the fields, and not at all by anything read aloud.
 *
 * The path carries the indices, so `draft` is the second argument - the names
 * live in the policy, not in the issue.
 */
function draftIssueMessage(
  path: ReadonlyArray<PropertyKey>,
  draft: FallbackPolicy,
): string {
  const [head, second, third, fourth, fifth] = path;
  if (head === "tierGroups") {
    if (fifth === "modelFamily") {
      return `${candidateSubject(draft, second, fourth)} needs a family name.`;
    }
    if (fifth === "reasoningEffort") {
      return `${candidateSubject(draft, second, fourth)} has a blank effort level - pick one, or leave it unset.`;
    }
    if (third === "id") return `${groupPosition(second)} needs a name.`;
    return groupListIssueMessage(draft);
  }
  if (head === "ladder") return "Each step can be listed only once.";
  if (head === "reasonOverrides") {
    return "Each step can be listed only once for a failure.";
  }
  if (head === "graceWindowSeconds") {
    return "Time to cancel must be a whole number of seconds.";
  }
  if (head === "maxWaitMinutes") {
    return "Longest wait must be a whole number of minutes.";
  }
  // Unreachable through the controls, which cannot produce a value of the
  // wrong TYPE - but a sentence beats rendering a zod issue at a person if a
  // future control finds a way.
  return "That value can't be saved.";
}

/**
 * The row an error is about, as a sentence subject: "Model 2 in “fast”".
 *
 * Position for the row and NAME for the group, which is not an inconsistency:
 * a group has an editable name the user chose and can find on screen, while a
 * candidate row has nothing but its provider and family - and the family is
 * the field that is blank in the case this exists for, so naming the row by it
 * would produce "The model called “” needs a family name".
 *
 * Positions are 1-based, because they are being read by a person counting rows
 * rather than indexing an array.
 */
function candidateSubject(
  draft: FallbackPolicy,
  groupIndex: PropertyKey | undefined,
  candidateIndex: PropertyKey | undefined,
): string {
  const row =
    typeof candidateIndex === "number"
      ? `Model ${candidateIndex + 1}`
      : "A model";
  const group = groupName(draft, groupIndex);
  return group === null ? row : `${row} in ${group}`;
}

/**
 * The group as the copy names it - its own name in quotes, or its POSITION
 * when it has none to print.
 *
 * `null` rather than a sentence fragment when the index is not a number or is
 * off the end of the list, so the caller drops the clause instead of writing
 * "in group NaN". The range test is explicit rather than an `=== undefined`
 * comparison for the reason this file states twice elsewhere:
 * `noUncheckedIndexedAccess` is off, so an index read is typed as the element
 * and that comparison reads as a test between types that cannot overlap.
 */
function groupName(
  draft: FallbackPolicy,
  index: PropertyKey | undefined,
): string | null {
  if (typeof index !== "number") return null;
  if (index < 0 || index >= draft.tierGroups.length) return null;
  const id = draft.tierGroups[index].id.trim();
  return id === "" ? `group ${index + 1}` : `“${id}”`;
}

/**
 * The blank-group-name case, which can only be named by POSITION - the name is
 * the thing that is missing.
 */
function groupPosition(index: PropertyKey | undefined): string {
  return typeof index === "number" ? `Group ${index + 1}` : "A model group";
}

/**
 * A failure the schema reports against the tierGroups ARRAY rather than
 * against one row.
 *
 * The uniqueness refine is the one a user reaches, and it is nameable: the
 * refine carries no index, so the duplicate is found by walking the draft.
 * Trimmed, because the refine runs on the PARSED groups whose ids are already
 * trimmed, so " fast" and "fast" collide there and would not collide in an
 * untrimmed walk here.
 *
 * The generic sentence is not dead code and is not the uniqueness case: this
 * function is the fallthrough for every `tierGroups` path that is not one of
 * the three named rows above, so a failure on a candidate field this copy has
 * no sentence for lands here too.
 */
function groupListIssueMessage(draft: FallbackPolicy): string {
  const seen = new Set<string>();
  for (const group of draft.tierGroups) {
    const id = group.id.trim();
    if (seen.has(id)) return `Two model groups are both called “${id}”.`;
    seen.add(id);
  }
  return "Two model groups have the same name.";
}

export function createFallbackPolicyDraftState(
  policy: FallbackPolicy,
): FallbackPolicyDraftState {
  return {
    persisted: policy,
    draft: policy,
    displayOrder: fallbackDisplayOrder(policy.ladder),
    // Hydration: the stored rows get their identities as they enter the draft,
    // once, here. This is the seeding D174 names - a row loaded from the policy
    // is as much a row as one the user adds, and the two are indistinguishable
    // from then on.
    keyedTierGroups: toKeyedGroups(policy.tierGroups),
    localError: null,
    hostError: null,
    activeField: null,
    revision: 0,
    pendingSaves: [],
    persistedRevision: 0,
    unknownSave: null,
    refusedDraft: null,
    unrefreshedReset: null,
    lastConfirmedRequestId: null,
    confirmedViewRevision: null,
    lastDispatchedRevision: null,
    // A fresh editor has read the row it was built from, so authority starts
    // intact. This is also how the staleness banner's read-again success
    // discharges the obligation: that read remounts the editor, so it arrives
    // here rather than as a transition.
    unverifiedHostRow: null,
    // A fresh editor has adopted nothing: the values it holds came from its
    // seed read, which `confirmedViewRevision` does not claim either. The
    // marker is about a policy installed OVER something else.
    adoptedView: null,
  };
}

/**
 * A save the host confirmed.
 *
 * Extracted beside {@link applySaveFailed} for the same reason: it answers five
 * separate questions - which draft the echo may be written to, whether it
 * outranks the current `persisted`, whether it settles an unknown outcome,
 * what becomes of the notice that outcome owned, and whether the values on
 * screen are now the host's - and inlining them put the reducer back over the
 * complexity ceiling.
 *
 * The last two were added by the audit and are the same idea twice: an
 * obligation is discharged along with everything the page renders on its
 * behalf, and a claim about the display is settled by what is actually
 * displayed rather than by which branch happened to run.
 */
function applySaveSucceeded(
  state: FallbackPolicyDraftState,
  action: { readonly requestId: number; readonly policy: FallbackPolicy },
): FallbackPolicyDraftState {
  const pending = pendingSaveFor(state, action.requestId);
  // A reply to a request this state has already settled - it cannot say which
  // draft it answers, so it says nothing.
  if (pending === null) return state;
  const pendingSaves = withoutPendingSave(state, action.requestId);
  // The host really did store what was sent, and that fact survives even when
  // the echo may not be written to the draft. It is only refused where an even
  // newer reply has already landed, which would make this an older value
  // overwriting a newer `persisted`.
  const outranksPersisted = pending.revision >= state.persistedRevision;
  const persisted = outranksPersisted
    ? { persisted: action.policy, persistedRevision: pending.revision }
    : {
        persisted: state.persisted,
        persistedRevision: state.persistedRevision,
      };
  // A save that SUCCEEDED is the one thing besides a read-back that can settle
  // an unknown outcome - but only if it was dispatched after it. Request ids
  // are minted in dispatch order, so a higher one means the host answered a
  // request that went out later than the unanswered one; whatever it did with
  // the earlier write, the row now holds this value. An EARLIER save
  // succeeding says nothing about a LATER one that went unanswered, so that
  // ticket stands.
  const unknownSave =
    state.unknownSave !== null && action.requestId > state.unknownSave.requestId
      ? null
      : state.unknownSave;
  // Discharging the ticket has to take its AFFORDANCE with it. The notice that
  // ticket owned says "may or may not have been saved" and carries the only
  // Check again on screen; once this success has established the row, the
  // sentence is false and the button answers nothing - it re-reads for a
  // request that is no longer outstanding and returns immediately. A REFUSAL
  // is not dropped with it: `refused-unverified` records a rejection the host
  // actually made, which stays true, and only its uncertainty half expires -
  // so it becomes the ordinary `refused-kept` rather than vanishing.
  const dischargedTicket = state.unknownSave !== null && unknownSave === null;
  const hostErrorAfterDischarge = ((): FallbackSaveNotice | null => {
    if (!dischargedTicket || state.hostError === null) return state.hostError;
    if (state.hostError.outcome === "unknown") return null;
    if (state.hostError.outcome === "refused-unverified") {
      return { message: state.hostError.message, outcome: "refused-kept" };
    }
    return state.hostError;
  })();
  // Request order, exactly as `unknownSave` above: this reply establishes the
  // row, and a LATER reset read-back must not raise a staleness banner over it.
  const lastConfirmedRequestId = outranksPersisted
    ? action.requestId
    : state.lastConfirmedRequestId;
  // NOT computed once for all three returns, because the three leave three
  // DIFFERENT things on screen and confirmation is a property of what is
  // displayed (D339). Two of them put the host's row in the controls - the
  // correcting rollback by adopting it, the ordinary echo by writing it - and
  // both record `state.revision`, the revision those displayed values now sit
  // at. The moved-on return leaves the user's newer draft standing and records
  // nothing: the host holds this reply's policy, the screen does not show it.
  //
  // The sixth pass recorded `pending.revision` here, which is the revision the
  // REQUEST carried. That is the same number only when the display never moved,
  // and it is wrong on exactly the path where adoption changes the values
  // underneath a revision that stays put.
  const confirmedViewRevision = outranksPersisted
    ? state.revision
    : state.confirmedViewRevision;
  // A reset or restore the host CONFIRMED establishes the row - it replaced it
  // with what this reply names - so it discharges the display-authority
  // obligation. It is the only save outcome that does: a confirmed DRAFT save
  // does not, because request ids order dispatch and not the order the host
  // applied things, so a draft that went out after a lost reset can still have
  // been overwritten by it. See `unverifiedHostRow`.
  const unverifiedHostRow =
    pending.carries === "draft" ? state.unverifiedHostRow : null;
  // The echo answers a draft that has since moved on.
  if (pending.revision !== state.revision) {
    // ...unless what is on screen is not a draft the user moved on to, but a
    // value this reducer put there: a rollback it performed when a DIFFERENT
    // save was refused, or a host policy it has already adopted. That refusal
    // reverted to `persisted` and said it was in force; this reply proves
    // `persisted` was stale, so the rollback is showing a value the host does
    // not have. Correct it, and the refusal notice becomes true again rather
    // than being quietly dropped - the save really was refused, and the
    // control really is showing what is stored.
    //
    // The ADOPTED half is why this asks `draftIsNotUserAuthored` rather than
    // `draftIsRefused`. This branch clears `refusedDraft` below, so the FIRST
    // correction left the display unmarked and a second, newer reply fell
    // through to the moved-on arm - advancing `persisted` past a display it
    // had itself installed, while `confirmedViewRevision` went on certifying
    // that display. Marking the adoption keeps the correction available for as
    // long as the display is still not the user's, which is until they edit.
    if (outranksPersisted && draftIsNotUserAuthored(state)) {
      return {
        ...state,
        ...persisted,
        pendingSaves,
        unknownSave,
        unverifiedHostRow,
        lastConfirmedRequestId,
        // The controls below now show the policy the host just confirmed, so
        // the display is confirmed AT its current revision - which is not the
        // revision this request carried, and is the whole reason this is keyed
        // to the view rather than to the request (D339).
        confirmedViewRevision,
        hostError: hostErrorAfterDischarge,
        ...adoptPolicyIntoView(state, action.policy),
        refusedDraft: null,
        // The display is STILL not the user's - it is this reply's policy now
        // instead of the rollback - so the marker moves rather than going out
        // with `refusedDraft`. Without this, one correction disarmed the
        // branch that performed it.
        adoptedView: { revision: state.revision },
        // Cleared HERE and not on the ordinary sibling below, which is the
        // split the walk's "already right" note missed. That note was about the
        // host holding an OLDER draft than the screen - true of the ordinary
        // path, where the draft is the user's newer edit. This path has just
        // called `adoptPolicyIntoView`: the controls now show the confirmed
        // policy itself, so a banner saying they are pre-reset settings the
        // host is not using would be contradicted by the values beside it.
        unrefreshedReset: null,
      };
    }
    // The user edited something while this save was in flight. Leave the
    // draft, its identities and its display order alone, because those
    // describe a NEWER value the user can see. `localError` and `activeField`
    // are untouched for the same reason: they may belong to that later edit.
    // The later edit carries itself to the host through its own commit.
    // `unrefreshedReset` deliberately survives here, unlike the branch above:
    // the host holds THIS reply's policy while the screen holds a newer draft,
    // so the values on display are still not the host's row and the reset's
    // result has still never been read.
    return {
      ...state,
      ...persisted,
      pendingSaves,
      unknownSave,
      unverifiedHostRow,
      lastConfirmedRequestId,
      // Deliberately NOT `confirmedViewRevision`. What is on screen is the
      // user's later edit, which this reply says nothing about; recording
      // confirmation here would tell them their unsent draft is stored.
      hostError: hostErrorAfterDischarge,
    };
  }
  return {
    ...state,
    ...persisted,
    pendingSaves,
    unknownSave,
    unverifiedHostRow,
    draft: action.policy,
    // NOT `fallbackDisplayOrder(action.policy.ladder)`. The echo is the ladder
    // we sent, which cannot carry where the turned-off steps sat, so
    // re-deriving from it moved them - and moved them past the terminal
    // `notify`, where turning one back on produced a step that never runs.
    displayOrder: fallbackDisplayOrderFor(
      state.displayOrder,
      action.policy.ladder,
    ),
    // The host's echo of what was sent, in the ordinary case - the same rows,
    // so the same identities. A restore returns a DIFFERENT list and re-seeds,
    // which is correct: those are not the rows that were there.
    keyedTierGroups: reconcileKeyedGroups(
      state.keyedTierGroups,
      action.policy.tierGroups,
    ),
    localError: null,
    hostError: null,
    activeField: null,
    refusedDraft: null,
    // `adoptedView` is deliberately left alone rather than cleared. This arm
    // is only reachable with a marker standing when the request carried NO
    // draft - a draft save needs an `edited`, which clears it - so what lands
    // here is a reset or restore echo, which is as much a host policy this
    // reducer installed as an adoption is. Clearing it would tell a later
    // authoritative reply that the defaults on screen are the user's own work.
    lastConfirmedRequestId,
    // The echo is written to the controls just above, so the display and the
    // host's row agree at this revision.
    confirmedViewRevision,
    // Cleared here for the reason the correcting branch above shares, stated
    // once: every commit sends the whole policy, so an echo that is written to
    // the screen leaves the host holding exactly what is displayed - the one
    // thing that makes a staleness banner false. Two of this function's three
    // returns do that; the ordinary moved-on one does not, and is the only
    // path out of here that leaves the banner standing. The comment this
    // replaces said "cleared HERE and on no other path", which was true when
    // it was written and stopped being true when R8 fixed the adopting branch.
    unrefreshedReset: null,
  };
}

/**
 * The four things a failed save can mean, and one of two arms of the reducer
 * that live outside its `switch`.
 *
 * Four, from two on the wire: a lost reply, and a refusal that is one of three
 * things depending on what else is outstanding - reverted, kept because the
 * user has moved on, or unverified because an earlier reply is still missing.
 * Extracted because of them: inlined, the reducer exceeded the repo's
 * complexity ceiling, and the arm that most needed reading as a unit was the
 * one buried deepest in the statement.
 */
function applySaveFailed(
  state: FallbackPolicyDraftState,
  action: FallbackSaveFailedAction,
): FallbackPolicyDraftState {
  const pending = pendingSaveFor(state, action.requestId);
  if (pending === null) return state;
  const pendingSaves = withoutPendingSave(state, action.requestId);
  // The host never answered, so nothing may be claimed about what it
  // stored - including the claim that the old value is still in force. The
  // draft stays exactly as it is (it may BE what was committed), and the
  // read-back this records a ticket for is what settles it.
  if (action.outcome === "unknown") {
    return {
      ...state,
      pendingSaves,
      // Cleared only when this failure is ABOUT the draft on screen. A request
      // that carried an older revision has judged nothing the user can see, and
      // the validation error belonging to what they typed since is not its to
      // erase - the same rule `refusedDraft` follows one branch down, and
      // the same rule the moved-on success path already follows for exactly
      // this field. Wiping it left an invalid draft on screen with no error
      // beside it, and the control looking accepted.
      localError: judgedTheDisplay(pending, state) ? null : state.localError,
      hostError: { message: action.message, outcome: "unknown" },
      activeField: action.field,
      unknownSave: {
        requestId: action.requestId,
        revision: pending.revision,
        carries: pending.carries,
      },
      // The obligation, raised here and discharged only by evidence about the
      // row. A draft save leaves it alone in BOTH directions: it cannot raise
      // one (a save carries what is on screen, so its uncertainty is about the
      // display and is reported as such), and it must not lower one, which is
      // the defect this field was extracted to fix.
      unverifiedHostRow:
        pending.carries === "draft" ? state.unverifiedHostRow : pending.carries,
    };
  }
  // A refusal cannot revert while ANOTHER save's outcome is still unknown.
  //
  // Reverting means "put back what is stored and say it is in force", and the
  // outstanding ticket is precisely the statement that we do not know what is
  // stored: `persisted` may already have been overwritten by the save whose
  // reply was lost. Refusing B tells us about B and nothing about A. So the
  // draft stands, and the notice becomes `refused-unverified` - which records
  // BOTH facts, and keeps "Check again" on screen, the only way left to find
  // out. Dropping to `refused-reverted` here would replace a true statement
  // about the host with a false one AND remove the control that could correct
  // it.
  //
  // It is `refused-unverified` rather than the `unknown` this used to keep,
  // and the field note below says why the distinction has to exist. "Another"
  // rather than "an earlier" throughout: this branch does not compare request
  // ids, so the unanswered save can perfectly well be the NEWER one - start A,
  // start B, B's reply is lost, then A is refused.
  //
  // The refusal is still reported: its message is the host's own reason, and
  // it displaces the earlier one because it is the newer thing that happened.
  if (state.unknownSave !== null) {
    return {
      ...state,
      pendingSaves,
      localError: judgedTheDisplay(pending, state) ? null : state.localError,
      // `refused-unverified`, not `unknown`, which this used to borrow. Both
      // mean a ticket is outstanding, so both keep the read-back and its
      // button; only this one also carries a refusal the host really made. The
      // difference matters at exactly one moment - when a later success
      // discharges the ticket - because the uncertainty expires there and the
      // refusal does not.
      hostError: { message: action.message, outcome: "refused-unverified" },
      activeField: action.field,
      // The value on screen is one the host has REFUSED, even though the notice
      // it wears is the earlier save's uncertainty. Recorded here and not
      // inferred from that notice, which is the distinction the first version
      // of this collapsed.
      //
      // Guarded on the request having actually CARRIED what is on screen. This
      // branch runs BEFORE the `pending.revision !== state.revision` check
      // below, so it is the one refusal arm that can be reached by a request
      // answering an older draft - and the second version of this wrote
      // `state.revision` flatly, marking a draft the host never judged. Typing
      // moves the revision without sending anything (`editDraft`), so "A goes
      // unknown, B starts, the user types C, B is refused" marked C: the
      // read-back for A then saw a refused draft, adopted the host's row over
      // it, and took C out of the field the user was still in.
      //
      // Preserved rather than overwritten with `pending.revision` when they
      // differ: an existing marker describes the draft that is STILL on screen,
      // and this refusal - which is about some older draft - is no evidence
      // against it. `edited` is what clears it, because typing is the thing
      // that makes it untrue.
      // KEPT, not restored: this branch changes no values. The refused draft is
      // still in the controls, and the display's account has to say that rather
      // than "put back", which describes the other arm.
      refusedDraft: judgedTheDisplay(pending, state)
        ? { revision: state.revision, restoredPersisted: false }
        : state.refusedDraft,
    };
  }
  // The host answered and refused a request that did NOT judge what is on
  // screen - an older draft, or an operation that carried no draft at all.
  // The refusal is real and is reported; the revert is not applied, because it
  // would throw away an edit the host never judged, and that edit carries
  // itself to the host through its own commit.
  //
  // The carries half is the tenth pass's correction. Without it this arm is
  // skipped by a refused RESET: a reset dispatched while an unsent draft is on
  // screen carries THAT draft's revision, since it moves no revision of its
  // own - so the revision test passed and the reducer reverted an edit the
  // reset never sent anywhere.
  if (!judgedTheDisplay(pending, state)) {
    return {
      ...state,
      pendingSaves,
      hostError: { message: action.message, outcome: "refused-kept" },
      activeField: action.field,
    };
  }
  // The revert is the whole point: the host refused this value, so leaving
  // it on screen would show a setting that is not in force. The draft is
  // recoverable from the message, which names what was refused.
  return {
    ...state,
    pendingSaves,
    draft: state.persisted,
    // Same rule as the echo: a revert restores the persisted VALUES, and
    // the order on screen already agrees with them wherever it can, so
    // re-deriving would move the disabled rows for a refusal that said
    // nothing about the order.
    displayOrder: fallbackDisplayOrderFor(
      state.displayOrder,
      state.persisted.ladder,
    ),
    // The rows revert with the draft KEEPING THEIR IDENTITIES wherever the
    // shape is unchanged - see `revertKeyedGroups`. A rejected value edit
    // must not remount the field the user is still typing in.
    keyedTierGroups: revertKeyedGroups(
      state.keyedTierGroups,
      state.persisted.tierGroups,
    ),
    localError: null,
    hostError: { message: action.message, outcome: "refused-reverted" },
    activeField: action.field,
    // The rollback is this reducer's value, not the user's - and it is the ONE
    // arm that restored `persisted`, which is what earns the "put back" account.
    refusedDraft: { revision: state.revision, restoredPersisted: true },
  };
}

/**
 * Whether what the controls are showing is a REFUSAL ROLLBACK rather than
 * anything the user typed.
 *
 * Keyed on a recorded REVISION, not on the notice's text. An earlier version
 * read `hostError.outcome === "refused-reverted"` and was wrong for the arm
 * this same fix added: a refusal arriving while an earlier save's outcome is
 * unknown deliberately keeps the `unknown` notice, so a genuinely refused draft
 * answered NO. The marker is written by BOTH refusal arms that can leave a
 * judged value on screen - the revert, and that outstanding-ticket branch -
 * each only when the refused request carried the revision being marked, and it
 * is cleared by every path that replaces what is on screen: `edited` (the user
 * typed), `save-succeeded` on a matching revision, and `reconciled`'s adopt.
 * So this is true precisely while the visible draft is a value this reducer put
 * back or the host refused, with no user edit since.
 *
 * Exported for the staleness banner, which needs the same distinction for a
 * different reason: it names what is on screen only when what is on screen is
 * the user's own live edit. A rollback is neither that nor the pre-reset
 * policy, and under D327 the banner says nothing about provenance there - the
 * save notice under the control already owns that sentence.
 *
 * The distinction matters because `revision` alone cannot make it: a revert
 * does not move the revision, so after "edit to B, B refused, roll back" the
 * revision still names B's edit while the screen shows the pre-B policy. Every
 * later arm that asks "has the user moved on since?" would read that as yes and
 * refuse to touch a draft the user did not author - which is how a confirmed
 * value ended up unable to correct a rollback it had just proved wrong.
 */
export function draftIsRefused(state: FallbackPolicyDraftState): boolean {
  return refusedDraftOnScreen(state) !== null;
}

/**
 * The refusal record IF it describes what the controls are showing right now.
 *
 * The tenth pass's split, and the reason this returns the record rather than a
 * boolean: `draftIsRefused` answers "is this a value the user did not author",
 * which both refusal arms satisfy, and the display's SENTENCE needs the other
 * half - whether the reducer put `persisted` back, or left the refused value
 * standing because another outcome was unknown. Those are different screens and
 * were being given the same account.
 */
export function refusedDraftOnScreen(
  state: FallbackPolicyDraftState,
): FallbackRefusedDraft | null {
  if (state.refusedDraft === null) return null;
  return state.refusedDraft.revision === state.revision
    ? state.refusedDraft
    : null;
}

/**
 * The adoption record IF it describes what the controls are showing right now.
 *
 * The same shape as {@link refusedDraftOnScreen} and for the same reason: a
 * marker is about a revision, and an `edited` moves the revision, so "still on
 * screen" is a comparison rather than a flag. Returns the record rather than a
 * boolean so a later consumer that needs the revision does not have to read
 * the field it came from.
 */
export function adoptedViewOnScreen(
  state: FallbackPolicyDraftState,
): FallbackAdoptedView | null {
  if (state.adoptedView === null) return null;
  return state.adoptedView.revision === state.revision
    ? state.adoptedView
    : null;
}

/**
 * Whether the controls are showing something the USER DID NOT AUTHOR.
 *
 * The question every arm that installs an authoritative policy over the
 * display actually asks, and the reason it is one function rather than a
 * condition spelled out per branch. There are two ways to satisfy it - a
 * refusal this reducer rolled back or left standing, and a host policy this
 * reducer adopted - and while only ONE of them existed the two consumers
 * looked identical; the moment the second arrived, a site that had not been
 * updated would silently keep answering the narrower question.
 *
 * That is not hypothetical for either consumer:
 *
 *  - {@link applySaveSucceeded}'s correcting branch clears the refusal marker
 *    when it adopts, so a SECOND newer reply saw an unmarked display and
 *    advanced `persisted` past controls it had itself installed (the OSS
 *    review's first P2);
 *  - `reconciled`'s adopt gate is reachable with an ADOPTED display and no
 *    refusal: a save's reply is lost at revision 2, an edit moves to revision
 *    3, a later save is refused there, an OLDER save then succeeds and takes
 *    the correcting branch - which adopts and clears `refusedDraft` while the
 *    revision-2 ticket is still outstanding, because its own request id is
 *    lower than the unanswered one. The read-back that follows finds revision
 *    3 ≠ revision 2 and no refusal, so the narrower predicate sends it to the
 *    moved-on arm, which stamps `persistedRevision` over an adopted display
 *    and leaves `confirmedViewRevision` certifying values the host does not
 *    hold.
 */
export function draftIsNotUserAuthored(
  state: FallbackPolicyDraftState,
): boolean {
  return (
    refusedDraftOnScreen(state) !== null || adoptedViewOnScreen(state) !== null
  );
}

/**
 * The three view fields that follow an authoritative policy onto the screen.
 *
 * `revertKeyedGroups` and not `reconcileKeyedGroups`: this installs a list the
 * editor did not send (a read-back, or a correction to a rollback), which is
 * the same situation the revert arm is in - keep identities where the shape
 * still matches, re-seed where it does not.
 */
function adoptPolicyIntoView(
  state: FallbackPolicyDraftState,
  policy: FallbackPolicy,
): Pick<
  FallbackPolicyDraftState,
  "draft" | "displayOrder" | "keyedTierGroups"
> {
  return {
    draft: policy,
    displayOrder: fallbackDisplayOrderFor(state.displayOrder, policy.ladder),
    keyedTierGroups: revertKeyedGroups(
      state.keyedTierGroups,
      policy.tierGroups,
    ),
  };
}

/**
 * Whether a settled request actually JUDGED what the controls are showing.
 *
 * TWO conditions, and the second was missing until D353 exposed it. The request
 * must be about the draft on screen - `pending.revision === state.revision` -
 * AND it must have CARRIED that draft. A `reset` satisfies the first for free:
 * it sends no draft, so it moves no revision, so its pending revision is
 * whatever the user happens to be looking at.
 *
 * The rule is the one the whole surface now follows: a claim about the DISPLAY
 * needs a request that carried the display. This is that rule as a predicate,
 * and EVERY consequence a failure visits on the display is gated by it - four
 * call sites in `applySaveFailed`, all of them things the user can see:
 *
 *  - the VALIDATION ERROR, cleared only by a request that judged the draft it
 *    belongs to (D353). A reset with an invalid edit on screen erased that
 *    edit's error while leaving the invalid value in the field;
 *  - the refusal MARKER, which decides whether the display is described as a
 *    value the host turned down. A refused reset marked an unsent draft it
 *    never carried, and the read-back that followed then took
 *    `applyReconciled`'s ADOPTING arm - because `draftIsRefused` was true -
 *    and replaced the user's edit and its error with the host's row;
 *  - the REVERT itself, which is the same defect with nothing to trigger it: a
 *    refused reset dispatched over an unsent draft reverted that draft on the
 *    spot, no lost reply and no read-back required.
 *
 * The marker and the revert were found together, and they are why this is one
 * predicate rather than a condition repeated per branch: the arms had drifted,
 * and only one of them carried the `carries` term.
 */
function judgedTheDisplay(
  pending: PendingFallbackSave,
  state: FallbackPolicyDraftState,
): boolean {
  return pending.carries === "draft" && pending.revision === state.revision;
}

/** The pending entry a reply names, or `null` if it has already been settled. */
function pendingSaveFor(
  state: FallbackPolicyDraftState,
  requestId: number,
): PendingFallbackSave | null {
  return (
    state.pendingSaves.find((pending) => pending.requestId === requestId) ??
    null
  );
}

function withoutPendingSave(
  state: FallbackPolicyDraftState,
  requestId: number,
): readonly PendingFallbackSave[] {
  return state.pendingSaves.filter(
    (pending) => pending.requestId !== requestId,
  );
}

/**
 * The `edited` arm. Extracted for the same reason as {@link applySaveSucceeded}:
 * the reducer's own complexity ceiling, which this pass pushed over again by
 * giving `save-started` a second thing to decide.
 */
function applyEdited(
  state: FallbackPolicyDraftState,
  action: {
    readonly policy: FallbackPolicy;
    readonly field: FallbackPolicyField;
    readonly keyedTierGroups: readonly KeyedGroup[] | null;
  },
): FallbackPolicyDraftState {
  const validation = validateFallbackPolicyDraft(action.policy);
  // Taken from the action, never recomputed: an INVALID draft is kept on
  // screen, and a half-typed family name must not cost the row the identity
  // it is being typed into.
  const keyedTierGroups = action.keyedTierGroups ?? state.keyedTierGroups;
  // Every edit moves the revision, valid or not. An INVALID edit is still an
  // edit the user made and can still see, so an in-flight save's echo must
  // not overwrite it either.
  const revision = state.revision + 1;
  // A new edit always clears the previous rejection: that message named a
  // value that is no longer on screen.
  if (validation.kind === "invalid") {
    return {
      ...state,
      draft: action.policy,
      keyedTierGroups,
      revision,
      hostError: null,
      localError: validation.message,
      activeField: action.field,
      // The user has typed: whatever was refused is no longer what is on
      // screen, so the refusal no longer describes it.
      refusedDraft: null,
      // Same event, the other marker: an adopted policy the user has now
      // typed over is their draft, and this is the ONE thing that clears it.
      // It is what keeps a real intervening edit safe from a later reply.
      adoptedView: null,
    };
  }
  return {
    ...state,
    draft: action.policy,
    keyedTierGroups,
    revision,
    hostError: null,
    localError: null,
    activeField: action.field,
    refusedDraft: null,
    adoptedView: null,
  };
}

/** The `save-started` arm. See {@link applyEdited} for why it is out of line. */
function applySaveStarted(
  state: FallbackPolicyDraftState,
  action: {
    readonly field: FallbackPolicyField;
    readonly requestId: number;
    readonly carries: FallbackSaveCarries;
  },
): FallbackPolicyDraftState {
  return {
    ...state,
    hostError: null,
    activeField: action.field,
    // The commit path dispatches `edited` immediately before this, so the
    // revision read here is the one the request carries. `restore` and
    // `reset` have no `edited` before them and capture the unchanged
    // revision, which is correct: they send no draft.
    pendingSaves: [
      ...state.pendingSaves,
      {
        requestId: action.requestId,
        revision: state.revision,
        carries: action.carries,
      },
    ],
    // The high-water mark of DISPATCHED drafts, and only drafts - a reset
    // sends defaults the display never held, so counting it here would let
    // the page say those displayed values "were sent" (D339).
    //
    // `Math.max` rather than a plain assignment: revisions only increase,
    // so the two are equivalent today, and the max is what keeps this true
    // if some later path ever puts a lower revision on screen.
    lastDispatchedRevision:
      action.carries === "draft"
        ? Math.max(
            state.lastDispatchedRevision ?? state.revision,
            state.revision,
          )
        : state.lastDispatchedRevision,
    // `unknownSave` is deliberately NOT cleared here. It used to be, on the
    // reasoning that a newer request's answer is a fresher fact about the
    // host's row - which is true only of an answer that SUCCEEDS. Starting
    // a request is not an answer at all, and a refusal is an answer about
    // THIS request only: "B was not written" says nothing about whether A
    // was. Tearing up A's ticket at B's start meant B's refusal then
    // restored the pre-A policy and called it "still in force", while A's
    // read-back - the only thing that could have contradicted that - was
    // dropped for naming a superseded episode. The user turns automatic
    // fallback on, and the page ends up insisting it is off while the host
    // has it on: the exact claim the unknown outcome exists to refuse.
    //
    // The ticket is discharged where the evidence actually arrives: a
    // `reconciled` that names it, or a LATER save that succeeds (see
    // `save-succeeded`), because that one really does establish the row.
  };
}

/** The `reset-unrefreshed` arm. See {@link applyEdited}. */
function applyResetUnrefreshed(
  state: FallbackPolicyDraftState,
  action: { readonly requestId: number; readonly message: string },
): FallbackPolicyDraftState {
  const pending = pendingSaveFor(state, action.requestId);
  if (pending === null) return state;
  // A write dispatched AFTER this reset has since been confirmed, so the
  // row on the host is that write's, not the reset's, and it is not
  // unread - the echo established it. Raising the banner here would say
  // the display is stale about a value that was just confirmed into it.
  //
  // Reachable straight from the panel: the reset's read-back is a round
  // trip, only Reset and Restore are disabled while it runs, and every
  // ordinary control stays live. The reset is still SETTLED either way -
  // what is dropped is the staleness claim, not the request.
  const supersededByLaterWrite =
    state.lastConfirmedRequestId !== null &&
    state.lastConfirmedRequestId > action.requestId;
  return {
    ...state,
    // Settled: the reset itself is not in flight and not in doubt. Leaving
    // it pending would print "Saving…" under the danger zone forever, for a
    // request the host has already answered.
    pendingSaves: withoutPendingSave(state, action.requestId),
    unrefreshedReset: supersededByLaterWrite
      ? state.unrefreshedReset
      : {
          message: action.message,
          // `pending.revision`, NOT `state.revision`. See
          // `FallbackUnrefreshedReset.revision`: this dates the banner's
          // "settings from before the reset" claim to the reset's dispatch,
          // so an edit submitted while the read was in flight is not
          // mistaken for the pre-reset policy.
          revision: pending.revision,
          requestId: action.requestId,
        },
    // `hostError` and `activeField` are deliberately untouched. This is not
    // a save outcome and does not belong in the panel's one status line -
    // it belongs above the whole editor - and overwriting them here would
    // erase a refusal that is still the last thing that happened to a save.
    //
    // Nor `refusedDraft`: nothing was refused. The values on screen are
    // stale, which the banner says, and the fix is a successful READ rather
    // than adopting anything into this editor - the panel remounts it.
    //
    // `unknownSave` is discharged only when this reset was dispatched AFTER
    // the unanswered save, which is the same request-order test a success
    // uses. A confirmed reset VOIDS the question "did my earlier save
    // land?" - it replaced the row wholesale, whatever that save did - but
    // it is no evidence at all about a write that went out LATER and may
    // have replaced the row again. Clearing that ticket unconditionally
    // voided an obligation this reset cannot speak to, and left the
    // uncertainty notice on screen with nothing behind its retry.
    unknownSave:
      state.unknownSave !== null &&
      action.requestId > state.unknownSave.requestId
        ? null
        : state.unknownSave,
  };
}

/** The `reconciled` arm. See {@link applyEdited}. */
function applyReconciled(
  state: FallbackPolicyDraftState,
  action: { readonly requestId: number; readonly policy: FallbackPolicy },
): FallbackPolicyDraftState {
  // Not the read-back this state is waiting for - a superseded episode's
  // answer, or one that raced a newer save's `save-started`.
  if (
    state.unknownSave === null ||
    state.unknownSave.requestId !== action.requestId
  ) {
    return state;
  }
  // The host's own row, which outranks anything this editor believed about
  // it. `persistedRevision` follows the current revision because a
  // read-back is the freshest fact available, not an echo to be ordered.
  const reconciled = {
    persisted: action.policy,
    persistedRevision: state.revision,
    unknownSave: null,
    // A successful read discharges the unrefreshed-reset banner on BOTH
    // paths below, whatever the draft is doing. The banner's own words are
    // "the reset went through and we couldn't load what's on the host", and
    // this IS that load: leaving it up would keep a sentence on screen that
    // has just become false. Reachable in one order only - reset, failed
    // read, a NEW save goes unknown, its read-back succeeds - and the
    // alternative reading (keep warning that the rest of the draft predates
    // the reset) is ordinary unsaved-edit territory this panel does not
    // warn about anywhere else.
    unrefreshedReset: null,
    // A successful read IS the confirming evidence the obligation waits for -
    // it is the row, straight from the host. Cleared on BOTH arms below,
    // because what the read establishes is the host's row, and that is true
    // whether or not the user has typed something newer since.
    unverifiedHostRow: null,
  };
  // The user has typed since the save went unanswered. Their draft stands -
  // the standing rule that a read never yanks a control out from under
  // someone mid-edit applies here too - and the notice is cleared because
  // the panel is no longer making an unverified claim: `persisted` is now
  // authoritative, and their next commit settles the rest.
  //
  // `draftIsNotUserAuthored` is the exception, and without it this arm is
  // where the read-back's answer goes to die. A later save can be REFUSED
  // while this read is in flight, and neither of the two things that follow
  // moves the revision: a rollback puts the then-`persisted` value on screen,
  // and a refusal that keeps the draft (because this very ticket is
  // outstanding) leaves the refused value on screen. Either way the revision
  // check above reads "the user has moved on" about a screen the user did not
  // author, and the read-back would then update `persisted` and clear the
  // notice while leaving that display standing - no notice, and a control
  // contradicting the row this very read just returned.
  //
  // The ADOPTED case is the same defect one door over and is reachable
  // independently - see {@link draftIsNotUserAuthored} for the sequence. Both
  // sites ask through that one predicate so they cannot answer differently.
  if (
    state.revision !== state.unknownSave.revision &&
    !draftIsNotUserAuthored(state)
  ) {
    // No `confirmedViewRevision` here, and that is the distinction D330's
    // reducer pin holds: `persistedRevision` IS stamped just above, over a
    // draft the user is still typing and this editor never dispatched.
    // Reading that stamp as agreement would call an unsent edit stored;
    // the display's own account comes from `lastDispatchedRevision`, which
    // proves it unsent rather than inferring it (D339).
    return { ...state, ...reconciled, hostError: null };
  }
  return {
    ...state,
    ...reconciled,
    ...adoptPolicyIntoView(state, action.policy),
    localError: null,
    hostError: null,
    refusedDraft: null,
    // This arm puts the read-back's own policy in the controls, so the
    // display now equals the host's row - confirmation recorded against
    // the revision those values are displayed at, not against the request
    // that went unanswered (D339). Without this, a read-back that answers
    // the display is followed by a LATER save going unknown, and the page
    // tells the user the confirmed values on screen were never sent.
    confirmedViewRevision: state.revision,
  };
}

export function fallbackPolicyDraftReducer(
  state: FallbackPolicyDraftState,
  action: FallbackPolicyDraftAction,
): FallbackPolicyDraftState {
  // No `hydrated` action, deliberately. The editor is seeded from the first
  // read and keyed on the scoped host id, the agents editor's precedent: a
  // later refetch that pushed itself into these controls would yank a value
  // out from under someone mid-edit, and the two facts that DO change per read
  // - the in-flight count and the unreadable-row flag - are not edited here,
  // so the panel reads them straight off the query instead.
  switch (action.type) {
    case "edited":
      return applyEdited(state, action);
    case "reordered":
      return { ...state, displayOrder: action.displayOrder };
    case "save-started":
      return applySaveStarted(state, action);
    case "save-succeeded":
      return applySaveSucceeded(state, action);
    case "save-failed":
      return applySaveFailed(state, action);
    case "reset-unrefreshed":
      return applyResetUnrefreshed(state, action);
    case "reconciled":
      return applyReconciled(state, action);
  }
}
