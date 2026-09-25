import {
  findTierConflicts,
  modelMatchesPattern,
  tierRungSkipReasonSchema,
  type TierCandidate,
  type TierCandidatePreview,
  type TierCandidatePreviewMatch,
  type TierConflict,
  type TierGroup,
  type TierModelIdentity,
} from "@traycer/protocol/host/fallback-policy";
import type { GuiAgentModelOption } from "@traycer/protocol/host/index";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";
import { catalogModelForFamily } from "@/components/settings/panels/fallback/fallback-catalog-options";

/**
 * The pure half of the Equivalent models editor's pattern cell: what the
 * combobox offers for a query, which choices "one model, one tier" refuses,
 * what a row's conflicts are, and what its status line says.
 *
 * Every match question here is asked through the protocol's
 * `modelMatchesPattern` and `findTierConflicts`, never a copy of them, so the
 * editor cannot disagree with the host's walk about what a pattern catches.
 *
 * A `.ts` module with no React import, for the reason `fallback-harness-label.ts`
 * gives: the card and the combobox export components, and
 * `react(only-export-components)` keeps pure helpers out of those files.
 */

/** Whether a stored row value is a pattern rather than one exact model. */
export function isModelPattern(value: string): boolean {
  return value.includes("*");
}

/** The shortest plain word the combobox turns into "Any model containing …". */
export const CONTAINS_MIN_LENGTH = 3;

/**
 * Whether a pattern is `*` alone (or only stars, which match the same way):
 * every model the provider lists. The spec names that row "Any Codex model"
 * (§How patterns work) - a bare `*` in mono does not tell a reader the row
 * claims the whole provider, which with the seed is why every one of its
 * models shows as owned somewhere else.
 */
export function isAnyModelPattern(value: string): boolean {
  return /^\*+$/.test(value.trim());
}

/** "Any Codex model" - how a {@link isAnyModelPattern} row is named. */
export function anyProviderModelLabel(providerLabel: string): string {
  return `Any ${providerLabel} model`;
}

/**
 * How many catalog models `pattern` matches today, or `null` when nothing can
 * say - no catalog has answered for this provider.
 */
export function patternMatchCount(
  pattern: string,
  catalog: readonly TierModelIdentity[] | null,
): number | null {
  if (catalog === null) return null;
  return catalog.filter((model) => modelMatchesPattern(pattern, model)).length;
}

/**
 * A tier as copy names it: its own name, or its position while the name is
 * blank - the transient state a rename passes through, which the draft's
 * validation is already speaking for.
 */
export function tierDisplayName(tierId: string, tierIndex: number): string {
  return tierId.trim() === "" ? `tier ${tierIndex + 1}` : tierId;
}

/** One OTHER tier's claim on a model, as the picker and the conflict block use it. */
export interface TierClaim {
  readonly tierIndex: number;
  readonly tierId: string;
  /** The first of that tier's rows that matches the model. */
  readonly candidateIndex: number;
}

/**
 * For every model in `catalog`, the tiers OTHER than `groupIndex` that already
 * claim it - which is exactly what a choice in row `candidateIndex` of
 * `groupIndex` would collide with.
 *
 * Asked through `findTierConflicts` over a probe: the row is replaced by `*`,
 * which claims every model of its provider, so every conflict the probe finds
 * that involves this row names a model another tier owns. The row's CURRENT
 * value is deliberately out of the question - the picker is asking what the
 * row could become - and other rows of the same tier never count, because
 * same-tier overlap is not a conflict.
 *
 * Keyed by the lower-cased slug, the way the engine compares slugs.
 */
export function otherTierClaims(input: {
  readonly groups: readonly TierGroup[];
  readonly groupIndex: number;
  readonly candidateIndex: number;
  readonly harnessId: TierCandidate["harnessId"];
  readonly catalog: readonly TierModelIdentity[];
}): ReadonlyMap<string, readonly TierClaim[]> {
  const { groups, groupIndex, candidateIndex, harnessId, catalog } = input;
  const claims = new Map<string, readonly TierClaim[]>();
  if (groupIndex < 0 || groupIndex >= groups.length) return claims;
  const probeRow: TierCandidate = {
    harnessId,
    modelFamily: "*",
    reasoningEffort: null,
  };
  const probe = groups.map((group, at) =>
    at === groupIndex
      ? {
          ...group,
          candidates: group.candidates.map((existing, index) =>
            index === candidateIndex ? probeRow : existing,
          ),
        }
      : group,
  );
  const conflicts = findTierConflicts(probe, new Map([[harnessId, catalog]]));
  for (const conflict of conflicts) {
    const involvesRow = conflict.tiers.some(
      (claim) =>
        claim.tierIndex === groupIndex &&
        claim.candidateIndexes.includes(candidateIndex),
    );
    if (!involvesRow) continue;
    const others = conflict.tiers
      .filter((claim) => claim.tierIndex !== groupIndex)
      .map((claim) => ({
        tierIndex: claim.tierIndex,
        tierId: claim.tierId,
        candidateIndex: claim.candidateIndexes[0],
      }));
    claims.set(conflict.model.slug.toLowerCase(), others);
  }
  return claims;
}

