import { useId, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { toast } from "sonner";
import {
  tierRungSkipReasonSchema,
  type TierCandidate,
  type TierCandidatePreview,
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
   * The group's rows WITH their client-side identities.
   *
   * The card never sees the bare wire shape, because every row it renders needs
   * a key and `TierCandidate` has no id to give it - see
   * `fallback-tier-group-keys.ts` for why content and index both fail.
   */
  readonly group: KeyedGroup;
  /**
   * Whether this group is the policy's default - the one the "equivalent
   * model" step uses for a model that is in no group. Decided by the editor
   * (it owns the policy field) and only DISPLAYED here, so a rename that
   * carries the marker and a delete that clears it have one owner.
   */
  readonly isDefault: boolean;
  /**
   * The preview rows for THIS group, or `null` when no preview is available -
   * an older host, or the read has not landed. `null` renders nothing rather
   * than an optimistic guess: the whole point of the preview is that only the
   * host can say what a family resolves to.
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
  /** A text keystroke: the draft moves, nothing is saved. */
  readonly onChange: (next: KeyedGroup) => void;
  /** A completed edit, to save - every control but a text field, and a text
   * field's blur or Enter. */
  readonly onCommit: (next: KeyedGroup) => void;
  readonly onDelete: () => void;
  /** The inverse of a row removal, for the panel to apply to the current draft. */
  readonly onUndo: (inverse: FallbackGroupsInverse) => void;
  /**
   * The harness a NEW row starts on when this group has no row to copy from.
   *
   * Never null: a group whose rows were all removed must still be able to
   * regain one, and that state is reachable by ordinary editing. The editor
   * supplies the user's own first harness where there is one and
   * {@link SEED_HARNESS_ID} otherwise.
   */
  readonly defaultHarnessId: TierCandidate["harnessId"];
}

/**
 * One model group: a name, and the models the user is declaring interchangeable.
 *
 * Candidate ORDER is load-bearing - the tier rung walks it and takes the first
 * usable target - so the rows carry ▲▼ controls. Group order is not (D128
 * settles group routing by most-specific family match, not by position), which
 * is why there is no reordering at the group level: offering a control that
 * changes nothing would be worse than offering none.
 */
// ONE grid for a group's models, header included, every row joining it with
// `grid-cols-subgrid`. The shape and the reason are
// `provider-cli-candidates-section.tsx`'s: applying the same template to each
// row separately makes the rows SIBLING grids, so every column resolves
// against its own row's content and no two rows agree where a column starts.
//
// Fractional tracks rather than `auto`, for the same reason that file gives:
// an `auto` track is sized by its content, so one long model name would move
// the Effort column for every row in the group. No rem floor either - that is
// a fixed layout width, and it stops the grid shrinking inside a narrow
// settings pane instead of letting the cells truncate. The actions track is
// the one place `auto` is safe: it always holds the same three buttons.
const CANDIDATE_GRID =
  "grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.8fr)_auto]";
const CANDIDATE_ROW = "col-span-4 grid grid-cols-subgrid items-center";
// One horizontal padding for the header and every cell, so a column header
// lands exactly over its column.
const CANDIDATE_CELL_X = "px-2";

export function FallbackTierGroupCard(
  props: FallbackTierGroupCardProps,
): ReactNode {
  const {
    group,
    isDefault,
    preview,
    labelFor,
    catalog,
    onChange,
    onCommit,
    onDelete,
    onUndo,
    defaultHarnessId,
  } = props;
  // An explicit length check rather than `candidates[0]?.harnessId`: a new row
  // copies the group's own first harness when there is one, and only an emptied
  // group falls back to the panel's default.
  const seedHarnessId =
    group.candidates.length > 0
      ? group.candidates[0].value.harnessId
      : defaultHarnessId;
  const { containerRef, focusAfterRemoval } = useRemovalFocus();
  return (
    // A NAMED container, which is AX8's half of this card. Every control
    // inside it repeats a label the panel uses several times over - "Provider",
    // "Model", "Effort", "Move up" - so with two groups on screen the
    // accessible names alone cannot say which group is being changed, and with
    // two rows in one group they cannot say which row. The names are right; the
    // RELATIONSHIPS were missing.
    //
    // Naming the container rather than qualifying every control is the ARIA
    // answer and the cheaper one: group context is announced on entry and then
    // stays out of the way, where "Model, row 2, group fast" would be read on
    // every field. It also leaves every existing accessible-name query in the
    // tree working.
    //
    // `aria-label` rather than `aria-labelledby` pointing at the name field:
    // the group's name is an editable INPUT, and an input is not a label - its
    // own accessible name is "Group name". Computed from the current value, so
    // it follows a rename.
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
          aria-label="Group name"
          className="h-8 w-full max-w-[22ch]"
          onChange={(event) => {
            onChange({ ...group, id: event.target.value });
          }}
          // The group already carries the keystrokes, so committing it as it
          // stands is committing what is on screen.
          {...commitOnLeave(() => {
            onCommit(group);
          })}
        />
        {/* A pill, not a control: the default is chosen ONCE, above the list,
            and a per-card toggle would be N controls for one policy field
            that only one card can hold at a time. The pill is what tells a
            reader scanning the cards which group unlisted models land in. */}
        {isDefault ? (
          <Badge variant="secondary" data-testid="fallback-tier-group-default">
            Default
          </Badge>
        ) : null}
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          className="h-8 px-2 text-ui-sm text-muted-foreground"
          // Addressed by the editor's focus handoff after a sibling group is
          // deleted - by this group's DRAFT KEY, never by its editable name.
          {...{ [FALLBACK_GROUP_DELETE_ATTRIBUTE]: group.draftKey }}
          onClick={onDelete}
        >
          Delete group
        </Button>
      </div>
      {/* A table, not a stack of cards. Each model is one row of three named
          columns, so a group reads down its Provider column instead of being
          re-read per model - which is what four stacked lines per model cost.
          Plain `div`s rather than `ul`/`li`: subgrid needs each row to be a
          direct child of the one grid, and every row already names itself
          `role="group"`. */}
      <div
        className={cn(
          "mt-3 overflow-hidden rounded-md border border-border/60",
          CANDIDATE_GRID,
        )}
      >
        <div
          className={cn(
            CANDIDATE_ROW,
            "border-b border-border/40 bg-foreground/3 py-1.5 text-ui-xs font-medium text-muted-foreground",
          )}
        >
          <span className={CANDIDATE_CELL_X}>Provider</span>
          <span className={CANDIDATE_CELL_X}>Model</span>
          <span className={CANDIDATE_CELL_X}>Effort</span>
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
            // The row's identity, threaded so its Remove button can be
            // ADDRESSED by a sibling's focus handoff. Not the index: after a
            // removal the indices shift, which is precisely the moment the
            // handoff runs.
            removeKey={candidate.key}
            index={index}
            candidateCount={group.candidates.length}
            preview={previewFor(preview, index)}
            labelFor={labelFor}
            catalog={catalog}
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
              // place, its neighbour if this was the last, or "Add a model"
              // once the group is empty.
              focusAfterRemoval([
                ...candidateRemoveSelectors(group.candidates, index),
                `[${FALLBACK_ADD_MODEL_ATTRIBUTE}]`,
              ]);
              // Read before the commit, for the reason spelled out at the
              // group-level removal in `fallback-tier-groups-editor.tsx`:
              // reading it inside the Undo callback would sample the
              // generation at Undo time and always compare equal.
              const generation = tierGroupIdentityGeneration();
              onCommit({
                ...group,
                candidates: group.candidates.filter((_, at) => at !== index),
              });
              // The INVERSE of this one removal, applied to the draft as it
              // stands when Undo is pressed - not this group as it stands
              // now, which is a snapshot that would also revert whatever the
              // user changed while the toast was up. `candidate` carries its
              // own key, so the row comes back as the same row rather than a
              // lookalike, at the index it held: its position is load-bearing
              // (the rung walks this order) and is the one thing a user
              // cannot recover by retyping.
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
        type="button"
        variant="link"
        className="mt-2 h-auto p-0 text-ui-sm"
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
              // schema requires a non-empty trimmed family), which is the
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
        Add a model
      </Button>
    </div>
  );
}

/**
 * The group container's accessible name.
 *
 * A blank name is a state the user can reach and hold - the draft is invalid
 * until they type one, and the group stays on screen meanwhile - so the label
 * has to work without it. "Unnamed model group" rather than a position,
 * deliberately: the position is what the VALIDATION message uses ("Group 2
 * needs a name"), and the two sentences are heard together, so the container
 * saying nothing about which one it is sends the reader to the error line that
 * does.
 */
function groupContainerLabel(id: string): string {
  return id.trim() === "" ? "Unnamed model group" : `Model group ${id}`;
}

/**
 * How a row's model is NAMED in copy that is not the cell itself: the removal
 * toast and the Remove button's accessible name. The catalog label when the
 * stored value is a slug the catalog knows ("Claude Opus 5"), the stored
 * value otherwise - a family name is already the user's word for it.
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
 * The NEXT row before the previous one, for the same reason as the group-level
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
 * still reads as an `<Input>` with an `onChange`. The group name is the only
 * text field left on the card - the Model and Effort cells are selects, which
 * commit on their own interaction - but the shape is kept so a second text
 * field cannot accidentally get one handler and not the other.
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
 * a flat list over every group and carries its own index - a positional read
 * would silently pair a row with another group's verdict the moment the host
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
  readonly removeKey: string;
  readonly index: number;
  readonly candidateCount: number;
  readonly preview: TierCandidatePreview | null;
  readonly labelFor: FallbackSettingsProfileLabel;
  readonly catalog: FallbackCatalogOptions;
  readonly onCommit: (next: TierCandidate) => void;
  readonly onMove: (toIndex: number) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const {
    candidate,
    removeKey,
    index,
    candidateCount,
    preview,
    labelFor,
    catalog,
    onCommit,
    onMove,
  } = props;
  const models = catalog.modelsFor(candidate.harnessId);
  const modelId = useId();
  const previewId = useId();
  const verdict = previewSentence(candidate, preview, models, labelFor);
  return (
    // The row's own named container, nested inside the group's (AX8). "Model 1"
    // is the same way the validation copy names a row
    // (`fallback-policy-draft.ts`'s `candidateSubject`), so the container and
    // the error line agree about what to call it - which is the whole point of
    // naming it at all.
    //
    // Position and not the model: the model is the cell that is blank in the
    // case this matters most, so naming the row by it produces "the model
    // called “”".
    <div
      role="group"
      aria-label={`Model ${index + 1}`}
      className={cn(
        CANDIDATE_ROW,
        "border-b border-border/40 py-2 last:border-b-0",
      )}
    >
      <div className={cn("min-w-0", CANDIDATE_CELL_X)}>
        <HarnessSelect
          harnessId={candidate.harnessId}
          // A select produces a complete value per interaction, so it commits
          // immediately - the blur rule is about text, not about controls.
          //
          // The MODEL is cleared with the provider: a slug is meaningful on
          // one catalog only, and carrying "claude-opus-5" onto Codex would
          // save a row the engine can never match. The effort goes with it
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
      <div className={cn("min-w-0", CANDIDATE_CELL_X)}>
        <ModelSelect
          id={modelId}
          modelFamily={candidate.modelFamily}
          models={models}
          // The verdict line below is what this cell resolves to, so it is
          // this cell's DESCRIPTION (AX8). Dropped when there is no verdict
          // rather than pointing at an element that is not rendered: a
          // dangling `aria-describedby` is a promise of detail with nothing
          // behind it, and the absence is itself meaningful here (D159).
          describedBy={verdict === null ? undefined : previewId}
          onChange={(next) => {
            // Picking a different model keeps the effort only while the new
            // model offers it; a level that was valid for the old model and
            // is not for this one would otherwise be saved and then dropped
            // at resolution, which is the defect the select replaced.
            const efforts = catalog.effortsFor(candidate.harnessId, next);
            const keepsEffort =
              candidate.reasoningEffort !== null &&
              efforts.some((option) => option.id === candidate.reasoningEffort);
            onCommit({
              ...candidate,
              modelFamily: next,
              reasoningEffort: keepsEffort ? candidate.reasoningEffort : null,
            });
          }}
        />
      </div>
      <div className={cn("min-w-0", CANDIDATE_CELL_X)}>
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
      <div className={cn("flex items-center", CANDIDATE_CELL_X)}>
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
          type="button"
          variant="ghost"
          className="size-7 p-0 text-muted-foreground"
          aria-label={`Remove ${candidate.modelFamily.trim() === "" ? "model" : candidateDisplayName(candidate, catalog)}`}
          {...{ [FALLBACK_CANDIDATE_REMOVE_ATTRIBUTE]: removeKey }}
          onClick={props.onRemove}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      {/* The row's fifth child, so it auto-places onto a second internal line
          starting under Model - the column it is about. It costs no wrapper:
          the row is already `col-span-4 grid grid-cols-subgrid`. */}
      {verdict === null ? null : (
        <p
          id={previewId}
          className={cn(
            "col-start-2 col-span-3 mt-1 px-2 text-ui-xs",
            verdict.unmatched ? "text-destructive" : "text-muted-foreground",
          )}
          data-testid="fallback-tier-candidate-preview"
          data-unmatched={verdict.unmatched ? "true" : undefined}
        >
          {verdict.text}
        </p>
      )}
    </div>
  );
}

