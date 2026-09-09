import { type KeyboardEvent, type ReactNode } from "react";
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
import type { AgentReasoningEffortOption } from "@traycer/protocol/host/index";
import type { FallbackEffortOptions } from "@/components/settings/panels/fallback/fallback-effort-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { harnessDisplayName } from "@/components/session-import/session-import-model";
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
   * The effort levels a harness advertises. Threaded like `labelFor` rather
   * than resolved per card: one catalog read serves every row.
   */
  readonly effortOptions: FallbackEffortOptions;
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
export function FallbackTierGroupCard(
  props: FallbackTierGroupCardProps,
): ReactNode {
  const {
    group,
    preview,
    labelFor,
    effortOptions,
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
    <div
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
      <ul className="mt-3 flex flex-col gap-2">
        {group.candidates.map((candidate, index) => (
          // The row's own client-side identity, assigned once when it entered
          // the draft. Not the index (these rows reorder, and an index key
          // makes React reuse the node at a position rather than follow the
          // row, so a move keeps the input the user is typing in while its data
          // changes underneath) and not the content (two rows may legitimately
          // hold the same values - two fresh rows both start empty).
          <li key={candidate.key}>
            <CandidateRow
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
              effortOptions={effortOptions}
              onChange={(next) => {
                onChange(withCandidateAt(group, index, next));
              }}
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
                  `Removed ${candidate.value.modelFamily.trim() === "" ? "the empty row" : `“${candidate.value.modelFamily}”`}`,
                  {
                    action: {
                      label: "Undo",
                      onClick: () => {
                        onUndo({
                          kind: "candidate",
                          groupDraftKey: group.draftKey,
                          candidate,
                          index,
                        });
                      },
                    },
                  },
                );
              }}
            />
          </li>
        ))}
      </ul>
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
              // A new row starts with an EMPTY family rather than a plausible
              // one. The draft is invalid until the user types it (the wire
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
 * still reads as an `<Input>` with an `onChange`, and adding a third text field
 * cannot accidentally get one handler and not the other.
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
 * The key travels with the row through an edit: changing a family name is the
 * same row, not a new one, and minting a fresh key here would remount the input
 * on every keystroke - the exact bug the identities exist to prevent.
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
  readonly effortOptions: FallbackEffortOptions;
  readonly onChange: (next: TierCandidate) => void;
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
    effortOptions,
    onChange,
    onCommit,
    onMove,
  } = props;
  // Both text fields commit the candidate AS IT STANDS: `candidate` is a prop,
  // so it already carries every keystroke this handler could be committing.
  const commitCurrent = commitOnLeave(() => {
    onCommit(candidate);
  });
  return (
    <div className="rounded-md bg-foreground/3 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <HarnessSelect
          harnessId={candidate.harnessId}
          // A select produces a complete value per interaction, so it commits
          // immediately - the blur rule is about text, not about controls.
          onChange={(next) => {
            onCommit({ ...candidate, harnessId: next });
          }}
        />
        <Input
          value={candidate.modelFamily}
          aria-label="Model family"
          placeholder="opus"
          className="h-8 w-full max-w-[18ch]"
          onChange={(event) => {
            onChange({ ...candidate, modelFamily: event.target.value });
          }}
          {...commitCurrent}
        />
        <EffortControl
          reasoningEffort={candidate.reasoningEffort}
          options={effortOptions(candidate.harnessId)}
          onChange={(next) => {
            onChange({ ...candidate, reasoningEffort: next });
          }}
          onCommit={(next) => {
            onCommit({ ...candidate, reasoningEffort: next });
          }}
          commitCurrent={commitCurrent}
        />
        <div className="flex-1" />
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
          aria-label={`Remove ${candidate.modelFamily || "model"}`}
          {...{ [FALLBACK_CANDIDATE_REMOVE_ATTRIBUTE]: removeKey }}
          onClick={props.onRemove}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      <CandidatePreviewLine preview={preview} labelFor={labelFor} />
    </div>
  );
}

/**
 * The reasoning effort this row runs at.
 *
 * A `Select` of the levels the harness's own models advertise, which is what
 * the agreed UX specified and what every other effort picker in the app
 * renders. It replaced an unrestricted text input whose only hint was a
 * placeholder: a user had to know a provider-specific spelling already, and a
 * typo was accepted, saved as policy, and then silently dropped at resolution -
 * so the value on screen did not mean the effort the fallback would run at.
 *
 * Two states, decided by whether any levels are ADVERTISED - which is not the
 * same distinction the comment here used to draw. It described "no answer"
 * versus "an answer that happens to be empty" as if the control could tell them
 * apart; it cannot. The lookup returns an array, and a harness that advertises
 * nothing and a harness nothing is known about both arrive as an empty one. So
 * the rule this implements, and the rule D207 states, is the weaker and true
 * one: with no levels on offer, free text is accepted.
 *
 *  - **levels are advertised.** A `Select` of them, plus "Any effort" for the
 *    `null` that means no constraint. A STORED value outside the set keeps an
 *    option of its own and stays selected, labelled as not offered - the same
 *    rule {@link HarnessSelect} applies to an unknown harness, and for the same
 *    reason: silently rewriting a stored value on a page someone opened to read
 *    is worse than showing them what is actually saved.
 *  - **none are** - an older host, a harness the user no longer has, a cold
 *    catalog slot, or a harness that genuinely offers none. The text input
 *    stands, because a `Select` built from nothing would offer only "Any
 *    effort" and would take away a level the user can legitimately type.
 */