/** A model a pattern would reach that another tier already owns. */
export interface PatternBlocker {
  readonly model: TierModelIdentity;
  readonly owners: readonly TierClaim[];
}

/** The cmdk value of the pattern option; never a slug, so it cannot collide with one. */
export const PATTERN_OPTION_VALUE = "__pattern__";

/** The cmdk value of a model option. Prefixed so no slug can equal the pattern sentinel. */
export function modelOptionValue(slug: string): string {
  return `model:${slug}`;
}

export interface PatternPickerPatternEntry {
  readonly kind: "pattern";
  readonly value: string;
  /** Hidden while the query offers no pattern (blank, or a short plain word). */
  readonly hidden: boolean;
  /** What choosing this option saves. */
  readonly pattern: string;
  /** "luna" when the pattern was built from a plain word; `null` when the user typed `*`. */
  readonly word: string | null;
  /** The catalog models it reaches, in try order; `null` with no catalog to check. */
  readonly matches: readonly GuiAgentModelOption[] | null;
  /** Non-empty means the option cannot be chosen. */
  readonly blockers: readonly PatternBlocker[];
}

export interface PatternPickerModelEntry {
  readonly kind: "model";
  readonly value: string;
  readonly hidden: boolean;
  readonly model: GuiAgentModelOption;
  /** The text the user typed names this model exactly, so it leads the list. */
  readonly exact: boolean;
  /**
   * 1-based try position under the offered pattern, or `null` when the pattern
   * does not reach this model or another tier owns it.
   */
  readonly rank: number | null;
  /** Whether the offered pattern reaches this model. */
  readonly matched: boolean;
  /** Whether a pattern is on offer at all, so an unmatched row can be drawn as such. */
  readonly patternOffered: boolean;
  /** Other tiers that own this model. Non-empty means picking it exactly is refused. */
  readonly owners: readonly TierClaim[];
}

export type PatternPickerEntry =
  | PatternPickerPatternEntry
  | PatternPickerModelEntry;

/**
 * The pattern a query offers: a typed `*` as written, a plain word of
 * {@link CONTAINS_MIN_LENGTH} or more as "contains", and nothing shorter - two
 * letters match too much of a catalog to be a choice anyone means.
 */
function pickerPatternFor(text: string): string | null {
  if (isModelPattern(text)) return text;
  if (text.length >= CONTAINS_MIN_LENGTH) return `*${text}*`;
  return null;
}

/**
 * Every option the combobox renders for `query`, in render order, HIDDEN ones
 * included.
 *
 * Every option stays mounted across keystrokes and only its `hidden` flag
 * moves. That is not tidiness: cmdk re-selects its first ENABLED item whenever
 * the highlighted item unmounts, and a refused option is exactly the one it
 * would skip - so an unmount would move the highlight off a refused pattern and
 * onto the model below it, and Enter would then pick that model instead of
 * saying why the pattern cannot be used.
 *
 * The order is the Enter rule (spec §Wireframe 2): text that EXACTLY equals a
 * model's ID or name puts that model first; otherwise the pattern leads - a
 * typed `*` builds it as written, and a plain word of three or more characters
 * becomes "Any model containing …". The catalog follows in the provider's own
 * order, which is the order a pattern tries its matches, so a match is numbered
 * by its position there.
 */
