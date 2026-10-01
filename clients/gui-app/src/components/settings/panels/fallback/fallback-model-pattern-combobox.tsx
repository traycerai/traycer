import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronsUpDown, SearchIcon } from "lucide-react";
import {
  modelMatchesPattern,
  type TierCandidate,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import type { GuiAgentModelOption } from "@traycer/protocol/host/index";
import { catalogModelForFamily } from "@/components/settings/panels/fallback/fallback-catalog-options";
import {
  anyProviderModelLabel,
  blockedPatternExample,
  buildPatternPicker,
  isAnyModelPattern,
  isModelPattern,
  modelCountLabel,
  modelOwnedReason,
  otherTierClaims,
  patternBlockedReason,
  patternMatchCount,
  patternOfferDetail,
  pickerEntryBlocked,
  tierDisplayName,
  type PatternPickerEntry,
  type PatternPickerModelEntry,
  type PatternPickerPatternEntry,
  type TierClaim,
} from "@/components/settings/panels/fallback/fallback-model-patterns";
import { FallbackPatternGlyph } from "@/components/settings/panels/fallback/fallback-pattern-glyph";
import { FALLBACK_CANDIDATE_MODEL_ATTRIBUTE } from "@/components/settings/panels/fallback/fallback-removal-focus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCoarsePointerOpenAutoFocus } from "@/hooks/ui/use-coarse-pointer-open-autofocus";
import { cn } from "@/lib/utils";

export interface FallbackModelPatternComboboxProps {
  readonly id: string;
  /** The row's draft key, so another row's "Go to the <tier> row" can focus this cell. */
  readonly rowKey: string;
  /** The stored value: a pattern, one exact model, or blank for a new row. */
  readonly modelFamily: string;
  readonly harnessId: TierCandidate["harnessId"];
  /** "Codex" - how the list heading and the empty line name the provider. */
  readonly providerLabel: string;
  /** The provider's catalog, or `null` while it has not answered. */
  readonly models: readonly GuiAgentModelOption[] | null;
  /**
   * The whole draft's tiers and this row's place in them - what the picker
   * checks "one model, one tier" against, through the protocol's
   * `findTierConflicts`.
   */
  readonly groups: readonly TierGroup[];
  readonly groupIndex: number;
  readonly candidateIndex: number;
  /** How many models this row's existing conflicts cover; `0` for none. */
  readonly conflictCount: number;
  /** The row's status line, when it renders one (AX8). */
  readonly describedBy: string | undefined;
  /** A choice: the pattern or the exact slug to store. */
  readonly onChange: (next: string) => void;
  /**
   * Says a refusal through the editor's existing live region - Enter on an
   * option the one-model-one-tier rule refuses.
   */
  readonly onAnnounce: (text: string) => void;
}

/**
 * The Model cell on a host that reads rows as patterns: one combobox for
 * "pick a model" and "type a pattern".
 *
 * Picking a listed model stores its SLUG, exactly as the select it replaced
 * did. Typing is what the select could not offer, and the Enter rule is the
 * spec's (§Wireframe 2): text that exactly equals a model's ID or name puts
 * that model first; otherwise a typed `*` builds a pattern as written, and a
 * plain word of three or more characters becomes "Any model containing …",
 * saved as `*word*`. The catalog lists under it in the provider's order, which
 * is the order a pattern tries its matches, and a match is numbered by it.
 *
 * ## One model, one tier, at the picker
 *
 * A choice that would put a model in a second tier cannot be made: the pattern
 * option that reaches one, and a model another tier owns, are `aria-disabled`
 * with the reason as their description, and Enter on one says the reason
 * through the editor's live region instead of choosing anything. A conflict
 * that exists anyway (a new release, a stored policy) is the row's to draw -
 * see `fallback-tier-group-card.tsx` - and is never refused here or anywhere
 * else.
 *
 * ## Why the keyboard is driven here and not by cmdk
 *
 * A refused option must still be REACHABLE: it is what Enter lands on after
 * typing `gpt-6-*`, and it has to say why. cmdk treats `aria-disabled` and
 * "can be highlighted" as one thing - its arrow keys and its auto-highlight
 * both skip a disabled item - so it would highlight the first model below a
 * refused pattern, and Enter would silently pick that model. So the input is
 * this component's own (inside the `Command`, which still renders the listbox
 * and its options), the highlight is controlled, and ArrowUp/ArrowDown/Enter
 * are handled here over every visible option, refused ones included.
 *
 * ## Opened from elsewhere by a click, not by a prop
 *
 * The row's "Edit pattern" actions open this by clicking the trigger (found by
 * {@link FALLBACK_CANDIDATE_MODEL_ATTRIBUTE}), so every opening runs the one
 * path that also finds the Settings dialog to portal into - a controlled
 * `open` flipped from outside would skip it.
 */
export function FallbackModelPatternCombobox(
  props: FallbackModelPatternComboboxProps,
): ReactNode {
  const { id, rowKey, modelFamily, models, conflictCount, describedBy } = props;
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [dialogContainer, setDialogContainer] = useState<HTMLElement | null>(
    null,
  );
  const { contentRef, onOpenAutoFocus } = useCoarsePointerOpenAutoFocus();
  const face = triggerFace(
    modelFamily,
    models,
    conflictCount,
    props.providerLabel,
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Portaled into the Settings dialog when it is one, as the judge
          // model picker is, so the dialog's scroll lock and focus trap hold.
          setDialogContainer(
            triggerRef.current?.closest<HTMLElement>(
              '[data-slot="dialog-content"]',
            ) ?? null,
          );
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          // What opens is the popover - a `role="dialog"` holding the list's
          // own combobox input and listbox - so that is what this names.
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={popoverId}
          aria-label={face.accessibleName}
          aria-describedby={describedBy}
          aria-invalid={face.invalid ? true : undefined}
          className="w-full min-w-0 justify-between font-normal"
          data-testid="fallback-model-pattern-trigger"
          {...{ [FALLBACK_CANDIDATE_MODEL_ATTRIBUTE]: rowKey }}
        >
          <span className="flex min-w-0 items-center gap-2">
            {face.pattern ? (
              <FallbackPatternGlyph
                tone={
                  face.pillTone === "destructive" ? "destructive" : "accent"
                }
              />
            ) : null}
            <span
              className={cn(
                "min-w-0 truncate",
                face.pattern && "font-mono text-ui-xs",
                face.value === null && "text-muted-foreground",
              )}
            >
              {face.value ?? "Choose a model or pattern"}
            </span>
            {face.anyModel === null ? null : (
              <span className="min-w-0 truncate">{face.anyModel}</span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {face.pill === null ? null : (
              <Badge
                variant={
                  face.pillTone === "destructive" ? "destructive" : "muted"
                }
                className="rounded-full tabular-nums"
                data-testid="fallback-model-pattern-pill"
              >
                {face.pill}
              </Badge>
            )}
            <ChevronsUpDown
              className="size-3.5 text-muted-foreground"
              aria-hidden
            />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={popoverId}
        layout="bare"
        align="start"
        container={dialogContainer ?? undefined}
        collisionBoundary={dialogContainer ?? undefined}
        collisionPadding={8}
        className="w-[min(90vw,28rem)] overflow-hidden"
        ref={contentRef}
        onOpenAutoFocus={onOpenAutoFocus}
      >
        {/* Mounted only while open, so every opening starts from the stored
            value rather than from the last query. */}
        <PatternPickerBody
          popupId={popoverId}
          stored={modelFamily.trim()}
          harnessId={props.harnessId}
          providerLabel={props.providerLabel}
          models={models}
          groups={props.groups}
          groupIndex={props.groupIndex}
          candidateIndex={props.candidateIndex}
          onPick={(next) => {
            setOpen(false);
            props.onChange(next);
          }}
          onAnnounce={props.onAnnounce}
        />
      </PopoverContent>
    </Popover>
  );
}

/** What the closed cell shows, and what it is called. */
interface TriggerFace {
  /** The text in the cell, or `null` for a blank row (the placeholder shows). */
  readonly value: string | null;
  readonly pattern: boolean;
  /**
   * "Any Codex model" for a bare `*` (spec §How patterns work), drawn beside
   * the mono `*` so the row says it claims the whole provider; `null` for any
   * other value.
   */
  readonly anyModel: string | null;
  readonly pill: string | null;
  readonly pillTone: "muted" | "destructive";
  /** Blank, matching nothing, or in two tiers: a row the user has to fix. */
  readonly invalid: boolean;
  /**
   * "Model or pattern: *opus*, pattern, 2 models" - the match count pill is
   * part of the name (spec §Accessibility), so a screen-reader user hears what
   * a sighted user reads off the cell.
   */
  readonly accessibleName: string;
}

/**
 * The trigger's pill: the conflict count when the row has any - that is what
 * the user must act on - otherwise the match count for a pattern or for an
 * exact value that matches nothing. An exact pick of a listed model has none;
 * its name says it all.
 */
function triggerPill(input: {
  readonly conflictCount: number;
  readonly pattern: boolean;
  readonly unmatched: boolean;
  readonly count: number | null;
}): string | null {
  const { conflictCount, pattern, unmatched, count } = input;
  if (conflictCount === 1) return "1 conflict";
  if (conflictCount > 1) return `${conflictCount} conflicts`;
  if (pattern || unmatched) return modelCountLabel(count);
  return null;
}

/**
 * The catalog model an exact value names: by its slug, or - since a value with
 * no `*` also matches a model's whole NAME - by that name.
 */
function exactModelFor(
  stored: string,
  models: readonly GuiAgentModelOption[],
): GuiAgentModelOption | null {
  return (
    catalogModelForFamily(models, stored) ??
    models.find((model) => modelMatchesPattern(stored, model)) ??
    null
  );
}

function triggerFace(
  modelFamily: string,
  models: readonly GuiAgentModelOption[] | null,
  conflictCount: number,
  providerLabel: string,
): TriggerFace {
  const stored = modelFamily.trim();
  if (stored === "") {
    return {
      value: null,
      pattern: false,
      anyModel: null,
      pill: null,
      pillTone: "muted",
      invalid: true,
      accessibleName: "Model or pattern",
    };
  }
  const pattern = isModelPattern(stored);
  const count = patternMatchCount(stored, models);
  const unmatched = count === 0;
  const named = pattern ? null : exactModelFor(stored, models ?? []);
  const value = named === null ? stored : named.label;
  const pill = triggerPill({ conflictCount, pattern, unmatched, count });
  const pillTone = conflictCount > 0 || unmatched ? "destructive" : "muted";
  const anyModel = isAnyModelPattern(stored)
    ? anyProviderModelLabel(providerLabel)
    : null;
  const spoken = pattern ? `${anyModel ?? value}, pattern` : value;
  return {
    value,
    pattern,
    anyModel,
    pill,
    pillTone,
    invalid: unmatched || conflictCount > 0,
    accessibleName:
      pill === null
        ? `Model or pattern: ${spoken}`
        : `Model or pattern: ${spoken}, ${pill}`,
  };
}

/** The first option a query leaves visible - what Enter chooses before any arrow key. */
function firstVisibleValue(entries: readonly PatternPickerEntry[]): string {
  return entries.find((entry) => !entry.hidden)?.value ?? "";
}

/**
 * The query and highlight the list opens with.
 *
 * A stored pattern, or an exact value the catalog does not list, opens as the
 * query - so "Edit pattern" edits it, and its matches are numbered the moment
 * the list opens. A listed model opens the whole catalog with that model
 * highlighted.
 */
function openingState(input: {
  readonly stored: string;
  readonly models: readonly GuiAgentModelOption[] | null;
  readonly claims: ReadonlyMap<string, readonly TierClaim[]>;
}): { readonly query: string; readonly highlighted: string } {
  const { stored, models, claims } = input;
  const storedModel =
    stored === "" || models === null
      ? null
      : catalogModelForFamily(models, stored);
  const query = storedModel === null ? stored : "";
  const entries = buildPatternPicker({ query, models, claims });
  const chosen =
    storedModel === null
      ? undefined
      : entries.find(
          (entry) =>
            !entry.hidden &&
            entry.kind === "model" &&
            entry.model.slug === storedModel.slug,
        );
  return { query, highlighted: chosen?.value ?? firstVisibleValue(entries) };
}

/**
 * The list's query and highlight: opened by {@link openingState}, then
 * RE-SEEDED once if the provider's catalog answers while the list is open
 * (review R7).
 *
 * Opened cold, the picker cannot know `gpt-5.6-terra` is a model, so the
 * stored value becomes the query and the highlight the "contains" pattern -
 * and once the model list lands, Enter would save `*gpt-5.6-terra*` and
 * quietly turn a one-model row into a pattern. So the first render with a
 * catalog re-seeds: exactly as a fresh open would when the user has not typed
 * since, and otherwise onto the first option the current query leaves, which
 * is now the exact model when it names one.
 *
 * Adjusted during render from the previous render's fact, React's pattern for
 * state that follows a prop, rather than in an effect: an effect would paint
 * one frame with the stale highlight, and Enter in that frame is the bug.
 */
function usePickerQuery(input: {
  readonly stored: string;
  readonly models: readonly GuiAgentModelOption[] | null;
  readonly claims: ReadonlyMap<string, readonly TierClaim[]>;
}): {
  readonly query: string;
  readonly setQuery: (next: string) => void;
  readonly highlighted: string;
  readonly setHighlighted: (next: string) => void;
} {
  const { stored, models, claims } = input;
  const [opening] = useState(() => openingState({ stored, models, claims }));
  const [query, setQuery] = useState(opening.query);
  const [highlighted, setHighlighted] = useState(opening.highlighted);
  const [catalogSeen, setCatalogSeen] = useState(models !== null);
  if (!catalogSeen && models !== null) {
    setCatalogSeen(true);
    const reseeded =
      query === stored
        ? openingState({ stored, models, claims })
        : {
            query,
            highlighted: firstVisibleValue(
              buildPatternPicker({ query, models, claims }),
            ),
          };
    setQuery(reseeded.query);
    setHighlighted(reseeded.highlighted);
  }
  return { query, setQuery, highlighted, setHighlighted };
}

/** What the pattern option says about the list around it this render. */
function pickerPatternState(
  entries: readonly PatternPickerEntry[],
  query: string,
): {
  /** The pattern option is on offer (visible). */
  readonly patternOffered: boolean;
  /** ...and the one-model-one-tier rule refuses it. */
  readonly patternBlocked: boolean;
  /**
   * The pattern option while the user is TYPING a pattern (a `*`) - the one
   * case the input row counts its reach.
   */
  readonly typedPatternEntry: PatternPickerPatternEntry | null;
  /** A narrower, choosable pattern to suggest for a refused one. */
  readonly narrowExample: string | null;
} {
  const entry = entries.find(
    (candidate): candidate is PatternPickerPatternEntry =>
      candidate.kind === "pattern" && !candidate.hidden,
  );
  if (entry === undefined) {
    return {
      patternOffered: false,
      patternBlocked: false,
      typedPatternEntry: null,
      narrowExample: null,
    };
  }
  const blocked = pickerEntryBlocked(entry);
  return {
    patternOffered: true,
    patternBlocked: blocked,
    typedPatternEntry: isModelPattern(query) ? entry : null,
    narrowExample: blocked ? blockedPatternExample(entry) : null,
  };
}

/**
 * How far a typed pattern reaches, beside what is being typed (wireframe 2) -
 * a refused option hides its own count, so without this a blocked pattern's
 * reach is shown nowhere.
 */
function PatternInputCount(props: {
  readonly entry: PatternPickerPatternEntry;
  readonly blocked: boolean;
}): ReactNode {
  const { entry, blocked } = props;
  return (
    <span
      className={cn("text-ui-xs tabular-nums", blocked && "text-destructive")}
      data-testid="fallback-model-pattern-input-count"
    >
      {modelCountLabel(entry.matches === null ? null : entry.matches.length)}
    </span>
  );
}

/** The line under the list: how to choose, or how to get past a refusal. */
function PickerHint(props: {
  readonly blocked: boolean;
  readonly example: string | null;
}): ReactNode {
  const { blocked, example } = props;
  if (!blocked) {
    return (
      <p className="border-t border-border/40 px-3 py-2 text-ui-xs text-muted-foreground">
        Pick one model to use exactly that one, or save a pattern to cover every
        match. Typing a model&apos;s exact name puts it first instead.
      </p>
    );
  }
  return (
    <p className="border-t border-border/40 px-3 py-2 text-ui-xs text-destructive">
      Narrow it
      {example === null ? null : (
        <>
          {" "}
          (for example <code className="font-mono">{example}</code>)
        </>
      )}
      , or move those models out of their tiers first. * matches anything,
      checked against each model&apos;s name and ID.
    </p>
  );
}

function PatternPickerBody(props: {
  /** The popover's id - the input's `aria-controls` until the listbox's own is known. */
  readonly popupId: string;
  readonly stored: string;
  readonly harnessId: TierCandidate["harnessId"];
  readonly providerLabel: string;
  readonly models: readonly GuiAgentModelOption[] | null;
  readonly groups: readonly TierGroup[];
  readonly groupIndex: number;
  readonly candidateIndex: number;
  readonly onPick: (next: string) => void;
  readonly onAnnounce: (text: string) => void;
}): ReactNode {
  const {
    popupId,
    stored,
    harnessId,
    providerLabel,
    models,
    groups,
    groupIndex,
    candidateIndex,
    onPick,
    onAnnounce,
  } = props;
  // Computed while the picker is open and never per row render: it walks every
  // tier's rows against the whole catalog.
  const claims = useMemo<ReadonlyMap<string, readonly TierClaim[]>>(
    () =>
      models === null
        ? new Map()
        : otherTierClaims({
            groups,
            groupIndex,
            candidateIndex,
            harnessId,
            catalog: models,
          }),
    [models, groups, groupIndex, candidateIndex, harnessId],
  );
  const { query, setQuery, highlighted, setHighlighted } = usePickerQuery({
    stored,
    models,
    claims,
  });
  const entries = useMemo(
    () => buildPatternPicker({ query, models, claims }),
    [query, models, claims],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = entries.filter((entry) => !entry.hidden);
  const { patternOffered, patternBlocked, typedPatternEntry, narrowExample } =
    pickerPatternState(entries, query);

  // The input's `aria-activedescendant` and `aria-controls` point at ids cmdk
  // mints for its own listbox and options, which exist only once they are in
  // the DOM. Written straight onto the input rather than through state: they
  // mirror another library's DOM, and a state round-trip would render twice
  // per arrow key to say what the DOM already knows. The same pass keeps the
  // highlighted option scrolled into view, which cmdk does only for the moves
  // it makes itself.
  useLayoutEffect(() => {
    const input = inputRef.current;
    const list = listRef.current;
    if (input === null || list === null) return;
    input.setAttribute("aria-controls", list.id);
    const active = [...list.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
      (item) => !item.hidden && item.getAttribute("data-value") === highlighted,
    );
    if (active === undefined || highlighted === "") {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }, [highlighted, entries]);

  const choose = (entry: PatternPickerEntry): void => {
    if (entry.kind === "pattern") {
      if (entry.blockers.length > 0) {
        onAnnounce(patternBlockedReason(entry.blockers));
        return;
      }
      onPick(entry.pattern);
      return;
    }
    if (entry.owners.length > 0) {
      onAnnounce(modelOwnedReason(entry.model, entry.owners));
      return;
    }
    onPick(entry.model.slug);
  };

  const move = (delta: 1 | -1): void => {
    if (visible.length === 0) return;
    const at = visible.findIndex((entry) => entry.value === highlighted);
    // Nothing highlighted yet: Down starts at the top, Up at the bottom.
    const unanchored = delta === 1 ? -1 : visible.length;
    const from = at === -1 ? unanchored : at;
    const next = Math.min(Math.max(from + delta, 0), visible.length - 1);
    setHighlighted(visible[next].value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // `stopPropagation` keeps each of these from ALSO reaching cmdk's root
    // handler, which would move its own highlight past refused options.
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        event.stopPropagation();
        move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      case "Enter": {
        event.preventDefault();
        event.stopPropagation();
        const entry = visible.find((option) => option.value === highlighted);
        if (entry !== undefined) choose(entry);
        return;
      }
      case "Home":
      case "End": {
        // The caret's, as in any text field - not a jump to cmdk's first or
        // last option.
        event.stopPropagation();
        return;
      }
      default:
        return;
    }
  };

  const hasModels = visible.some((entry) => entry.kind === "model");
  const showsExact = visible.some(
    (entry) => entry.kind === "model" && entry.exact,
  );
  return (
    <Command
      shouldFilter={false}
      value={highlighted}
      // A pointer resting on an option. cmdk also proposes its first ENABLED
      // item when it has no value, which can be a hidden one; only a visible
      // option may take the highlight.
      onValueChange={(next) => {
        if (visible.some((entry) => entry.value === next)) setHighlighted(next);
      }}
      vimBindings={false}
      variant="embedded"
      selection="flat"
    >
      <div className="p-1 pb-0">
        <InputGroup variant="search">
          <InputGroupInput
            ref={inputRef}
            role="combobox"
            // The popup this input controls from its first paint. cmdk mints
            // the listbox's own id internally and writes it AFTER any props,
            // so the layout effect above narrows this to that listbox once it
            // exists; React leaves the attribute alone afterwards, since this
            // prop never changes.
            aria-controls={popupId}
            aria-expanded
            aria-autocomplete="list"
            aria-label="Type a model or pattern"
            font="mono"
            value={query}
            placeholder="Type a model or a pattern, like *opus*"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              setHighlighted(
                firstVisibleValue(
                  buildPatternPicker({ query: next, models, claims }),
                ),
              );
            }}
            onKeyDown={onKeyDown}
            data-testid="fallback-model-pattern-input"
          />
          <InputGroupAddon>
            {isModelPattern(query) ? (
              <FallbackPatternGlyph
                tone={patternBlocked ? "destructive" : "accent"}
              />
            ) : (
              <SearchIcon className="size-4 shrink-0 opacity-50" aria-hidden />
            )}
          </InputGroupAddon>
          {typedPatternEntry === null ? null : (
            <InputGroupAddon align="inline-end">
              <PatternInputCount
                entry={typedPatternEntry}
                blocked={patternBlocked}
              />
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <CommandList
        ref={listRef}
        label={`${providerLabel} models and patterns`}
        className="max-h-[min(50vh,22rem)] p-1"
      >
        {/* Every option is rendered on every keystroke and only `hidden`
            moves - see `buildPatternPicker` for why an unmount would move the
            highlight. The headings are plain text beside the options, not
            cmdk groups, so an option moving between "Exact match" and the
            catalog stays one element. */}
        {entries.map((entry) => {
          const heading = entryHeading(entry, {
            showsExact,
            patternOffered,
            hasModels,
            providerLabel,
            firstModelValue: visible.find(
              (option) => option.kind === "model" && !option.exact,
            )?.value,
          });
          return (
            <PickerOption
              key={entry.value}
              entry={entry}
              heading={heading}
              stored={stored}
              providerLabel={providerLabel}
              onChoose={choose}
            />
          );
        })}
        {visible.length === 0 ? (
          <p
            className="px-2 py-6 text-center text-ui-sm text-muted-foreground"
            data-testid="fallback-model-pattern-empty"
          >
            {emptyLine(query, models, providerLabel)}
          </p>
        ) : null}
      </CommandList>
      <PickerHint blocked={patternBlocked} example={narrowExample} />
    </Command>
  );
}

/** The section heading an option starts, or `null` when it starts none. */
function entryHeading(
  entry: PatternPickerEntry,
  context: {
    readonly showsExact: boolean;
    readonly patternOffered: boolean;
    readonly hasModels: boolean;
    readonly providerLabel: string;
    readonly firstModelValue: string | undefined;
  },
): string | null {
  if (entry.hidden) return null;
  if (entry.kind === "pattern") return "Pattern";
  if (entry.exact) return "Exact match";
  if (entry.value !== context.firstModelValue) return null;
  return context.patternOffered
    ? `${context.providerLabel} models · list order is try order`
    : `${context.providerLabel} models`;
}

function emptyLine(
  query: string,
  models: readonly GuiAgentModelOption[] | null,
  providerLabel: string,
): string {
  if (models === null) {
    return `Can't list ${providerLabel} models right now. Type a pattern, like *opus*.`;
  }
  if (models.length === 0) return `${providerLabel} lists no models.`;
  return `No ${providerLabel} model contains “${query.trim()}”.`;
}

function PickerOption(props: {
  readonly entry: PatternPickerEntry;
  readonly heading: string | null;
  readonly stored: string;
  readonly providerLabel: string;
  readonly onChoose: (entry: PatternPickerEntry) => void;
}): ReactNode {
  const { entry, heading, stored, providerLabel, onChoose } = props;
  const detailId = useId();
  return (
    <>
      {heading === null ? null : (
        // Decorative: every option already says what it is, and a heading
        // inside a listbox is not something assistive technology can place.
        <div
          aria-hidden
          className="px-2 pt-2 pb-1 text-ui-xs font-medium text-muted-foreground"
        >
          {heading}
        </div>
      )}
      {entry.kind === "pattern" ? (
        <PatternOption
          entry={entry}
          detailId={detailId}
          checked={stored !== "" && stored === entry.pattern}
          providerLabel={providerLabel}
          onChoose={onChoose}
        />
      ) : (
        <ModelOption
          entry={entry}
          detailId={detailId}
          checked={stored.toLowerCase() === entry.model.slug.toLowerCase()}
          onChoose={onChoose}
        />
      )}
    </>
  );
}

/**
 * The pattern option's first line: "Any Codex model" beside the mono `*` for
 * a bare `*` (spec §How patterns work - the row claims the whole provider, and
 * `*` alone does not say so), "Any model containing “luna”" for a typed word,
 * and the pattern itself, in mono, otherwise.
 */
function PatternOptionLabel(props: {
  readonly entry: PatternPickerPatternEntry;
  readonly providerLabel: string;
}): ReactNode {
  const { entry, providerLabel } = props;
  if (entry.word !== null) {
    return <>Any model containing &ldquo;{entry.word}&rdquo;</>;
  }
  if (isAnyModelPattern(entry.pattern)) {
    return (
      <>
        {anyProviderModelLabel(providerLabel)}{" "}
        <span className="font-mono">{entry.pattern}</span>
      </>
    );
  }
  return <span className="font-mono">{entry.pattern}</span>;
}

function PatternOption(props: {
  readonly entry: PatternPickerPatternEntry;
  readonly detailId: string;
  readonly checked: boolean;
  readonly providerLabel: string;
  readonly onChoose: (entry: PatternPickerEntry) => void;
}): ReactNode {
  const { entry, detailId, checked, providerLabel, onChoose } = props;
  const blocked = entry.blockers.length > 0;
  return (
    <CommandItem
      value={entry.value}
      hidden={entry.hidden}
      // cmdk's `disabled` is what writes `aria-disabled`; the keyboard still
      // reaches it because this component drives the highlight.
      disabled={blocked}
      aria-describedby={detailId}
      data-checked={checked ? "true" : "false"}
      data-testid="fallback-model-pattern-option"
      onSelect={() => {
        onChoose(entry);
      }}
    >
      <FallbackPatternGlyph tone={blocked ? "destructive" : "accent"} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 break-words">
          <PatternOptionLabel entry={entry} providerLabel={providerLabel} />
        </span>
        <span
          id={detailId}
          className={cn(
            "text-ui-xs",
            blocked ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {blocked
            ? patternBlockedReason(entry.blockers)
            : patternOfferDetail(entry)}
        </span>
      </span>
      {blocked ? null : (
        <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
          {modelCountLabel(
            entry.matches === null ? null : entry.matches.length,
          )}
        </span>
      )}
    </CommandItem>
  );
}

function ModelOption(props: {
  readonly entry: PatternPickerModelEntry;
  readonly detailId: string;
  readonly checked: boolean;
  readonly onChoose: (entry: PatternPickerEntry) => void;
}): ReactNode {
  const { entry, detailId, checked, onChoose } = props;
  const owned = entry.owners.length > 0;
  // Outside an offered pattern's reach: still a model the user can pick
  // exactly, so it stays selectable and only reads quieter.
  const quiet = entry.patternOffered && !entry.matched && !entry.exact;
  return (
    <CommandItem
      value={entry.value}
      hidden={entry.hidden}
      disabled={owned}
      aria-describedby={owned ? detailId : undefined}
      data-checked={checked ? "true" : "false"}
      data-testid="fallback-model-option"
      onSelect={() => {
        onChoose(entry);
      }}
    >
      {entry.patternOffered ? (
        <span
          aria-hidden
          className={cn(
            "inline-grid size-4.5 shrink-0 place-items-center rounded-sm text-ui-xs font-semibold tabular-nums",
            owned && "bg-destructive/10 text-destructive",
            !owned && entry.rank !== null && "bg-primary/15 text-primary",
          )}
        >
          {owned ? "✕" : (entry.rank ?? "")}
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          quiet && "text-muted-foreground",
        )}
      >
        {entry.model.label}
      </span>
      {owned ? (
        <Badge variant="destructive" className="rounded-full">
          in{" "}
          {entry.owners
            .map((owner) => tierDisplayName(owner.tierId, owner.tierIndex))
            .join(", ")}
        </Badge>
      ) : null}
      <span className="min-w-0 max-w-[40%] shrink truncate font-mono text-ui-xs text-muted-foreground">
        {entry.model.slug}
      </span>
      {owned ? (
        <span id={detailId} className="sr-only">
          {modelOwnedReason(entry.model, entry.owners)}
        </span>
      ) : null}
    </CommandItem>
  );
}