/**
 * Which model this row names.
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
 * when the Model cell names a catalog slug, the union across the harness's
 * models when it names a family (see `fallback-catalog-options.ts`) - plus
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
      type="button"
      variant="ghost"
      className="size-7 p-0 text-muted-foreground"
      disabled={disabled}
      aria-label={direction === "up" ? "Move up" : "Move down"}
      onClick={onClick}
    >
      <Icon className="size-3.5" aria-hidden />
    </Button>
  );
}

/**
 * What the row's verdict line says, or `null` when it has nothing to add.
 *
 * The reason the verdict is an RPC and not a client-side computation: resolving
 * a family to a slug needs the live model catalog, the provider's enabled and
 * runnable state, and which account would run it - none of which the renderer
 * has, and all of which the engine already walks. A second implementation here
 * would offer targets the engine skips and drift on every engine change.
 *
 * ## Only when informative
 *
 * The line used to print "resolves to <slug>" under every row. Now that the
 * Model cell shows a catalog model by name, a line saying the model resolves
 * to itself is noise under every row, and it buried the two cases the line
 * exists for. It renders exactly when:
 *
 *  - the row names a FAMILY and the host says which model it means today
 *    ("matches Claude Opus 5 today on Work") - the catalog label where the
 *    catalog knows the slug, the slug otherwise;
 *  - the host could not resolve it, in which case `skipLabel` is what gets
 *    rendered, so a reason a released client has never heard of still prints a
 *    sentence instead of blanking the row. `skipReason` is parsed only to
 *    decide the TONE, which is the split the protocol's own doc prescribes for
 *    an open reason field: parse to branch, fall back to the label when it does
 *    not match;
 *  - the host attached warnings, whichever way it resolved.
 *
 * Only `family-unmatched` is red. It is the one verdict that says the USER's
 * row is wrong - they named a family nothing matches, and it will never fire
 * until they change it. Every other skip is environmental (a provider turned
 * off, a signed-out account, an unreadable catalog): true right now, not the
 * user's authoring error, and colouring those red would train people to ignore
 * the colour on the row that actually needs it. The row is never auto-removed
 * either way; it stays and says why.
 *
 * The ACCOUNT'S NAME, never its id. `profileId` is a managed-profile uuid, and
 * printing it produced "resolves to gpt-5.6-sol on 3f2a9c1e-…" - the D118
 * defect, on the one surface whose job is to say what a row will do. `null`
 * still omits the clause rather than naming an account: here it means the
 * preview has no particular one to report, which is not the chat cards'
 * "Terminal account".
 */