function EffortControl(props: {
  readonly reasoningEffort: string | null;
  readonly options: readonly AgentReasoningEffortOption[];
  readonly onChange: (next: string | null) => void;
  readonly onCommit: (next: string | null) => void;
  /** The blur/Enter props the text fallback shares with the family input. */
  readonly commitCurrent: {
    readonly onBlur: () => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  };
}): ReactNode {
  const { reasoningEffort, options, onChange, onCommit, commitCurrent } = props;
  if (options.length === 0) {
    return (
      <Input
        value={reasoningEffort ?? ""}
        aria-label="Effort"
        placeholder="any effort"
        className="h-8 w-full max-w-[14ch]"
        onChange={(event) => {
          // Empty means "no effort constraint", which the wire encodes as
          // `null` - NOT as an empty string, which the schema refuses. The
          // control cannot express the refused value at all, so this is the
          // one normalisation worth doing at the edit site.
          const next = event.target.value;
          onChange(next.trim() === "" ? null : next);
        }}
        {...commitCurrent}
      />
    );
  }
  const stored = reasoningEffort;
  const unsupported =
    stored !== null && !options.some((option) => option.id === stored);
  return (
    <Select
      // `ANY_EFFORT_VALUE`, not "": Radix treats an empty string as "no value"
      // and would render the placeholder for a choice the user made.
      value={stored ?? ANY_EFFORT_VALUE}
      onValueChange={(next) => {
        onCommit(next === ANY_EFFORT_VALUE ? null : next);
      }}
    >
      <SelectTrigger className="h-8 w-full max-w-[16ch]" aria-label="Effort">
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
      <SelectTrigger className="h-8 w-full max-w-[16ch]" aria-label="Provider">
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

/**
 * "Claude Code" for a GUI harness, the raw id for anything else.
 *
 * `harnessDisplayName` takes the GUI union, and a stored candidate may name a
 * vendor outside it. Printing the id is the honest fallback: it is what is
 * saved, and inventing a friendly name for a harness this surface cannot
 * describe would be a label with nothing behind it.
 */
function harnessLabel(harnessId: TierCandidate["harnessId"]): string {
  const parsed = guiHarnessIdSchema.safeParse(harnessId);
  return parsed.success ? harnessDisplayName(parsed.data) : harnessId;
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
 * What this row resolves to right now, in the host's words.
 *
 * The reason this is an RPC and not a client-side computation: resolving a
 * family to a slug needs the live model catalog, the provider's enabled and
 * runnable state, and which account would run it - none of which the renderer
 * has, and all of which the engine already walks. A second implementation here
 * would offer targets the engine skips and drift on every engine change.
 *
 * `skipLabel` is always what gets RENDERED, so a reason a released client has
 * never heard of still prints a sentence instead of blanking the row. The
 * `skipReason` is parsed only to decide the TONE, which is the split the
 * protocol's own doc prescribes for an open reason field: parse to branch, fall
 * back to the label when it does not match.
 *
 * Only `family-unmatched` is red. It is the one verdict that says the USER's
 * row is wrong - they named a family nothing matches, and it will never fire
 * until they change it. Every other skip is environmental (a provider turned
 * off, a signed-out account, an unreadable catalog): true right now, not the
 * user's authoring error, and colouring those red would train people to ignore
 * the colour on the row that actually needs it. The row is never auto-removed
 * either way; it stays and says why.
 */
function CandidatePreviewLine(props: {
  readonly preview: TierCandidatePreview | null;
  readonly labelFor: FallbackSettingsProfileLabel;
}): ReactNode {
  const { preview, labelFor } = props;
  if (preview === null) return null;
  const resolved = preview.resolvedModel;
  const parsedReason =
    preview.skipReason === null
      ? null
      : tierRungSkipReasonSchema.safeParse(preview.skipReason);
  const unmatchedFamily =
    parsedReason !== null &&
    parsedReason.success &&
    parsedReason.data === "family-unmatched";
  return (
    <p
      className={cn(
        "mt-1.5 text-ui-xs",
        unmatchedFamily ? "text-destructive" : "text-muted-foreground",
      )}
      data-testid="fallback-tier-candidate-preview"
      data-unmatched={unmatchedFamily ? "true" : undefined}
    >
      {resolved === null ? (
        <span>{preview.skipLabel ?? "not available"}</span>
      ) : (
        <span>
          resolves to <span className="text-foreground">{resolved}</span>
          {/* The ACCOUNT'S NAME, never its id. `profileId` is a managed-profile
              uuid, and printing it produced "resolves to gpt-5.6-sol on
              3f2a9c1e-…" - the D118 defect, on the one surface whose job is to
              say what a row will do. `null` still omits the clause rather than
              naming an account: here it means the preview has no particular one
              to report, which is not the chat cards' "Terminal account". */}
          {preview.profileId === null
            ? null
            : ` on ${labelFor(preview.profileId)}`}
        </span>
      )}
      {preview.warnings.map((warning) => (
        <span key={warning}> - {warning}</span>
      ))}
    </p>
  );
}
