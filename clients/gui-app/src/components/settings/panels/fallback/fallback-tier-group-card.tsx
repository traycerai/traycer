import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { toast } from "sonner";
import type {
  TierCandidate,
  TierCandidatePreview,
  TierConflict,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  keyedCandidate,
  moveKeyedCandidate,
  tierGroupIdentityGeneration,
  type FallbackGroupsInverse,
  type KeyedCandidate,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";
import {
  FALLBACK_ADD_MODEL_ATTRIBUTE,
  FALLBACK_CANDIDATE_MODEL_ATTRIBUTE,
  FALLBACK_CANDIDATE_REMOVE_ATTRIBUTE,
  FALLBACK_GROUP_DELETE_ATTRIBUTE,
  focusSelector,
  useRemovalFocus,
} from "@/components/settings/panels/fallback/fallback-removal-focus";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { harnessLabel } from "@/components/settings/panels/fallback/fallback-harness-label";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "@traycer/protocol/host/index";
import {
  catalogModelForFamily,
  type FallbackCatalogOptions,
} from "@/components/settings/panels/fallback/fallback-catalog-options";
import {
  isModelPattern,
  joinWithAnd,
  rowConflictModelCount,
  rowConflictsFor,
  rowStatusLine,
  tierDisplayName,
  type RowConflict,
  type RowStatusLine,
  type TryStep,
} from "@/components/settings/panels/fallback/fallback-model-patterns";
import { FallbackModelPatternCombobox } from "@/components/settings/panels/fallback/fallback-model-pattern-combobox";
import {
  conflictAnnouncementKeys,
  useConflictFirstAppearance,
} from "@/components/settings/panels/fallback/fallback-conflict-announcements";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface FallbackTierGroupCardProps {
  /**
   * The tier's rows WITH their client-side identities.
   *
   * The card never sees the bare wire shape, because every row it renders needs
   * a key and `TierCandidate` has no id to give it - see
   * `fallback-tier-group-keys.ts` for why content and index both fail.
   */
  readonly group: KeyedGroup;
  /**
   * This tier's position in the draft - the index `findTierConflicts` and the
   * picker's one-model-one-tier check speak in.
   */
  readonly groupIndex: number;
  /**
   * Every tier of the draft, as the wire shape - what the picker checks a
   * choice against. Threaded rather than rebuilt per card, like `catalog`.
   */
  readonly tierGroups: readonly TierGroup[];
  /**
   * Whether this tier is the policy's default - the one the "equivalent
   * model" step uses for a model that is in no tier. Decided by the editor
   * (it owns the policy field) and only DISPLAYED here, so a rename that
   * carries the marker and a delete that clears it have one owner.
   */
  readonly isDefault: boolean;
  /**
   * The preview rows for THIS tier, or `null` when no preview is available -
   * an older host, or the read has not landed. `null` renders nothing rather
   * than an optimistic guess: the whole point of the preview is that only the
   * host can say what a pattern reaches.
   */
  readonly preview: readonly TierCandidatePreview[] | null;
  /**
   * Names the account a row resolved on. Threaded rather than resolved per card
   * so one providers read builds one label map (D190).
   */
  readonly labelFor: FallbackSettingsProfileLabel;
  /**
   * The catalogs the Model and Effort cells draw from. Threaded like
   * `labelFor` rather than resolved per card: one catalog read serves every
   * row.
   */
  readonly catalog: FallbackCatalogOptions;
  /**
   * Whether the host reads rows as patterns (`providers.fallbackPolicy.get`
   * 1.1+). Below it the Model cell is the select-only cell it always was, and
   * no row is judged by pattern rules the host does not apply.
   */
  readonly patternsSupported: boolean;
  /**
   * Every "one model, one tier" conflict in the draft - rendered state, never a
   * gate. The card picks out the ones its rows take part in.
   */
  readonly conflicts: readonly TierConflict[];
  /** A text keystroke: the draft moves, nothing is saved. */
  readonly onChange: (next: KeyedGroup) => void;
  /** A completed edit, to save - every control but a text field, and a text
   * field's blur or Enter. */
  readonly onCommit: (next: KeyedGroup) => void;
  readonly onDelete: () => void;
  /** The inverse of a row removal, for the panel to apply to the current draft. */
  readonly onUndo: (inverse: FallbackGroupsInverse) => void;
  /**
   * The harness a NEW row starts on when this tier has no row to copy from.
   *
   * Never null: a tier whose rows were all removed must still be able to
   * regain one, and that state is reachable by ordinary editing. The editor
   * supplies the user's own first harness where there is one and
   * {@link SEED_HARNESS_ID} otherwise.
   */
  readonly defaultHarnessId: TierCandidate["harnessId"];
  /** Says a picker refusal through the editor's live region. */
  readonly onAnnounce: (text: string) => void;
  /** "Go to the <tier> row": put the keyboard on another tier's row. */
  readonly onGoToRow: (tierIndex: number, candidateIndex: number) => void;
}

/**
 * One tier: a name, and the models (or patterns) the user is declaring
 * interchangeable.
 *
 * Row ORDER is load-bearing - the tier rung walks it, and each row tries every
 * model it matches before the next row - so the rows carry ▲▼ controls and a
 * `#` rank. Tier order is not a control: it matters only while a model is in
 * two tiers, where the first-listed tier handles it until the user fixes the
 * overlap (spec decision 4), and a reorder control for that one state would
 * invite using order as configuration.
 */
// ONE grid for a tier's rows at full width, header included, every row
// joining it with `grid-cols-subgrid`. The shape and the reason are
// `provider-cli-candidates-section.tsx`'s: applying the same template to each
// row separately makes the rows SIBLING grids, so every column resolves
// against its own row's content and no two rows agree where a column starts.
//
// Fractional tracks rather than `auto`, for the same reason that file gives:
// an `auto` track is sized by its content, so one long model name would move
// the Effort column for every row. No rem floor either - that is a fixed
// layout width. The rank and actions tracks are the places `auto` is safe:
// they always hold the same glyph and the same three buttons.
//
// Below the panel's breakpoint (`@2xl`, the one the Overrides matrix beside
// this tab uses) the table gives way to stacked rows (spec §Wireframe 5):
// each row is its own small grid - rank, provider and effort on one line,
// the model or pattern under them, then the try line, then the controls.
// Named areas carry both layouts, so the cells are written once.
const CANDIDATE_GRID =
  "flex flex-col @2xl:grid @2xl:grid-cols-[auto_minmax(0,1fr)_minmax(0,2.1fr)_minmax(0,0.9fr)_auto] @2xl:gap-x-2";
const CANDIDATE_ROW = cn(
  "grid grid-cols-[auto_minmax(0,1fr)_minmax(0,0.6fr)] items-center gap-x-2 px-3 py-2.5",
  "[grid-template-areas:'rank_provider_effort'_'model_model_model'_'status_status_status'_'actions_actions_actions']",
  "@2xl:col-span-5 @2xl:grid-cols-subgrid @2xl:px-2 @2xl:py-2",
  "@2xl:[grid-template-areas:'rank_provider_model_effort_actions'_'._._status_status_status']",
);

export function FallbackTierGroupCard(
  props: FallbackTierGroupCardProps,
): ReactNode {
  const {
    group,
    groupIndex,
    tierGroups,
    isDefault,
    preview,
    labelFor,
    catalog,
    patternsSupported,
    conflicts,
    onChange,
    onCommit,
    onDelete,
    onUndo,
    defaultHarnessId,
    onAnnounce,
    onGoToRow,
  } = props;
  // An explicit length check rather than `candidates[0]?.harnessId`: a new row
  // copies the tier's own first harness when there is one, and only an emptied
  // tier falls back to the panel's default.
  const seedHarnessId =
    group.candidates.length > 0
      ? group.candidates[0].value.harnessId
      : defaultHarnessId;
  const { containerRef, focusAfterRemoval } = useRemovalFocus();
  return (
    // A NAMED container, which is AX8's half of this card. Every control
    // inside it repeats a label the panel uses several times over - "Provider",
    // "Effort", "Move up" - so with two tiers on screen the accessible names
    // alone cannot say which tier is being changed, and with two rows in one
    // tier they cannot say which row. The names are right; the RELATIONSHIPS
    // were missing.
    //
    // Naming the container rather than qualifying every control is the ARIA
    // answer and the cheaper one: tier context is announced on entry and then
    // stays out of the way. `aria-label` rather than `aria-labelledby` pointing
    // at the name field: the tier's name is an editable INPUT, and an input is
    // not a label - its own accessible name is "Tier name". Computed from the
    // current value, so it follows a rename.
    <div
      role="group"
      aria-label={groupContainerLabel(group.id)}
      className="rounded-lg border border-border/60 p-4"
      data-testid={`fallback-tier-group-${group.id}`}
      ref={containerRef}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={group.id}
          aria-label="Tier name"
          className="h-8 w-full max-w-[22ch]"
          onChange={(event) => {
            onChange({ ...group, id: event.target.value });
          }}
          // The tier already carries the keystrokes, so committing it as it
          // stands is committing what is on screen.
          {...commitOnLeave(() => {
            onCommit(group);
          })}
        />
        {/* A pill, not a control: the default is chosen ONCE, above the list,
            and a per-card toggle would be N controls for one policy field
            that only one card can hold at a time. The pill is what tells a
            reader scanning the cards which tier unlisted models land in. */}
        {isDefault ? (
          <Badge variant="secondary" data-testid="fallback-tier-group-default">
            Default
          </Badge>
        ) : null}
        <div className="flex-1" />
        <Button
          type="button"
          variant="muted"
          className="h-8"
          // Addressed by the editor's focus handoff after a sibling tier is
          // deleted - by this tier's DRAFT KEY, never by its editable name.
          {...{ [FALLBACK_GROUP_DELETE_ATTRIBUTE]: group.draftKey }}
          onClick={onDelete}
        >
          Delete tier
        </Button>
      </div>
      {/* A table at full width and a stack of small cards below it. Plain
          `div`s rather than `ul`/`li`: subgrid needs each row to be a direct
          child of the one grid, and every row already names itself
          `role="group"`. */}
      <div
        className={cn(
          "mt-3 overflow-hidden rounded-md border border-border/60",
          CANDIDATE_GRID,
        )}
      >
        <div
          className={cn(
            "hidden @2xl:col-span-5 @2xl:grid @2xl:grid-cols-subgrid @2xl:px-2",
            "border-b border-border/40 bg-foreground/3 py-1.5 text-ui-xs font-medium text-muted-foreground",
          )}
        >
          {/* The rank is decorative (spec §Accessibility): try order is the
              row's position and its try line. */}
          <span aria-hidden>#</span>
          <span>Provider</span>
          <span>{patternsSupported ? "Model or pattern" : "Model"}</span>
          <span>Effort</span>
          {/* The actions column: a header over Move up / Move down / Remove
              would name three different things at once. */}
          <span />
        </div>
        {group.candidates.map((candidate, index) => (
          // The row's own client-side identity, assigned once when it entered
          // the draft. Not the index (these rows reorder, and an index key
          // makes React reuse the node at a position rather than follow the
          // row, so a move keeps the control the user is in while its data
          // changes underneath) and not the content (two rows may legitimately
          // hold the same values - two fresh rows both start empty).
          <CandidateRow
            key={candidate.key}
            candidate={candidate.value}
            // The row's identity, threaded so its Remove button and Model cell
            // can be ADDRESSED by a focus handoff. Not the index: after a
            // removal the indices shift, which is precisely the moment the
            // handoff runs.
            rowKey={candidate.key}
            index={index}
            groupIndex={groupIndex}
            tierGroups={tierGroups}
            candidateCount={group.candidates.length}
            preview={previewFor(preview, index)}
            labelFor={labelFor}
            catalog={catalog}
            patternsSupported={patternsSupported}
            rowConflicts={
              patternsSupported
                ? rowConflictsFor(conflicts, groupIndex, index)
                : NO_ROW_CONFLICTS
            }
            onAnnounce={onAnnounce}
            onGoToRow={onGoToRow}
            onCommit={(next) => {
              onCommit(withCandidateAt(group, index, next));
            }}
            onMove={(to) => {
              onCommit({
                ...group,
                candidates: moveKeyedCandidate(group.candidates, index, to),
              });
            }}
            onRemove={() => {
              // The Remove button that had focus is inside the row about to
              // be filtered out: hand the keyboard to the row that takes its
              // place, its neighbour if this was the last, or the "Add"
              // control once the tier is empty.
              focusAfterRemoval([
                ...candidateRemoveSelectors(group.candidates, index),
                `[${FALLBACK_ADD_MODEL_ATTRIBUTE}]`,
              ]);
              // Read before the commit, for the reason spelled out at the
              // tier-level removal in `fallback-tier-groups-editor.tsx`:
              // reading it inside the Undo callback would sample the
              // generation at Undo time and always compare equal.
              const generation = tierGroupIdentityGeneration();
              onCommit({
                ...group,
                candidates: group.candidates.filter((_, at) => at !== index),
              });
              // The INVERSE of this one removal, applied to the draft as it
              // stands when Undo is pressed - not this tier as it stands
              // now, which is a snapshot that would also revert whatever the
              // user changed while the toast was up. `candidate` carries its
              // own key, so the row comes back as the same row rather than a
              // lookalike, at the index it held: its position is load-bearing
              // (the rung walks this order) and is the one thing a user
              // cannot recover by retyping.
              //
              // Nothing here asks whether putting it back would create a
              // "one model, one tier" conflict. It may - the row removed, a
              // covering pattern added elsewhere, then Undo - and that is
              // rendered state like any other conflict, never a refusal.
              toast.success(
                `Removed ${candidate.value.modelFamily.trim() === "" ? "the empty row" : `“${candidateDisplayName(candidate.value, catalog)}”`}`,
                {
                  action: {
                    label: "Undo",
                    onClick: () => {
                      onUndo({
                        kind: "candidate",
                        groupDraftKey: group.draftKey,
                        candidate,
                        index,
                        generation,
                      });
                    },
                  },
                },
              );
            }}
          />
        ))}
      </div>
      <Button
        size="inline"
        type="button"
        variant="link"
        className="mt-2"
        {...{ [FALLBACK_ADD_MODEL_ATTRIBUTE]: "" }}
        onClick={() => {
          onCommit({
            ...group,
            candidates: [
              ...group.candidates,
              // `keyedCandidate` mints a fresh identity, which is what lets two
              // clicks produce two distinguishable empty rows.
              // A new row starts with an EMPTY model rather than a plausible
              // one. The draft is invalid until the user picks it (the wire
              // schema requires a non-empty trimmed value), which is the
              // correct state: an invented default is a value the user never
              // chose that would be saved as though they had. The HARNESS is
              // different - it is a closed union with a control right there, so
              // seeding it is a starting point rather than a fabricated answer.
              keyedCandidate({
                harnessId: seedHarnessId,
                modelFamily: "",
                reasoningEffort: null,
              }),
            ],
          });
        }}
      >
        {/* "or pattern" only where the host reads one: on a 1.0 host the new
            row's cell is the select, and offering a pattern there would be a
            promise the cell cannot keep. */}
        {patternsSupported ? "Add model or pattern" : "Add model"}
      </Button>
    </div>
  );
}

/** A shared empty value, so a 1.0 host's rows do not each allocate one. */
const NO_ROW_CONFLICTS: readonly RowConflict[] = [];

/**
 * The tier container's accessible name.
 *
 * A blank name is a state the user can reach and hold - the draft is invalid
 * until they type one, and the tier stays on screen meanwhile - so the label
 * has to work without it. "Unnamed tier" rather than a position, deliberately:
 * the position is what the VALIDATION message uses ("Tier 2 needs a name"),
 * and the two sentences are heard together, so the container saying nothing
 * about which one it is sends the reader to the error line that does.
 */
function groupContainerLabel(id: string): string {
  return id.trim() === "" ? "Unnamed tier" : `Tier ${id}`;
}

/**
 * How a row's value is NAMED in copy that is not the cell itself: the removal
 * toast and the Remove button's accessible name. The catalog label when the
 * stored value is a slug the catalog knows ("Claude Opus 5"), the stored
 * value otherwise - a pattern is already the user's own words.
 */
function candidateDisplayName(
  candidate: TierCandidate,
  catalog: FallbackCatalogOptions,
): string {
  const picked = catalogModelForFamily(
    catalog.modelsFor(candidate.harnessId),
    candidate.modelFamily,
  );
  return picked === null ? candidate.modelFamily : picked.label;
}

/**
 * Where focus goes when the row at `index` is removed, most-preferred first.
 *
 * The NEXT row before the previous one, for the same reason as the tier-level
 * handoff: it is the row that takes the removed one's place, so the keyboard
 * stays where the user was looking.
 */
function candidateRemoveSelectors(
  candidates: readonly KeyedCandidate[],
  index: number,
): readonly string[] {
  return [
    ...candidateRemoveSelectorAt(candidates, index + 1),
    ...candidateRemoveSelectorAt(candidates, index - 1),
  ];
}

/**
 * One selector, or none when `index` is off either end.
 *
 * The range check is explicit rather than `candidates[index] === undefined`
 * because `noUncheckedIndexedAccess` is off in `tsconfig.app.json`: an index
 * read is typed as the element even where it yields `undefined` at runtime, so
 * the comparison reads to the type-checker as a test between types that cannot
 * overlap. `.at()` would type it honestly but answers the WRONG element - a
 * negative index wraps to the end of the list, which for the first row means
 * the row furthest from it and, when it is the only row, the row being removed.
 */
function candidateRemoveSelectorAt(
  candidates: readonly KeyedCandidate[],
  index: number,
): readonly string[] {
  if (index < 0 || index >= candidates.length) return [];
  return [
    focusSelector(FALLBACK_CANDIDATE_REMOVE_ATTRIBUTE, candidates[index].key),
  ];
}

/**
 * When a text field's value becomes a save: on the way out, or on Enter.
 *
 * Two gestures because they mean different things and users do both. Blur is the
 * one that always happens - clicking another field, tabbing away, closing the
 * page - so it is what makes the rule safe: no edit can be stranded by
 * forgetting to press anything. Enter is for the person who has finished typing
 * and wants it saved without leaving the field, which blur alone cannot express.
 *
 * Enter deliberately does not also blur. The field is not a form being
 * submitted; taking focus away would punish the gesture that asked for a save.
 *
 * Returned as props to spread rather than taken as a wrapper, so the call site
 * still reads as an `<Input>` with an `onChange`. The tier name is the only
 * text field left on the card - the Model cell commits a choice and the Effort
 * cell is a select - but the shape is kept so a second text field cannot
 * accidentally get one handler and not the other.
 */
function commitOnLeave(commit: () => void): {
  readonly onBlur: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
} {
  return {
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === "Enter") commit();
    },
  };
}