export function buildPatternPicker(input: {
  readonly query: string;
  /** The provider's catalog, or `null` when it has not answered. */
  readonly models: readonly GuiAgentModelOption[] | null;
  readonly claims: ReadonlyMap<string, readonly TierClaim[]>;
}): readonly PatternPickerEntry[] {
  const { models, claims } = input;
  const text = input.query.trim();
  const lowered = text.toLowerCase();
  const typedPattern = isModelPattern(text);
  const pattern = pickerPatternFor(text);
  const catalog = models ?? [];
  const exact = typedPattern
    ? null
    : (catalog.find(
        (model) =>
          text !== "" &&
          (model.slug.toLowerCase() === lowered ||
            model.label.toLowerCase() === lowered),
      ) ?? null);
  const matches =
    pattern === null
      ? []
      : catalog.filter((model) => modelMatchesPattern(pattern, model));
  const ownersOf = (model: TierModelIdentity): readonly TierClaim[] =>
    claims.get(model.slug.toLowerCase()) ?? [];
  const patternEntry: PatternPickerPatternEntry = {
    kind: "pattern",
    value: PATTERN_OPTION_VALUE,
    hidden: pattern === null,
    pattern: pattern ?? "",
    word: typedPattern ? null : text,
    matches: models === null ? null : matches,
    blockers: matches.flatMap((model) => {
      const owners = ownersOf(model);
      return owners.length === 0 ? [] : [{ model, owners }];
    }),
  };
  // Numbered over the matches this tier could actually keep: a match another
  // tier owns is marked as owned instead of taking a place in a try order the
  // pattern cannot have while it reaches that model.
  const tryable = matches.filter((model) => ownersOf(model).length === 0);
  const modelEntry = (model: GuiAgentModelOption): PatternPickerModelEntry => {
    const at = tryable.indexOf(model);
    // A plain word too short to become a pattern still narrows the list, the
    // way any search box does; with a pattern on offer every model stays, so
    // the unmatched ones can show where they sit in the try order.
    const hidden =
      pattern === null &&
      text !== "" &&
      !model.slug.toLowerCase().includes(lowered) &&
      !model.label.toLowerCase().includes(lowered);
    return {
      kind: "model",
      value: modelOptionValue(model.slug),
      hidden,
      model,
      exact: model === exact,
      rank: at === -1 ? null : at + 1,
      matched: matches.includes(model),
      patternOffered: pattern !== null,
      owners: ownersOf(model),
    };
  };
  const rest = catalog.filter((model) => model !== exact).map(modelEntry);
  return exact === null
    ? [patternEntry, ...rest]
    : [modelEntry(exact), patternEntry, ...rest];
}

/** Whether an entry is refused by the one-model-one-tier rule. */
export function pickerEntryBlocked(entry: PatternPickerEntry): boolean {
  return entry.kind === "pattern"
    ? entry.blockers.length > 0
    : entry.owners.length > 0;
}

/** "a", "a and b", "a, b and c". */
export function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const ONE_TIER_RULE = "A model can be in only one tier.";

/** How many blocked models a refusal names before summarising the rest. */
const BLOCKERS_NAMED = 3;

function ownersPhrase(owners: readonly TierClaim[]): string {
  return joinWithAnd(
    owners.map((owner) => tierDisplayName(owner.tierId, owner.tierIndex)),
  );
}

/**
 * Why a pattern option cannot be chosen: "Can't use: GPT-6-Astra is in frontier
 * and GPT-6-Sol is in flagship. A model can be in only one tier."
 *
 * The option's accessible description AND the sentence announced when Enter is
 * pressed on it, so the two cannot say different things.
 */
export function patternBlockedReason(
  blockers: readonly PatternBlocker[],
): string {
  const named = blockers
    .slice(0, BLOCKERS_NAMED)
    .map(
      (blocker) =>
        `${blocker.model.label} is in ${ownersPhrase(blocker.owners)}`,
    );
  const rest = blockers.length - named.length;
  const clauses =
    rest === 0
      ? named
      : [
          ...named,
          `${rest} more ${rest === 1 ? "model is" : "models are"} in other tiers`,
        ];
  return `Can't use: ${joinWithAnd(clauses)}. ${ONE_TIER_RULE}`;
}

/** Why picking one model exactly is refused: "GPT-6-Astra is in frontier. A model can be in only one tier." */
export function modelOwnedReason(
  model: TierModelIdentity,
  owners: readonly TierClaim[],
): string {
  return `${model.label} is in ${ownersPhrase(owners)}. ${ONE_TIER_RULE}`;
}

/** The pattern option's second line when it CAN be chosen. */
export function patternOfferDetail(entry: PatternPickerPatternEntry): string {
  const saves = `Saves as ${entry.pattern}`;
  if (entry.matches === null) {
    return `${saves}. Can't list its models right now.`;
  }
  const count = entry.matches.length;
  if (count === 0) return `${saves}. No model matches it yet.`;
  if (count === 1) return `${saves} and tries it`;
  if (count === 2) return `${saves} and tries both, in this order`;
  return `${saves} and tries all ${count}, in this order`;
}

