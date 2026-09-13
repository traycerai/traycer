import { useId, type ReactNode } from "react";
import { toast } from "sonner";
import type {
  FallbackPolicy,
  TierCandidate,
  TierCandidatePreview,
} from "@traycer/protocol/host/fallback-policy";
import {
  defaultTierGroupIndex,
  keyedGroup,
  noteTierGroupDefaultChoice,
  tierGroupDefaultChoiceGeneration,
  tierGroupIdentityGeneration,
  withTierGroups,
  type FallbackGroupsInverse,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";
import type { FallbackCatalogOptions } from "@/components/settings/panels/fallback/fallback-catalog-options";
import {
  FALLBACK_ADD_GROUP_ATTRIBUTE,
  FALLBACK_GROUP_DELETE_ATTRIBUTE,
  focusSelector,
  useRemovalFocus,
} from "@/components/settings/panels/fallback/fallback-removal-focus";
import { SettingsGroup } from "@/components/settings/settings-group";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FallbackTierGroupCard } from "@/components/settings/panels/fallback/fallback-tier-group-card";
import { FALLBACK } from "@/components/settings/panels/fallback-settings.definitions";

/**
 * The harness a brand-new row starts on when nothing else can supply one.
 *
 * Annotated against the candidate's own field type rather than left as a bare
 * string, so removing this member from the harness union is a compile error
 * here instead of a seed that silently stops validating. It is only an INITIAL
 * value - the row carries its own provider select - so being wrong for a given
 * user costs one click.
 *
 * Not exported: `react(only-export-components)` bans a non-component export
 * from a `.tsx`, and nothing outside this module needs it.
 */
const SEED_HARNESS_ID: TierCandidate["harnessId"] = "claude";

/**
 * The default-group Select's stand-in for `null`. A sentinel rather than the
 * empty string because Radix's `Select` reads `""` as "nothing selected" and
 * would render a placeholder for a choice the user made. It never reaches the
 * wire - `onValueChange` maps it back to `null` - and a group cannot be named
 * this, because the name field is what a user types and this is not a name.
 */
const NO_DEFAULT_GROUP_VALUE = "__no-default-group__";

export interface FallbackTierGroupsEditorProps {
  /**
   * The policy every other control on the panel is editing. Read here to
   * carry the untouched fields through onto the next value, and for the two
   * fields this editor owns: `tierGroups` and `defaultTierGroupId`. Both save
   * under the panel's `tierGroups` field, because the default is a fact about
   * the groups - which one is the default - and its status line, its tab dot
   * and its refusal all belong where the groups are.
   */
  readonly policy: FallbackPolicy;
  /**
   * What this editor RENDERS: the same groups, with a client-side identity on
   * every candidate row. Held by the panel's draft reducer rather than derived
   * here, so an identity outlives a re-render and a save (see
   * `fallback-tier-group-keys.ts`).
   */
  readonly groups: readonly KeyedGroup[];
  /**
   * Every preview row across every group, flat, exactly as the host returns
   * them. `null` means no preview is available - an older host, or a read that
   * has not landed.
   */
  readonly preview: readonly TierCandidatePreview[] | null;
  /** Names the account a preview row resolved on - never its raw id (D190). */
  readonly labelFor: FallbackSettingsProfileLabel;
  /** The catalogs each row's Model and Effort cells draw from; see `fallback-catalog-options.ts`. */
  readonly catalog: FallbackCatalogOptions;
  readonly previewPending: boolean;
  /**
   * The preview request FAILED, as opposed to having no answer yet.
   *
   * The two are indistinguishable in {@link FallbackTierGroupsEditorProps.preview}
   * by construction - it is `data-or-null`, and a null renders no verdict line -
   * so a failed check looked exactly like a host that had never been asked. The
   * user got no answer and no way to ask again, on the one surface whose job is
   * to say what a row will do. D159 accepts the null OMISSION as a fidelity
   * rule (never guess a verdict in the client); this is the usability half on
   * top of it, and it deliberately does not put an error on any ROW - the
   * failure is one request covering every row, so it is stated once for the
   * editor.
   *
   * Scope, stated rather than left to be discovered: this is the request
   * failing. A host that does not ADVERTISE the preview method at all still
   * renders nothing and offers no retry, because there is nothing to retry -
   * that host will never answer, and a "try again" for it would be a control
   * with nothing behind it.
   */
  readonly previewUnavailable: boolean;
  /** Re-asks the failed preview. Only reachable while `previewUnavailable`. */
  readonly onRetryPreview: () => void;
  /**
   * A draft move that is NOT saved: a keystroke in a group's name field. The
   * value on screen follows it and so does the inline validation message; the
   * host hears nothing until {@link onCommit}.
   */
  readonly onChange: (
    next: FallbackPolicy,
    groups: readonly KeyedGroup[],
  ) => void;
  /**
   * A completed edit, to save. Every control except a text field commits through
   * here on its own interaction; a text field commits on blur or Enter.
   *
   * Both callbacks carry both halves of the edit - the policy, and the identities
   * the rows have afterwards - because only this editor knows which row an
   * insert, a removal or a move produced. The wire policy alone cannot say, which
   * is the whole reason the identities exist.
   */
  readonly onCommit: (
    next: FallbackPolicy,
    groups: readonly KeyedGroup[],
  ) => void;
  /**
   * "Undo" on a removal toast: the inverse of that one removal, for the panel
   * to apply to the draft as it stands when the button is pressed.
   *
   * Not an `onCommit` with a reconstructed list, which is what this replaced. A
   * toast outlives the render that raised it, so a list built here is a
   * SNAPSHOT: it also reverts every unrelated setting changed since, and an
   * older toast's Undo resurrects a row deleted after it. Only the panel holds
   * the current draft, so only the panel can apply an inverse to it.
   */
  readonly onUndo: (inverse: FallbackGroupsInverse) => void;
  /** "Restore the default groups" - the RESTORE op, not a client-built list. */
  readonly onRestoreDefaults: () => void;
  readonly restorePending: boolean;
  readonly status: ReactNode;
}