function previewSentence(
  candidate: TierCandidate,
  preview: TierCandidatePreview | null,
  models: readonly GuiAgentModelOption[],
  labelFor: FallbackSettingsProfileLabel,
): { readonly text: string; readonly unmatched: boolean } | null {
  if (preview === null) return null;
  const warnings = preview.warnings.map((warning) => ` - ${warning}`).join("");
  const resolved = preview.resolvedModel;
  if (resolved === null) {
    const parsedReason =
      preview.skipReason === null
        ? null
        : tierRungSkipReasonSchema.safeParse(preview.skipReason);
    const unmatched =
      parsedReason !== null &&
      parsedReason.success &&
      parsedReason.data === "family-unmatched";
    return {
      text: `${preview.skipLabel ?? "not available"}${warnings}`,
      unmatched,
    };
  }
  // The cell already names this model: nothing to add unless the host did.
  const namesItself =
    candidate.modelFamily.trim().toLowerCase() === resolved.toLowerCase();
  if (namesItself) {
    return warnings === ""
      ? null
      : { text: warnings.slice(3), unmatched: false };
  }
  const label = catalogModelForFamily(models, resolved)?.label ?? resolved;
  const account =
    preview.profileId === null ? "" : ` on ${labelFor(preview.profileId)}`;
  return {
    text: `matches ${label} today${account}${warnings}`,
    unmatched: false,
  };
}