/**
 * A narrower pattern the refused one could become (wireframe 2's "Narrow it
 * (for example `*luna*`)"), or `null` when every model it reaches is owned
 * elsewhere and there is nothing narrower to suggest.
 *
 * Built from the first match no other tier owns, as "contains" its slug - and
 * only offered when that suggestion would itself be choosable: `*gpt-6-luna*`
 * could still reach an owned `gpt-6-luna-pro`, and a hint that leads to a
 * second refusal is worse than none. Failing that, the slug alone, which is an
 * exact pick of a model nobody owns.
 */
export function blockedPatternExample(
  entry: PatternPickerPatternEntry,
): string | null {
  if (entry.matches === null) return null;
  const owned = new Set(
    entry.blockers.map((blocker) => blocker.model.slug.toLowerCase()),
  );
  const free = entry.matches.find(
    (match) => !owned.has(match.slug.toLowerCase()),
  );
  if (free === undefined) return null;
  const contains = `*${free.slug}*`;
  const reachesOwned = entry.blockers.some((blocker) =>
    modelMatchesPattern(contains, blocker.model),
  );
  return reachesOwned ? free.slug : contains;
}

/** "1 model", "4 models", or "? models" when there is no catalog to count. */
export function modelCountLabel(count: number | null): string {
  if (count === null) return "? models";
  return count === 1 ? "1 model" : `${count} models`;
}

/**
 * One overlap as a row draws it: the models this row shares with the same set
 * of other tiers, and which tier handles them until it is fixed.
 */
export interface RowConflict {
  readonly models: readonly TierModelIdentity[];
  /** The other tiers claiming these models, in tier order, each with its first matching row. */
  readonly others: readonly TierClaim[];
  /** The first-listed claimant: where routing sends these models today. */
  readonly handler: { readonly tierIndex: number; readonly tierId: string };
}

/**
 * The conflicts row `candidateIndex` of tier `groupIndex` takes part in,
 * grouped by the set of OTHER tiers involved, so `*gpt*` overlapping two Sol
 * models in flagship and Terra in standard reads as two statements rather than
 * three.
 */
export function rowConflictsFor(
  conflicts: readonly TierConflict[],
  groupIndex: number,
  candidateIndex: number,
): readonly RowConflict[] {
  const byOthers = new Map<string, RowConflict>();
  for (const conflict of conflicts) {
    const involvesRow = conflict.tiers.some(
      (claim) =>
        claim.tierIndex === groupIndex &&
        claim.candidateIndexes.includes(candidateIndex),
    );
    if (!involvesRow) continue;
    const others = conflict.tiers
      .filter((claim) => claim.tierIndex !== groupIndex)
      .map((claim) => ({
        tierIndex: claim.tierIndex,
        tierId: claim.tierId,
        candidateIndex: claim.candidateIndexes[0],
      }));
    const key = others.map((other) => other.tierIndex).join(" ");
    const existing = byOthers.get(key);
    if (existing === undefined) {
      const first = conflict.tiers[0];
      byOthers.set(key, {
        models: [conflict.model],
        others,
        handler: { tierIndex: first.tierIndex, tierId: first.tierId },
      });
    } else {
      byOthers.set(key, {
        ...existing,
        models: [...existing.models, conflict.model],
      });
    }
  }
  return [...byOthers.values()];
}

/** How many models a row's conflicts cover - the "N conflicts" pill. */
export function rowConflictModelCount(
  rowConflicts: readonly RowConflict[],
): number {
  return rowConflicts.reduce(
    (sum, conflict) => sum + conflict.models.length,
    0,
  );
}

/** One model on a row's try line. */
export interface TryStep {
  /** The match's slug - unique among one row's matches, so it keys the step. */
  readonly model: string;
  readonly label: string;
  /** Why the walk would skip it right now, or `null` when it would be tried. */
  readonly skipLabel: string | null;
}

/** How many matches a try line names before "N more". */
const TRY_STEPS_NAMED = 2;

/**
 * What a row's status line says, or `null` when it has nothing to add.
 *
 * Red is kept for the one verdict that is the user's to fix
 * (`unmatched`); everything environmental is neutral or amber.
 */
export type RowStatusLine =
  | {
      readonly kind: "tries";
      /**
       * A reason every match shares - an account-wide rate limit - said once at
       * the head of the line instead of striking every model through.
       */
      readonly lead: string | null;
      readonly steps: readonly TryStep[];
      readonly more: number;
      readonly account: string | null;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "unmatched";
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "cannot-check";
      readonly reason: string;
      readonly warnings: readonly string[];
    }
  | { readonly kind: "warnings"; readonly warnings: readonly string[] };