/**
 * Settings ▸ Fallback ▸ Equivalent models.
 *
 * The user's statement about which models are interchangeable, which is the
 * only thing that makes the "switch to an equivalent model" step possible: the
 * host will not move a chat from a standard model to a frontier one, or the
 * reverse, on its own guess.
 *
 * The vocabulary here is "model groups" throughout - never "tier", "ladder" or
 * "rung", which are engine words that appear nowhere on this surface.
 */
export function FallbackTierGroupsEditor(
  props: FallbackTierGroupsEditorProps,
): ReactNode {
  const {
    policy,
    groups,
    preview,
    labelFor,
    catalog,
    previewPending,
    previewUnavailable,
    onRetryPreview,
    onChange,
    onCommit,
    onUndo,
    onRestoreDefaults,
    restorePending,
    status,
  } = props;

  // Every edit below builds a new keyed list and projects it through
  // `withTierGroups`, so identity never leaves this module in a saved policy
  // and never has to be reconstructed on the way back in. The policy the
  // projection starts from is a parameter rather than `policy` itself, because
  // two edits also move the default marker - see `replaceGroupAt` and the
  // delete handler.
  const emitDraft = (
    base: FallbackPolicy,
    next: readonly KeyedGroup[],
  ): void => {
    onChange(withTierGroups(base, next), next);
  };
  const emit = (base: FallbackPolicy, next: readonly KeyedGroup[]): void => {
    onCommit(withTierGroups(base, next), next);
  };
  // WHICH group is the default, by position. Asked once for the whole list and
  // never by name: the id IS the editable name, so a rename passing through
  // another group's name makes a name comparison answer for two groups at once.
  // See `defaultTierGroupIndex`.
  const defaultIndex = defaultTierGroupIndex(groups, policy.defaultTierGroupId);
  /**
   * One group replaced, and the default marker CARRIED through a rename.
   *
   * The marker is the group's id, and the id is the editable name: a rename
   * would otherwise leave the policy pointing at a name no group has, which
   * the schema then refuses to save - the user would meet an error for
   * renaming the group they had just made the default. So when the group
   * being replaced IS the default and its name changed, the marker follows
   * it. Both the keystroke path and the commit path go through here, because
   * the draft has to validate on every keystroke of the rename, not only at
   * the end.
   *
   * "IS the default" is a question about the ROW, not about its current name.
   * Renaming `cheap` to `faster` beside a default named `fast` types through
   * `fast` on the way, and a name comparison then hands the marker to the
   * group being renamed on the very next keystroke - leaving a policy that
   * saves cleanly with the wrong group as the default.
   */
  const replaceGroupAt = (
    index: number,
    next: KeyedGroup,
  ): {
    readonly base: FallbackPolicy;
    readonly groups: readonly KeyedGroup[];
  } => {
    const previous = groups[index];
    const carried =
      defaultIndex === index && next.id !== previous.id
        ? { ...policy, defaultTierGroupId: next.id }
        : policy;
    return {
      base: carried,
      groups: groups.map((existing, at) => (at === index ? next : existing)),
    };
  };

  const { containerRef, focusAfterRemoval } = useRemovalFocus();
  // Computed once for the whole list rather than per card: the question is
  // about the list, and asking it per card would be quadratic for no gain.
  const ambiguousNames = ambiguousGroupNames(groups);

  return (
    <SettingsGroup
      group={FALLBACK.definitions.equivalentModels}
      // Same name as its tab; the rail says it once.
      showTitle={false}
      tone="default"
      dataTestId="settings-fallback-tier-groups"
      fill={false}
    >
      <div className="px-5 py-4" ref={containerRef}>
        <p className="max-w-[68ch] text-ui-sm text-muted-foreground">
          Models you consider interchangeable. When one fails, the
          &ldquo;equivalent model&rdquo; step tries the others in this order.
        </p>
        {groups.length === 0 ? (
          <EmptyGroups
            onRestoreDefaults={onRestoreDefaults}
            restorePending={restorePending}
          />
        ) : (
          <>
            <DefaultGroupSelect
              defaultTierGroupId={policy.defaultTierGroupId}
              groups={groups}
              onCommit={(next) => {
                onCommit({ ...policy, defaultTierGroupId: next }, groups);
              }}
            />
            <div className="mt-3 flex flex-col gap-3">
              {groups.map((group, index) => (
                <FallbackTierGroupCard
                  // The group's own client-side identity, not its `id`. The id
                  // is the EDITABLE NAME: keying on it remounted the card - and
                  // so destroyed the focused input - on every keystroke of a
                  // rename, and could not represent the intermediate duplicate
                  // and empty names a rename passes through. Not the index
                  // either, for the reason `no-array-index-key` names. See
                  // `fallback-tier-group-keys.ts`.
                  key={group.draftKey}
                  group={group}
                  // By NAME, which is the marker's own currency. While a
                  // rename passes through a sibling's name both cards show the
                  // pill; the draft is unsavable in that state anyway (ids
                  // must be unique), so the pill is at worst briefly ambiguous
                  // on a page that is already saying so.
                  isDefault={defaultIndex === index}
                  preview={previewForGroup(preview, group.id, ambiguousNames)}
                  labelFor={labelFor}
                  catalog={catalog}
                  onUndo={onUndo}
                  defaultHarnessId={firstHarnessId(groups)}
                  onChange={(next) => {
                    const replaced = replaceGroupAt(index, next);
                    emitDraft(replaced.base, replaced.groups);
                  }}
                  onCommit={(next) => {
                    const replaced = replaceGroupAt(index, next);
                    emit(replaced.base, replaced.groups);
                  }}
                  onDelete={() => {
                    // The keyboard has to land somewhere: the button that had it
                    // is inside the subtree about to be filtered out. The group
                    // that takes this one's place, its neighbour if this was the
                    // last, and "Add a group" once the list is empty.
                    focusAfterRemoval([
                      ...groupDeleteSelectors(groups, index),
                      `[${FALLBACK_ADD_GROUP_ATTRIBUTE}]`,
                    ]);
                    // Read BEFORE the commit, which is what makes the stamp
                    // mean "the generation this row was removed from". `emit`
                    // dispatches synchronously and a refusal later in the same
                    // episode re-seeds, so a generation read inside the toast's
                    // own callback would be the generation at UNDO time and
                    // would always compare equal - the guard would be there and
                    // decide nothing.
                    const generation = tierGroupIdentityGeneration();
                    // Read before the commit for the same reason, and stamped
                    // for a different question: not "do these rows still
                    // exist" but "has the user chosen a default since". The
                    // deletion below sets `defaultTierGroupId` to null and a
                    // later "None - skip this step" sets it to null too, so
                    // only a generation tells the two apart.
                    const defaultChoiceGeneration =
                      tierGroupDefaultChoiceGeneration();
                    // Deleting the default group clears the marker: a policy
                    // whose default names no group is one the schema refuses,
                    // and the user asked to delete a group, not to be told
                    // their policy is invalid. The inverse remembers, so Undo
                    // puts the marker back with the group. By position, not by
                    // name - deleting the second of two rows a rename has left
                    // sharing the default's name is not deleting the default.
                    const wasDefault = defaultIndex === index;
                    emit(
                      wasDefault
                        ? { ...policy, defaultTierGroupId: null }
                        : policy,
                      groups.filter((_, at) => at !== index),
                    );
                    // The INVERSE of this one deletion, not the list as it stands
                    // now: the toast outlives this render, and re-submitting a
                    // captured list would also revert whatever the user changed
                    // while the toast was up - and resurrect a group deleted
                    // after it. `group` carries its own identity and its rows',
                    // so the undo brings back the same group rather than a
                    // lookalike, at the position it held; position is the one
                    // thing a user cannot re-enter by typing.
                    toast.success(`Deleted “${group.id}”`, {
                      action: {
                        label: "Undo",
                        onClick: () => {
                          onUndo({
                            kind: "group",
                            group,
                            index,
                            generation,
                            wasDefault,
                            defaultChoiceGeneration,
                          });
                        },
                      },
                    });
                  }}
                />
              ))}
            </div>
          </>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-8"
            {...{ [FALLBACK_ADD_GROUP_ATTRIBUTE]: "" }}
            onClick={() => {
              // `keyedGroup` mints the identity, which is what lets two clicks
              // produce two distinguishable cards even before either is named.
              emit(policy, [
                ...groups,
                keyedGroup({ id: nextGroupName(groups), candidates: [] }),
              ]);
            }}
          >
            Add a group
          </Button>
          <PreviewFooterStatus
            previewPending={previewPending}
            previewUnavailable={previewUnavailable}
            onRetryPreview={onRetryPreview}
          />
        </div>
        {status}
      </div>
    </SettingsGroup>
  );
}

/**
 * Which group the "equivalent model" step uses for a model that is in NO
 * group - the user's own answer to "and what about everything I haven't
 * listed", which used to be a dead end (the step was skipped and the ladder
 * moved on).
 *
 * ONE control above the list rather than a toggle on each card: it is one
 * policy field that at most one group can hold, and N toggles for it would
 * need N-1 of them to flip on every change. The card shows a pill instead.
 *
 * "None" is a real choice and the seeded one: with no default the step does
 * nothing for an unlisted model, which is the documented behaviour the user
 * had before this control existed. The option copy says so rather than
 * leaving "None" to mean "unset".
 *
 * A stored id naming no group (a hand-edited store; the schema refuses to SAVE
 * one) still renders as its own option and stays selected - the range-render
 * rule every select on this page applies. Blank and duplicate names are the
 * transient states a rename passes through, and are left out of the menu
 * rather than offered: an option with no text cannot be chosen on purpose,
 * and two options with one value cannot be told apart.
 */
function DefaultGroupSelect(props: {
  readonly defaultTierGroupId: string | null;
  readonly groups: readonly KeyedGroup[];
  readonly onCommit: (next: string | null) => void;
}): ReactNode {
  const { defaultTierGroupId, groups, onCommit } = props;
  const labelId = useId();
  const names: string[] = [];
  for (const group of groups) {
    if (group.id.trim() === "" || names.includes(group.id)) continue;
    names.push(group.id);
  }
  const unlisted =
    defaultTierGroupId !== null && !names.includes(defaultTierGroupId);
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="fallback-tier-default-group"
    >
      <span id={labelId} className="text-ui-sm">
        For a model not in any group
      </span>
      <Select
        value={defaultTierGroupId ?? NO_DEFAULT_GROUP_VALUE}
        onValueChange={(next) => {
          // The one site that records a deliberate choice of default. A
          // pending deletion toast's Undo compares its stamp against this, so
          // that choosing "None - skip this step" after deleting the default
          // group is not overwritten by the Undo putting the old marker back.
          noteTierGroupDefaultChoice();
          onCommit(next === NO_DEFAULT_GROUP_VALUE ? null : next);
        }}
      >
        <SelectTrigger
          className="h-8 w-full max-w-[28ch]"
          aria-labelledby={labelId}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEFAULT_GROUP_VALUE}>
            None - skip this step
          </SelectItem>
          {names.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
          {unlisted ? (
            <SelectItem
              value={defaultTierGroupId}
              data-testid="fallback-tier-default-group-unlisted"
            >
              {defaultTierGroupId} - no such group
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      <span className="basis-full text-ui-xs text-muted-foreground">
        The group whose models are tried when the failed model is not listed in
        any group.
      </span>
    </div>
  );
}

/**
 * What the editor says about the per-row preview AS A WHOLE - one line beside
 * "Add a group", never one per row.
 *
 * Two states in one component, made mutually exclusive by the `!previewPending`
 * term in `failed` below: a retry that is RUNNING is an answer on its way, and
 * printing "couldn't check" beside its own spinner would be describing the
 * state before the button was pressed. `previewPending` is the query's
 * `isFetching`, which covers the retry, so this remains the single pending
 * indicator D159 asks for.
 *
 * That exclusion used to be the ORDER of two early returns, which is why the
 * older wording here claimed it held "by construction rather than by a second
 * condition". It is now exactly a second condition, and deliberately so — the
 * live region has to mount on every path (see the block comment below), which
 * an early return cannot do. Stated because the two mechanisms fail
 * differently: an ordering is broken by moving a return, this one by deleting
 * a term, and a falsifier written for the first is inert against the second.
 *
 * A component rather than a nested ternary in the JSX above, which is what this
 * started as: the two arms are one decision with one reason, and reading them
 * as a unit is the point.
 */
function PreviewFooterStatus(props: {
  readonly previewPending: boolean;
  readonly previewUnavailable: boolean;
  readonly onRetryPreview: () => void;
}): ReactNode {
  const { previewPending, previewUnavailable, onRetryPreview } = props;
  // Mutually exclusive, and pending WINS: a retry already in flight is the
  // newer fact, and showing the old failure beside its own retry spinner
  // invites a second click. Derived once here rather than as two early returns,
  // because the live region below has to render on every path - see the block
  // comment on this component.
  const failed = !previewPending && previewUnavailable;
  return (
    <span className="flex items-center gap-1 text-ui-xs text-muted-foreground">
      {/* The live region is mounted ALWAYS, empty included, and only its TEXT
          swaps. A `role="status"` inserted into the tree together with its
          content is announced unreliably - NVDA and JAWS generally need the
          region present before the content changes - and for FC9 the
          announcement is the whole difference: a screen-reader user who is
          never told the check failed is back to "failed" and "absent" being
          indistinguishable, which is the row. So the region outlives its
          contents.

          `role="status"`, not `role="alert"`: nothing the user did failed and
          no policy is at risk - the rows are still editable and still savable,
          and the verdict is an advisory the page works without. An alert would
          interrupt for a missing hint.

          The retry Button is deliberately OUTSIDE the region. It is a control,
          not status text, and inside it would be read out as part of the
          announcement on every swap. */}
      <span role="status" className="flex items-center gap-2">
        {previewPending ? (
          <>
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant="orbit"
            />
            Checking what these resolve to…
          </>
        ) : null}
        {failed ? (
          <span data-testid="fallback-tier-preview-unavailable">
            Couldn&apos;t check what these models resolve to.
          </span>
        ) : null}
      </span>
      {failed ? (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-ui-xs"
          onClick={onRetryPreview}
          data-testid="fallback-tier-preview-retry"
        >
          Try again
        </Button>
      ) : null}
    </span>
  );
}

/**
 * The zero-groups state, and the distinction it has to make.
 *
 * Empty is a state a user can REACH by deleting their groups, and it is not the
 * same as never having had any: the host seeds defaults on a first read and
 * marks the user, so an empty list means "you emptied this", not "nothing has
 * been set up". Restoring is therefore an explicit action with its own verb
 * rather than something the next read does silently - which is exactly what the
 * seed marker exists to guarantee (D116/D127).
 *
 * It calls the RESTORE op rather than saving a client-built list: only the host
 * can build the seed a first read would have produced, and a list assembled here
 * would be a second opinion about what the defaults are.
 */
function EmptyGroups(props: {
  readonly onRestoreDefaults: () => void;
  readonly restorePending: boolean;
}): ReactNode {
  const { onRestoreDefaults, restorePending } = props;
  return (
    <div
      className="mt-3 rounded-lg border border-dashed border-border/70 px-4 py-5"
      data-testid="fallback-tier-groups-empty"
    >
      <p className="max-w-[68ch] text-ui-sm text-muted-foreground">
        No model groups, so the &ldquo;equivalent model&rdquo; step has nothing
        to switch to. Add a group, or put the defaults back.
      </p>
      <Button
        type="button"
        variant="outline"
        className="mt-3 h-8"
        disabled={restorePending}
        onClick={onRestoreDefaults}
      >
        Restore the default groups
        {restorePending ? (
          <AgentSpinningDots
            className="ml-2"
            testId={undefined}
            variant="orbit"
          />
        ) : null}
      </Button>
    </div>
  );
}

/**
 * Where focus goes when the group at `index` is deleted, most-preferred first.
 *
 * The NEXT group before the previous one: it is the one that will occupy the
 * removed row's place, so focus stays where the user was looking. Deleting the
 * last group is the only case that moves it backwards.
 */
function groupDeleteSelectors(
  groups: readonly KeyedGroup[],
  index: number,
): readonly string[] {
  return [
    ...groupDeleteSelectorAt(groups, index + 1),
    ...groupDeleteSelectorAt(groups, index - 1),
  ];
}

/**
 * One selector, or none when `index` is off either end. Same range check, and
 * the same two reasons, as `candidateRemoveSelectorAt` in
 * `fallback-tier-group-card.tsx`: `noUncheckedIndexedAccess` is off, so an
 * `=== undefined` test reads as an impossible comparison, and `.at()` would
 * wrap a negative index round to the end of the list.
 */
function groupDeleteSelectorAt(
  groups: readonly KeyedGroup[],
  index: number,
): readonly string[] {
  if (index < 0 || index >= groups.length) return [];
  return [
    focusSelector(FALLBACK_GROUP_DELETE_ATTRIBUTE, groups[index].draftKey),
  ];
}

/**
 * This card's preview rows, or `null` when they cannot be attributed to it.
 *
 * A preview row is identified by `(groupId, candidateIndex)` and `groupId` is
 * the group's NAME - the editable text field, which this editor explicitly
 * allows to be duplicated or empty while a rename is in progress (see
 * `fallback-tier-group-keys.ts`). Two cards sharing a name therefore match the
 * same rows, and the card then picks one by `candidateIndex` alone
 * (`previewFor` in `fallback-tier-group-card.tsx`) - so row 0 of one group
 * would render the resolution the host computed for row 0 of the OTHER. That is
 * exactly the mispairing that helper's doc says it refuses to make; matching by
 * index rather than by array position defends against the host SKIPPING a
 * candidate, not against two groups answering to one name.
 *
 * Withholding is the documented safe state rather than a new one: `null` renders
 * no verdict line at all, which is already what this surface shows for a host
 * that has not answered. A wrong verdict on the surface whose whole job is to
 * say what a row will do is worse than no verdict.
 */
function previewForGroup(
  preview: readonly TierCandidatePreview[] | null,
  groupId: string,
  ambiguousNames: ReadonlySet<string>,
): readonly TierCandidatePreview[] | null {
  if (preview === null) return null;
  if (ambiguousNames.has(groupId)) return null;
  return preview.filter((row) => row.groupId === groupId);
}

/**
 * Group names carried by MORE THAN ONE card in the current draft.
 *
 * Reachable by ordinary editing, not only by a bad save: "Add a group" mints a
 * distinct name, but a rename passes through every prefix of the name being
 * typed, and one of those can equal a sibling's. The draft is never rejected for
 * it either - the panel's validator refuses the SAVE, and the cards keep
 * rendering while the user fixes it.
 */
function ambiguousGroupNames(
  groups: readonly KeyedGroup[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.id)) duplicated.add(group.id);
    seen.add(group.id);
  }
  return duplicated;
}

/**
 * A harness to seed a new row in a group that has none.
 *
 * Taken from the user's own existing groups rather than from the harness
 * catalog: a harness already in their configuration is one they have, which is
 * a better guess than the first entry of a list they may not have installed -
 * and it needs no catalog read on a settings page that otherwise needs none.
 *
 * Never `null`. An earlier draft returned one and disabled "Add a model", which
 * made a group whose rows had all been removed a dead end the user could reach
 * by ordinary editing. The row carries its own provider select, so the seed is
 * only ever a starting point.
 */
function firstHarnessId(
  groups: readonly KeyedGroup[],
): TierCandidate["harnessId"] {
  for (const group of groups) {
    if (group.candidates.length > 0) return group.candidates[0].value.harnessId;
  }
  return SEED_HARNESS_ID;
}

/**
 * A distinct name for a new group.
 *
 * Group ids must be unique or the whole policy fails validation, so a fixed
 * "New group" would make the second one invalid the moment it is added - the
 * user would meet an error they did not cause and could not have avoided.
 */
function nextGroupName(groups: readonly KeyedGroup[]): string {
  const taken = new Set(groups.map((group) => group.id));
  if (!taken.has("New group")) return "New group";
  let suffix = 2;
  while (taken.has(`New group ${suffix}`)) suffix += 1;
  return `New group ${suffix}`;
}