/**
 * One row replaced, its identity kept.
 *
 * The key travels with the row through an edit: changing the model is the same
 * row, not a new one, and minting a fresh key here would remount the row's
 * controls on every change - the exact bug the identities exist to prevent.
 */
function withCandidateAt(
  group: KeyedGroup,
  index: number,
  next: TierCandidate,
): KeyedGroup {
  return {
    ...group,
    candidates: group.candidates.map((existing, at) =>
      at === index ? { key: existing.key, value: next } : existing,
    ),
  };
}

/**
 * The row's preview, matched by `candidateIndex`.
 *
 * Matched by index rather than by position in the array because the response is
 * a flat list over every tier and carries its own index - a positional read
 * would silently pair a row with another tier's verdict the moment the host
 * skips a candidate.
 */
function previewFor(
  preview: readonly TierCandidatePreview[] | null,
  index: number,
): TierCandidatePreview | null {
  if (preview === null) return null;
  return preview.find((row) => row.candidateIndex === index) ?? null;
}

function CandidateRow(props: {
  readonly candidate: TierCandidate;
  readonly rowKey: string;
  readonly index: number;
  readonly groupIndex: number;
  readonly tierGroups: readonly TierGroup[];
  readonly candidateCount: number;
  readonly preview: TierCandidatePreview | null;
  readonly labelFor: FallbackSettingsProfileLabel;
  readonly catalog: FallbackCatalogOptions;
  readonly patternsSupported: boolean;
  readonly rowConflicts: readonly RowConflict[];
  readonly onAnnounce: (text: string) => void;
  readonly onGoToRow: (tierIndex: number, candidateIndex: number) => void;
  readonly onCommit: (next: TierCandidate) => void;
  readonly onMove: (toIndex: number) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const {
    candidate,
    rowKey,
    index,
    groupIndex,
    tierGroups,
    candidateCount,
    preview,
    labelFor,
    catalog,
    patternsSupported,
    rowConflicts,
    onAnnounce,
    onGoToRow,
    onCommit,
    onMove,
  } = props;
  const models = catalog.modelsFor(candidate.harnessId);
  const modelId = useId();
  const previewId = useId();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const status = rowStatusLine({ candidate, preview, models, labelFor });
  const providerLabel = harnessLabel(candidate.harnessId);
  /**
   * "Edit pattern" from the status line or a conflict block: opens this row's
   * combobox by clicking its trigger, which is the path that also focuses the
   * list's input and returns focus to the trigger on close.
   */
  const editPattern = (): void => {
    rowRef.current
      ?.querySelector<HTMLElement>(`[${FALLBACK_CANDIDATE_MODEL_ATTRIBUTE}]`)
      ?.click();
  };
  // What "fix this row" is called: a pattern is edited, an exact pick is
  // swapped for another model (review R11) - "Edit pattern" on a row holding
  // `gpt-5.6-terra` names a thing the row does not have.
  const editLabel = isModelPattern(candidate.modelFamily.trim())
    ? "Edit pattern"
    : "Change model";
  const commitModel = (next: string): void => {
    // Picking a different value keeps the effort only while the new value
    // offers it; a level that was valid for the old model and is not for
    // this one would otherwise be saved and then dropped at resolution,
    // which is the defect the Effort select replaced.
    const efforts = catalog.effortsFor(candidate.harnessId, next);
    const keepsEffort =
      candidate.reasoningEffort !== null &&
      efforts.some((option) => option.id === candidate.reasoningEffort);
    onCommit({
      ...candidate,
      modelFamily: next,
      reasoningEffort: keepsEffort ? candidate.reasoningEffort : null,
    });
  };
  return (
    // The row's own named container, nested inside the tier's (AX8). "Row 1"
    // is the same way the validation copy names a row
    // (`fallback-policy-draft.ts`'s `candidateSubject`) and the number its `#`
    // rank prints, so the container, the error line and the table agree.
    //
    // Position and not the model: the model is the cell that is blank in the
    // case this matters most, so naming the row by it produces "the model
    // called “”".
    <div
      ref={rowRef}
      role="group"
      aria-label={`Row ${index + 1}`}
      className={cn(CANDIDATE_ROW, "border-b border-border/40 last:border-b-0")}
      data-testid="fallback-tier-candidate-row"
    >
      <span
        aria-hidden
        className="grid size-5.5 place-items-center rounded-md bg-foreground/5 text-ui-xs font-semibold text-muted-foreground tabular-nums [grid-area:rank]"
        data-testid="fallback-tier-candidate-rank"
      >
        {index + 1}
      </span>
      <div className="min-w-0 [grid-area:provider]">
        <HarnessSelect
          harnessId={candidate.harnessId}
          // A select produces a complete value per interaction, so it commits
          // immediately - the blur rule is about text, not about controls.
          //
          // The MODEL is cleared with the provider: a slug or a pattern is
          // meaningful on one catalog only, and carrying `*astra*` onto Claude
          // would save a row that means nothing there. The effort goes with it
          // for the same reason - the levels are the provider's vocabulary.
          onChange={(next) => {
            onCommit({
              harnessId: next,
              modelFamily: "",
              reasoningEffort: null,
            });
          }}
        />
      </div>
      <div className="mt-2 min-w-0 [grid-area:model] @2xl:mt-0">
        {patternsSupported ? (
          <FallbackModelPatternCombobox
            id={modelId}
            rowKey={rowKey}
            modelFamily={candidate.modelFamily}
            harnessId={candidate.harnessId}
            providerLabel={providerLabel}
            models={catalog.catalogFor(candidate.harnessId)}
            groups={tierGroups}
            groupIndex={groupIndex}
            candidateIndex={index}
            conflictCount={rowConflictModelCount(rowConflicts)}
            // The try line below is what this cell resolves to, so it is
            // this cell's DESCRIPTION (AX8). Dropped when there is no line
            // rather than pointing at an element that is not rendered: a
            // dangling `aria-describedby` is a promise of detail with nothing
            // behind it, and the absence is itself meaningful here (D159).
            describedBy={status === null ? undefined : previewId}
            onChange={commitModel}
            onAnnounce={onAnnounce}
          />
        ) : (
          <ModelSelect
            id={modelId}
            modelFamily={candidate.modelFamily}
            models={models}
            describedBy={status === null ? undefined : previewId}
            onChange={commitModel}
          />
        )}
      </div>
      <div className="min-w-0 [grid-area:effort]">
        <EffortControl
          reasoningEffort={candidate.reasoningEffort}
          options={catalog.effortsFor(
            candidate.harnessId,
            candidate.modelFamily,
          )}
          onCommit={(next) => {
            onCommit({ ...candidate, reasoningEffort: next });
          }}
        />
      </div>
      <div className="mt-2 flex items-center justify-end [grid-area:actions] @2xl:mt-0">
        <MoveButton
          direction="up"
          disabled={index === 0}
          onClick={() => {
            onMove(index - 1);
          }}
        />
        <MoveButton
          direction="down"
          disabled={index === candidateCount - 1}
          onClick={() => {
            onMove(index + 1);
          }}
        />
        <Button
          size="inline"
          type="button"
          variant="muted"
          className="size-8 @2xl:size-7"
          aria-label={`Remove ${candidate.modelFamily.trim() === "" ? "row" : candidateDisplayName(candidate, catalog)}`}
          {...{ [FALLBACK_CANDIDATE_REMOVE_ATTRIBUTE]: rowKey }}
          onClick={props.onRemove}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      {status === null && rowConflicts.length === 0 ? null : (
        <div className="mt-2 flex min-w-0 flex-col gap-2 [grid-area:status] @2xl:mt-1">
          {status === null ? null : (
            <RowStatus
              id={previewId}
              status={status}
              pattern={candidate.modelFamily.trim()}
              providerLabel={providerLabel}
              canEdit={patternsSupported}
              editLabel={editLabel}
              onEditPattern={editPattern}
            />
          )}
          {rowConflicts.map((conflict) => (
            <ConflictBlock
              key={conflict.others.map((other) => other.tierIndex).join(" ")}
              conflict={conflict}
              harnessId={candidate.harnessId}
              rowTierId={
                groupIndex < tierGroups.length ? tierGroups[groupIndex].id : ""
              }
              editLabel={editLabel}
              onEditPattern={editPattern}
              onGoToRow={onGoToRow}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The row's status line - what it tries, or why it tries nothing - drawn from
 * {@link rowStatusLine}.
 *
 * Colour never carries meaning alone (spec §Accessibility): the red line says
 * "matches nothing", an amber pill carries its reason as a word, and a model
 * the walk would skip is struck through AND followed by that pill.
 */
function RowStatus(props: {
  readonly id: string;
  readonly status: RowStatusLine;
  readonly pattern: string;
  readonly providerLabel: string;
  readonly canEdit: boolean;
  readonly editLabel: string;
  readonly onEditPattern: () => void;
}): ReactNode {
  const {
    id,
    status,
    pattern,
    providerLabel,
    canEdit,
    editLabel,
    onEditPattern,
  } = props;
  const warnings =
    status.warnings.length === 0 ? null : (
      <span>{status.warnings.join(" · ")}</span>
    );
  if (status.kind === "unmatched") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-destructive">
        <p
          id={id}
          data-testid="fallback-tier-candidate-preview"
          data-unmatched="true"
        >
          No {providerLabel} model matches{" "}
          <code className="font-mono">{pattern}</code>. Traycer will skip this
          row.{warnings === null ? null : <> {warnings}</>}
        </p>
        {canEdit ? (
          <Button
            size="inline-xs"
            type="button"
            variant="link"
            onClick={onEditPattern}
          >
            {editLabel}
          </Button>
        ) : null}
      </div>
    );
  }
  if (status.kind === "cannot-check") {
    return (
      <p
        id={id}
        className="text-ui-xs text-muted-foreground"
        data-testid="fallback-tier-candidate-preview"
      >
        Can&apos;t check right now: {status.reason}
        {warnings === null ? null : <> · {warnings}</>}
      </p>
    );
  }
  if (status.kind === "warnings") {
    return (
      <p
        id={id}
        className="text-ui-xs text-muted-foreground"
        data-testid="fallback-tier-candidate-preview"
      >
        {warnings}
      </p>
    );
  }
  return (
    <p
      id={id}
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-xs text-muted-foreground"
      data-testid="fallback-tier-candidate-preview"
    >
      {status.lead === null ? null : (
        <Badge variant="warning" className="rounded-full">
          {status.lead}
        </Badge>
      )}
      <span>Tries</span>
      {status.steps.map((step, at) => (
        <TryStepView key={step.model} first={at === 0} step={step} />
      ))}
      {status.more === 0 ? null : (
        <>
          <TryArrow />
          <span>{status.more} more</span>
        </>
      )}
      {status.account === null ? null : <span>· {status.account}</span>}
      {warnings === null ? null : <span>· {warnings}</span>}
    </p>
  );
}

function TryArrow(): ReactNode {
  return (
    <>
      <span aria-hidden className="text-muted-foreground/70">
        →
      </span>
      <span className="sr-only">then</span>
    </>
  );
}

function TryStepView(props: {
  readonly first: boolean;
  readonly step: TryStep;
}): ReactNode {
  const { first, step } = props;
  return (
    <>
      {first ? null : <TryArrow />}
      <span
        className={cn(
          step.skipLabel === null
            ? "text-foreground/85"
            : "text-muted-foreground/70 line-through",
        )}
      >
        {step.label}
      </span>
      {step.skipLabel === null ? null : (
        <Badge variant="warning" className="rounded-full">
          {step.skipLabel}
        </Badge>
      )}
    </>
  );
}

/**
 * A model this row shares with another tier (spec §Wireframe 3, "In two
 * tiers") - red, because it is the user's to fix, and never a gate: nothing
 * about it stops another edit from saving.
 *
 * `role="alert"` on the conflict's FIRST appearance in the panel (spec
 * §Accessibility) - an edit elsewhere, an Undo, a catalog that loads - so it
 * is announced where it lands, and never again for the same conflict when the
 * tab is revisited or a deletion re-keys the block
 * (`fallback-conflict-announcements.ts`). It names the other tier, says which
 * tier handles the model meanwhile (the first-listed, which is where routing
 * sends it) and why, and offers the two ways out: edit this row, or go to the
 * other one.
 */
function ConflictBlock(props: {
  readonly conflict: RowConflict;
  readonly harnessId: string;
  /** The tier the row drawing this block belongs to - one of the conflict's tiers. */
  readonly rowTierId: string;
  readonly editLabel: string;
  readonly onEditPattern: () => void;
  readonly onGoToRow: (tierIndex: number, candidateIndex: number) => void;
}): ReactNode {
  const {
    conflict,
    harnessId,
    rowTierId,
    editLabel,
    onEditPattern,
    onGoToRow,
  } = props;
  const firstAppearance = useConflictFirstAppearance(
    conflictAnnouncementKeys({
      harnessId,
      models: conflict.models,
      tierIds: [rowTierId, ...conflict.others.map((other) => other.tierId)],
    }),
  );
  const labels = conflict.models.map((model) => model.label);
  const plural = labels.length > 1;
  const otherNames = conflict.others.map((other) =>
    tierDisplayName(other.tierId, other.tierIndex),
  );
  const handler = tierDisplayName(
    conflict.handler.tierId,
    conflict.handler.tierIndex,
  );
  return (
    <div
      role={firstAppearance ? "alert" : undefined}
      className="flex max-w-xl flex-col gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-xs text-foreground"
      data-testid="fallback-tier-conflict"
    >
      <span className="font-semibold text-destructive">
        {joinWithAnd(labels)} {plural ? "are" : "is"} also in{" "}
        {joinWithAnd(otherNames)}
      </span>
      <span>
        A model can be in only one tier. Until you fix this,{" "}
        <b className="font-semibold">{handler}</b> handles{" "}
        {plural ? "them" : joinWithAnd(labels)} because it&apos;s listed first.
      </span>
      <span className="flex flex-wrap gap-x-4 gap-y-1">
        <Button
          size="inline-xs"
          type="button"
          variant="link"
          onClick={onEditPattern}
        >
          {editLabel}
        </Button>
        {conflict.others.map((other, at) => (
          <Button
            key={other.tierIndex}
            size="inline-xs"
            type="button"
            variant="link"
            onClick={() => {
              onGoToRow(other.tierIndex, other.candidateIndex);
            }}
          >
            Go to the {otherNames[at]} row
          </Button>
        ))}
      </span>
    </div>
  );
}

/**
 * Which model this row names, on a host whose `providers.fallbackPolicy.get`
 * line is below 1.1 - the cell exactly as it was before patterns.
 *
 * Kept rather than retired because such a host still reads a row as a family
 * WORD on word boundaries: a `*opus*` saved there is a string its matcher
 * never matches, so the pattern combobox is offered only once the negotiated
 * line says the host will read what it writes
 * (`useFallbackPolicyPatternLines`).
 *
 * A `Select` over the provider's catalog - the same models the composer's
 * picker offers, by their catalog labels, in catalog order - storing the
 * chosen SLUG. It replaced a text field that accepted anything: a user had to
 * know a slug or family spelling already, and a typo was accepted, saved as
 * policy, and then matched nothing at resolution, so the value on screen did
 * not mean the model the fallback would run.
 *
 * A stored value that is not a catalog slug still renders, PINNED as the first
 * option and selected - the same range-render rule {@link HarnessSelect} and
 * {@link EffortControl} apply, and for the same reason: silently rewriting a
 * stored value on a page someone opened to read is worse than showing them
 * what is actually saved. Two stored values reach that branch:
 *
 *  - a FAMILY name (`opus`), which the seeded groups use and which the engine
 *    resolves against the live catalog at hop time. Tagged "family" so a
 *    reader can tell it from a model, and only once the catalog has answered
 *    - with no catalog, nothing can say whether "gpt-5" is a slug or a word,
 *    and calling it a family would be a claim with nothing behind it;
 *  - a slug the catalog no longer lists, which the row's preview line then
 *    reports as matching nothing.
 *
 * The cell cannot TYPE a family any more; that is the trade the dropdown
 * makes, and the seeded families survive it because they are pinned. Blank -
 * a row just added - shows the placeholder and is marked invalid, which is
 * the same rule the wire schema applies (`modelFamily: z.string().trim()
 * .min(1)`): the draft cannot be saved until the row names something.
 */
function ModelSelect(props: {
  readonly id: string;
  readonly modelFamily: string;
  readonly models: readonly GuiAgentModelOption[];
  readonly describedBy: string | undefined;
  readonly onChange: (next: string) => void;
}): ReactNode {
  const { id, modelFamily, models, describedBy, onChange } = props;
  const stored = modelFamily.trim();
  const picked = catalogModelForFamily(models, stored);
  // The catalog's own spelling when it knows the value, so the Select's value
  // matches its item exactly - the engine lower-cases both sides, so "GPT-5"
  // and "gpt-5" are one model to it and must select one item here.
  const value = picked === null ? stored : picked.slug;
  const pinned = stored !== "" && picked === null;
  const taggedFamily = pinned && models.length > 0;
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        className="h-8 w-full"
        aria-label="Model"
        aria-describedby={describedBy}
        // Stated on the cell rather than threaded down from the panel's one
        // error line - which names the row but cannot mark it.
        aria-invalid={stored === "" ? true : undefined}
      >
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        {pinned ? (
          <SelectItem value={stored} data-testid="fallback-model-pinned">
            {stored}
            {taggedFamily ? (
              <Badge
                variant="outline"
                className="ml-1"
                data-testid="fallback-model-family-tag"
              >
                family
              </Badge>
            ) : null}
          </SelectItem>
        ) : null}
        {models.map((model) => (
          <SelectItem key={model.slug} value={model.slug}>
            {model.label}
          </SelectItem>
        ))}
        {models.length === 0 && !pinned ? (
          // A menu with nothing in it reads as broken; a disabled line says
          // why. `value` is never selectable, so the sentinel cannot reach
          // `onValueChange`.
          <SelectItem value={NO_MODELS_VALUE} disabled>
            No models to choose from
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/**
 * The disabled placeholder item's value. Never selectable and never emitted;
 * it exists because Radix requires every item to carry a non-empty value.
 */
const NO_MODELS_VALUE = "__no-models__";

/**
 * The reasoning effort this row runs at.
 *
 * A `Select` of the levels on offer for the row's model - that model's own
 * when the Model cell names a catalog slug, the union over every model a
 * pattern matches when it names a pattern (see `fallback-catalog-options.ts`) - plus
 * "Any effort" for the `null` that means no constraint. What every other
 * effort picker in the app renders, and what replaced a free-text input that
 * accepted a misspelling and then dropped it at resolution.
 *
 * A STORED value outside the set keeps an option of its own and stays
 * selected, labelled as not offered - the same range-render rule
 * {@link HarnessSelect} and {@link ModelSelect} apply. With nothing on offer at
 * all (an older host, a harness the user no longer has, a cold catalog slot)
 * the control still renders: disabled on "Any effort" when that is the stored
 * value, since there is nothing to pick; enabled when a value IS stored, so
 * the one edit still possible - clearing it - stays possible.
 */
function EffortControl(props: {
  readonly reasoningEffort: string | null;
  readonly options: readonly AgentReasoningEffortOption[];
  readonly onCommit: (next: string | null) => void;
}): ReactNode {
  const { reasoningEffort, options, onCommit } = props;
  const stored = reasoningEffort;
  const unsupported =
    stored !== null && !options.some((option) => option.id === stored);
  return (
    <Select
      // `ANY_EFFORT_VALUE`, not "": Radix treats an empty string as "no value"
      // and would render the placeholder for a choice the user made.
      value={stored ?? ANY_EFFORT_VALUE}
      disabled={options.length === 0 && stored === null}
      onValueChange={(next) => {
        onCommit(next === ANY_EFFORT_VALUE ? null : next);
      }}
    >
      <SelectTrigger className="h-8 w-full" aria-label="Effort">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY_EFFORT_VALUE}>Any effort</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
        {unsupported ? (
          <SelectItem value={stored} data-testid="fallback-effort-unsupported">
            {stored} - not offered here
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/**
 * The Select's stand-in for `null`.
 *
 * A sentinel rather than the empty string because Radix's `Select` reads `""`
 * as "nothing selected" and falls back to the placeholder, which would make a
 * deliberate "no effort constraint" look like an unanswered field. It never
 * reaches the wire - `onValueChange` maps it back to `null` - and it cannot
 * collide with a real level id, which the catalog draws from a provider's own
 * vocabulary.
 */
const ANY_EFFORT_VALUE = "__any-effort__";

/**
 * Which provider this row's model runs on.
 *
 * Offers the GUI-capable harnesses only: the tier rung skips anything else with
 * `harness-not-gui`, so a terminal-only vendor here would be a row the user can
 * choose and the engine will never walk.
 *
 * A stored id outside that set still gets an option of its own and stays
 * selected - the same range-render rule the timings use, and for the same
 * reason: silently rewriting a stored value on a page someone only opened to
 * read is worse than showing them what is actually saved.
 */
function HarnessSelect(props: {
  readonly harnessId: TierCandidate["harnessId"];
  readonly onChange: (next: TierCandidate["harnessId"]) => void;
}): ReactNode {
  const { harnessId, onChange } = props;
  // `safeParse` rather than `options.includes(harnessId)`: the candidate's
  // harness is the WIDER vendor union on the wire, so `includes` on the narrow
  // GUI array does not type-check - and the parse is the same question asked
  // properly.
  const options: ReadonlyArray<TierCandidate["harnessId"]> =
    guiHarnessIdSchema.safeParse(harnessId).success
      ? guiHarnessIdSchema.options
      : [harnessId, ...guiHarnessIdSchema.options];
  return (
    <Select
      value={harnessId}
      onValueChange={(next) => {
        // The trigger only ever emits a value from `options`, so this parse
        // cannot fail in practice - it is here because the alternative is a
        // cast, and the type rules forbid one. A rejected value leaves the row
        // untouched rather than writing something the schema would refuse.
        const parsed = guiHarnessIdSchema.safeParse(next);
        if (!parsed.success) return;
        onChange(parsed.data);
      }}
    >
      <SelectTrigger className="h-8 w-full" aria-label="Provider">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {harnessLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MoveButton(props: {
  readonly direction: "up" | "down";
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  const { direction, disabled, onClick } = props;
  const Icon = direction === "up" ? ArrowUp : ArrowDown;
  return (
    <Button
      size="inline"
      type="button"
      variant="muted"
      // A touch target where the rows stack (the Capacitor shell), the
      // table's compact button where they do not.
      className="size-8 @2xl:size-7"
      disabled={disabled}
      aria-label={direction === "up" ? "Move up" : "Move down"}
      onClick={onClick}
    >
      <Icon className="size-3.5" aria-hidden />
    </Button>
  );
}