/**
 * The row's status line from the host's preview.
 *
 * The walk is the host's - which models a row reaches, in which order, and
 * which of them it would skip - so this only arranges the answer: `matches`
 * in try order, each skipped one carrying the host's own label. A preview
 * with no `matches` (never from a 1.1 client, since the 1.0 upgrade
 * synthesises them) still says what `resolvedModel` names.
 *
 *  - `family-unmatched` keeps its id although rows hold patterns: it is the
 *    one verdict that says the USER's row is wrong, so it is the one that is
 *    red. Any other row with no matches is environmental: "Can't check right
 *    now", with the host's label, which is what a reason this build has never
 *    heard of degrades to.
 *  - An exact pick that resolves to itself says nothing - the cell already
 *    names the model - unless the host attached warnings or would skip it.
 *  - The ACCOUNT is named, never its id (D118), and only for the first match
 *    the walk would actually try.
 *
 * A blank row has no line: it is already marked invalid, and the draft's own
 * message says what it needs.
 */
export function rowStatusLine(input: {
  readonly candidate: TierCandidate;
  readonly preview: TierCandidatePreview | null;
  readonly models: readonly GuiAgentModelOption[];
  readonly labelFor: FallbackSettingsProfileLabel;
}): RowStatusLine | null {
  const { candidate, preview, models, labelFor } = input;
  if (preview === null) return null;
  const stored = candidate.modelFamily.trim();
  if (stored === "") return null;
  const warnings = preview.warnings;
  const matches = previewMatches(preview);
  if (matches.length === 0) return noMatchStatus(preview);
  const namesItself =
    !isModelPattern(stored) &&
    matches.length === 1 &&
    matches[0].model.toLowerCase() === stored.toLowerCase() &&
    skipOf(matches[0]) === null;
  if (namesItself) {
    return warnings.length === 0 ? null : { kind: "warnings", warnings };
  }
  return tryLine({ matches, warnings, models, labelFor });
}

/** A match's skip as the line shows it: the host's label, or its id. */
function skipOf(match: TierCandidatePreviewMatch): string | null {
  return match.skipReason === null
    ? null
    : (match.skipLabel ?? match.skipReason);
}

/**
 * The row's matches in try order - or, for a preview that carries none but
 * did resolve (a hand-built 1.0 shape), the one model it resolved to.
 */
function previewMatches(
  preview: TierCandidatePreview,
): readonly TierCandidatePreviewMatch[] {
  if (preview.matches.length > 0 || preview.resolvedModel === null) {
    return preview.matches;
  }
  return [
    {
      model: preview.resolvedModel,
      profileId: preview.profileId,
      skipReason: null,
      skipLabel: null,
    },
  ];
}

/** A row that reaches nothing: the user's to fix, or the world's. */
function noMatchStatus(preview: TierCandidatePreview): RowStatusLine {
  const warnings = preview.warnings;
  const parsed =
    preview.skipReason === null
      ? null
      : tierRungSkipReasonSchema.safeParse(preview.skipReason);
  if (parsed !== null && parsed.success && parsed.data === "family-unmatched") {
    return { kind: "unmatched", warnings };
  }
  return {
    kind: "cannot-check",
    reason: preview.skipLabel ?? "not available",
    warnings,
  };
}

/** "Tries A → B → …" over a row's matches. */
function tryLine(input: {
  readonly matches: readonly TierCandidatePreviewMatch[];
  readonly warnings: readonly string[];
  readonly models: readonly GuiAgentModelOption[];
  readonly labelFor: FallbackSettingsProfileLabel;
}): RowStatusLine {
  const { matches, warnings, models, labelFor } = input;
  const skips = matches.map(skipOf);
  const shared = skips[0];
  const lead =
    shared !== null && skips.every((skip) => skip === shared) ? shared : null;
  const steps = matches.map((match, index) => ({
    model: match.model,
    label: catalogModelForFamily(models, match.model)?.label ?? match.model,
    skipLabel: lead === null ? skips[index] : null,
  }));
  const tried = matches.find((match) => skipOf(match) === null);
  const account =
    tried === undefined || tried.profileId === null
      ? null
      : labelFor(tried.profileId);
  return {
    kind: "tries",
    lead,
    steps: steps.slice(0, TRY_STEPS_NAMED),
    more: Math.max(0, steps.length - TRY_STEPS_NAMED),
    account,
    warnings,
  };
}
