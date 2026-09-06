import {
  FALLBACK_RUNG_KINDS,
  fallbackPolicySchema,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import {
  reconcileKeyedGroups,
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
  /** Set by a rejected save. `draft` has been returned to `persisted`. */
  readonly hostError: string | null;
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
  readonly saveInFlight: boolean;
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
   * The revision the in-flight save is carrying, or `null` when none is.
   *
   * Captured at `save-started` rather than derived at `save-succeeded`, because
   * by then the only thing that can be observed is the CURRENT revision, which
   * is exactly the fact under question.
   */
  readonly savingRevision: number | null;
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
  | { readonly type: "save-started"; readonly field: FallbackPolicyField }
  | { readonly type: "save-succeeded"; readonly policy: FallbackPolicy }
  | {
      readonly type: "save-failed";
      readonly message: string;
      readonly field: FallbackPolicyField;
    };

/**
 * The editor's row order for a stored policy.
 *
 * Enabled steps first, in the order the ladder stores them, then the steps that
 * are turned off in the canonical order. That second half is the reload
 * behaviour {@link FallbackPolicyDraftState.displayOrder} documents: a disabled
 * step has no stored position to restore, so it goes to the end.
 */
export function fallbackDisplayOrder(
  ladder: readonly FallbackRungKind[],
): readonly FallbackRungKind[] {
  // No de-duplication or membership filter on `ladder`: it arrives parsed
  // through `fallbackPolicySchema`, whose refine already rejects a repeated
  // step, so a guard here would be a branch no input can reach.
  const disabled = FALLBACK_RUNG_KINDS.filter((rung) => !ladder.includes(rung));
  return [...ladder, ...disabled];
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
    saveInFlight: false,
    revision: 0,
    savingRevision: null,
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
        saveInFlight: true,
        hostError: null,
        activeField: action.field,
        // The commit path dispatches `edited` immediately before this, so the
        // revision read here is the one the request carries. `restore` and
        // `reset` have no `edited` before them and capture the unchanged
        // revision, which is correct: they send no draft.
        savingRevision: state.revision,
      };
    case "save-succeeded":
      // The echo answers a draft that has since moved on: the user edited
      // something while this save was in flight. Record that the host stored
      // what was sent - it did - but leave the draft, its identities and its
      // display order alone, because those describe a NEWER value the user can
      // see. `localError` and `activeField` are untouched for the same reason:
      // they may belong to that later edit. The later edit carries itself to the
      // host through its own commit.
      if (
        state.savingRevision !== null &&
        state.savingRevision !== state.revision
      ) {
        return {
          ...state,
          persisted: action.policy,
          saveInFlight: false,
          savingRevision: null,
        };
      }
      return {
        ...state,
        persisted: action.policy,
        draft: action.policy,
        displayOrder: fallbackDisplayOrder(action.policy.ladder),
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
        saveInFlight: false,
        savingRevision: null,
      };
    case "save-failed":
      // The revert is the whole point: the host refused this value, so leaving
      // it on screen would show a setting that is not in force. The draft is
      // recoverable from the message, which names what was refused.
      //
      // No revision check here, unlike `save-succeeded`. The two cases are not
      // symmetric: a success has a value to write and the question is WHICH
      // value is newer, while a refusal has none - it says the persisted value
      // is the one in force, and that is true whatever the draft has since
      // become. The ticket specifies the revert, and a refused edit the user has
      // typed over would otherwise leave a setting on screen the host rejected.
      return {
        ...state,
        draft: state.persisted,
        displayOrder: fallbackDisplayOrder(state.persisted.ladder),
        // The rows revert with the draft. A refused edit that never touched
        // model groups leaves them alone by the same comparison that keeps them
        // through an unrelated save.
        keyedTierGroups: reconcileKeyedGroups(
          state.keyedTierGroups,
          state.persisted.tierGroups,
        ),
        localError: null,
        hostError: action.message,
        activeField: action.field,
        saveInFlight: false,
        savingRevision: null,
      };
  }
}
