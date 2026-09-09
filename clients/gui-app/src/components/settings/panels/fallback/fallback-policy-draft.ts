import {
  FALLBACK_RUNG_KINDS,
  fallbackPolicySchema,
  type FallbackPolicy,
  type FallbackRungKind,
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
 * two failure kinds are decided once rather than per group:
 *
 *  - a **local validation failure** (blank family name, duplicate step,
 *    out-of-range bound) keeps the draft in the control, shows the error, and
 *    **persists nothing**;
 *  - a **host rejection** of a committed save reverts the control to the last
 *    persisted value and shows the host's reason.
 *
 * After either, both the visible value and the persisted value are recoverable
 * from this state, which is what lets the panel say what is on screen AND what
 * is saved rather than leaving the user to guess which they are looking at.
 */
export interface FallbackPolicyDraftState {
  /** The last policy the host confirmed. What a host rejection reverts to. */
  readonly persisted: FallbackPolicy;
  /** What the controls render. Diverges from `persisted` only while invalid. */
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
  /** Set by a local validation failure. Nothing was sent. */
  readonly localError: string | null;
  /** Set by a save that did not succeed. See {@link FallbackSaveNotice}. */
  readonly hostError: FallbackSaveNotice | null;
  /**
   * The group the most recent edit came from - where this panel's one status
   * line renders, whether that line is an error or "Saving…".
   *
   * Deliberately not an `errorField`. Only one save is ever in flight, and
   * scoping the error but not the spinner would put the two halves of one
   * outcome in different places; scoping neither would print "Saving…" under
   * all five groups at once.
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
   */
  readonly unknownSave: UnknownFallbackSave | null;
}

/** One dispatched, unanswered save. */
export interface PendingFallbackSave {
  readonly requestId: number;
  /** The revision the request carries - captured at `save-started`, because by
   * reply time the only observable revision is the current one, which is
   * exactly the fact under question. */
  readonly revision: number;
}

export interface UnknownFallbackSave {
  readonly requestId: number;
  /** The revision at the moment the outcome became unknown. The read-back may
   * adopt the host's policy into `draft` only while this is still current. */
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
 */
export type FallbackSaveNoticeOutcome =
  | "refused-reverted"
  | "refused-kept"
  | "unknown";

export interface FallbackSaveNotice {
  readonly message: string;
  readonly outcome: FallbackSaveNoticeOutcome;
}

/**
 * What the CLASSIFIER at the call site decided, before the reducer knows
 * whether a revert applies. Kept separate from
 * {@link FallbackSaveNoticeOutcome} so neither can be passed where the other
 * belongs: only the reducer can tell `refused-reverted` from `refused-kept`,
 * and only the caller can tell `refused` from `unknown`.
 */
export type FallbackSaveFailureOutcome = "refused" | "unknown";

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
 * one with three outcomes, so it lives in {@link applySaveFailed} instead of in
 * the reducer's `switch`.
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
   * gated twice for that reason: it must name the request that went unanswered
   * (`requestId`), and it may replace what is on screen only while the user has
   * not edited since. The reducer's standing rule - a later read never yanks a
   * control out from under someone mid-edit - is intact; this is the one state
   * where NOT reading back means leaving a false claim on the page.
   */
  | {
      readonly type: "reconciled";
      readonly requestId: number;
      readonly policy: FallbackPolicy;
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
 * Move one step within the order, leaving `notify` where it is.
 *
 * `notify` has no handle and no arrows (it is the step that always runs last
 * when nothing else worked), so it is not a participant in reordering - but it
 * still OCCUPIES a slot, and the wire format can place it anywhere. Reordering
 * the movable steps around a fixed `notify` slot is what lets the editor render
 * a stored ladder honestly instead of quietly rewriting one whose `notify` is
 * not last. In the ordinary case - every policy this panel writes, and the
 * host's own default - `notify` is last and this is a plain array move.
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
  return { kind: "invalid", message: draftIssueMessage(issue.path) };
}

/**
 * One sentence per constraint the user can actually violate.
 *
 * Keyed on the failing path rather than on zod's own message, which names
 * fields and bounds in schema vocabulary ("Fallback rungs must be unique") that
 * this surface deliberately does not use.
 */
function draftIssueMessage(path: ReadonlyArray<PropertyKey>): string {
  const [head, , third, , fifth] = path;
  if (head === "tierGroups") {
    if (fifth === "modelFamily") return "A model needs a family name.";
    if (fifth === "reasoningEffort") {
      return "An effort level can't be blank - pick one or leave it unset.";
    }
    if (third === "id") return "A model group needs a name.";
    return "Two model groups have the same name.";
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
  };
}

/**
 * The three things a failed save can mean, and the only arm of the reducer that
 * lives outside its `switch`.
 *
 * Extracted because it carries three outcomes of its own: inlined, the reducer
 * exceeded the repo's complexity ceiling, and the arm that most needed reading
 * as a unit was the one buried deepest in the statement.
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
      localError: null,
      hostError: { message: action.message, outcome: "unknown" },
      activeField: action.field,
      unknownSave: {
        requestId: action.requestId,
        revision: pending.revision,
      },
    };
  }
  // The host answered and refused an OLDER draft than the one on screen.
  // The refusal is real and is reported; the revert is not applied, because
  // it would throw away an edit the host never judged - and that edit will
  // carry itself to the host through its own commit.
  if (pending.revision !== state.revision) {
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
  };
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
    case "edited": {
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
      };
    }
    case "reordered":
      return { ...state, displayOrder: action.displayOrder };
    case "save-started":
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
          { requestId: action.requestId, revision: state.revision },
        ],
        // A new save supersedes an unresolved one: whatever this request
        // answers is a fresher fact about the host's row than a read-back of
        // the previous attempt could be, so the read-back's ticket is torn up
        // and a `reconciled` naming it is dropped.
        unknownSave: null,
      };
    case "save-succeeded": {
      const pending = pendingSaveFor(state, action.requestId);
      // A reply to a request this state has already settled - it cannot say
      // which draft it answers, so it says nothing.
      if (pending === null) return state;
      const pendingSaves = withoutPendingSave(state, action.requestId);
      // The host really did store what was sent, and that fact survives even
      // when the echo may not be written to the draft. It is only refused where
      // an even newer reply has already landed, which would make this an older
      // value overwriting a newer `persisted`.
      const persisted =
        pending.revision >= state.persistedRevision
          ? { persisted: action.policy, persistedRevision: pending.revision }
          : {
              persisted: state.persisted,
              persistedRevision: state.persistedRevision,
            };
      // The echo answers a draft that has since moved on: the user edited
      // something while this save was in flight. Leave the draft, its
      // identities and its display order alone, because those describe a NEWER
      // value the user can see. `localError` and `activeField` are untouched
      // for the same reason: they may belong to that later edit. The later edit
      // carries itself to the host through its own commit.
      if (pending.revision !== state.revision) {
        return { ...state, ...persisted, pendingSaves };
      }
      return {
        ...state,
        ...persisted,
        pendingSaves,
        draft: action.policy,
        // NOT `fallbackDisplayOrder(action.policy.ladder)`. The echo is the
        // ladder we sent, which cannot carry where the turned-off steps sat,
        // so re-deriving from it moved them - and moved them past the terminal
        // `notify`, where turning one back on produced a step that never runs.
        displayOrder: fallbackDisplayOrderFor(
          state.displayOrder,
          action.policy.ladder,
        ),
        // The host's echo of what was sent, in the ordinary case - the same
        // rows, so the same identities. A restore returns a DIFFERENT list and
        // re-seeds, which is correct: those are not the rows that were there.
        keyedTierGroups: reconcileKeyedGroups(
          state.keyedTierGroups,
          action.policy.tierGroups,
        ),
        localError: null,
        hostError: null,
        activeField: null,
      };
    }
    case "save-failed":
      return applySaveFailed(state, action);
    case "reconciled": {
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
      };
      // The user has typed since the save went unanswered. Their draft stands -
      // the standing rule that a read never yanks a control out from under
      // someone mid-edit applies here too - and the notice is cleared because
      // the panel is no longer making an unverified claim: `persisted` is now
      // authoritative, and their next commit settles the rest.
      if (state.revision !== state.unknownSave.revision) {
        return { ...state, ...reconciled, hostError: null };
      }
      return {
        ...state,
        ...reconciled,
        draft: action.policy,
        displayOrder: fallbackDisplayOrderFor(
          state.displayOrder,
          action.policy.ladder,
        ),
        keyedTierGroups: revertKeyedGroups(
          state.keyedTierGroups,
          action.policy.tierGroups,
        ),
        localError: null,
        hostError: null,
      };
    }
  }
}
