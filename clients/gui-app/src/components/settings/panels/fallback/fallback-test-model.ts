import {
  REASON_ELIGIBLE_RUNGS,
  TIER_PREVIEW_FAILURE_KINDS,
  findTierGroupForFailedTuple,
  modelMatchesPattern,
  routeTierGroupForFailedTuple,
  tierRungSkipReasonSchema,
  type FallbackPolicy,
  type FallbackRungKind,
  type TierCandidate,
  type TierCandidatePreview,
  type TierConflict,
  type TierGroup,
  type TierModelIdentity,
  type TierPreviewBlockedTuple,
  type TierRungSkipReason,
} from "@traycer/protocol/host/fallback-policy";
import type { HarnessId } from "@traycer/protocol/host/agent/shared";
import {
  catalogModelForFamily,
  type FallbackCatalogOptions,
} from "@/components/settings/panels/fallback/fallback-catalog-options";
import { isModelPattern } from "@/components/settings/panels/fallback/fallback-model-patterns";
import { effectiveLadderFor } from "@/components/settings/panels/fallback/fallback-overrides-model";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";

/**
 * The pure half of the Test a model panel (spec §Wireframe 4): which tier a
 * hypothetical blocked model routes to, what the draft's steps after the tier
 * are, and how the host's dry run reads row by row.
 *
 * Routing is the protocol's `routeTierGroupForFailedTuple` over the DRAFT with
 * the editor's cached catalog - the readable-catalog answer the spec names -
 * and the per-match walk is the host's (`previewTierGroups@1.1` with
 * `blocked`). This module only arranges the two; it never re-decides either.
 *
 * A `.ts` module with no React import, for the reason
 * `fallback-model-patterns.ts` gives.
 */

/** What kind of failure the Test panel simulates. */
export type TestFailureKind = TierPreviewBlockedTuple["kind"];

/** The failure picker's options, in the order the protocol lists them. */
export const TEST_FAILURE_KINDS: readonly TestFailureKind[] =
  TIER_PREVIEW_FAILURE_KINDS;

/** The failure picker's words, completing "If <model> is blocked by …". */
export const TEST_FAILURE_KIND_LABELS: Readonly<
  Record<TestFailureKind, string>
> = {
  rate_limit: "a rate limit",
  other: "another error",
};

/** A tier as the verdict names it. */
export interface TestTierRef {
  readonly tierIndex: number;
  readonly tierId: string;
}

/** One tier's claim on the blocked model, with its first matching row. */
export interface TestTierClaim extends TestTierRef {
  readonly candidateIndex: number;
}

/**
 * Which tier handles the blocked model, and why.
 *
 *  - `own-tier` - a row reaches it. `candidateIndex` is the first such row of
 *    that tier, which is what "(row n)" names. `conflict` lists every tier
 *    that claims the model, first-listed (the handler) first, when there are
 *    two or more - decision 4's "first-listed handles it".
 *  - `default-tier` - no row reaches it and the draft names a default tier.
 *  - `no-tier` - no row reaches it and there is no default tier to go to.
 */
export type TestRouting =
  | {
      readonly kind: "own-tier";
      readonly tier: TestTierRef;
      readonly candidateIndex: number;
      readonly rowValue: string;
      readonly conflict: readonly TestTierClaim[] | null;
    }
  | { readonly kind: "default-tier"; readonly tier: TestTierRef }
  | { readonly kind: "no-tier"; readonly defaultTierGroupId: string | null };

/**
 * The blocked model as routing matches it - its ID, and the name the failed
 * harness's catalog gives that ID, or the ID again with no catalog. The same
 * identity the protocol's router builds, so "(row n)" names the row the
 * router matched.
 */
function blockedIdentity(
  model: string,
  catalog: readonly TierModelIdentity[] | null,
): TierModelIdentity {
  return { slug: model, label: blockedModelLabel(model, catalog) };
}

/** The blocked model's display name, or its ID when the catalog does not list it. */
export function blockedModelLabel(
  model: string,
  catalog: readonly TierModelIdentity[] | null,
): string {
  const slug = model.toLowerCase();
  const entry =
    catalog === null
      ? undefined
      : catalog.find((candidate) => candidate.slug.toLowerCase() === slug);
  return entry === undefined ? model : entry.label;
}

export function testRouting(input: {
  readonly groups: readonly TierGroup[];
  readonly defaultTierGroupId: string | null;
  readonly harnessId: HarnessId;
  readonly model: string;
  /** The blocked harness's cached catalog, or `null` for the ID-only answer. */
  readonly catalog: readonly TierModelIdentity[] | null;
  /** `findTierConflicts` over the draft - the editor's own `conflicts`. */
  readonly conflicts: readonly TierConflict[];
}): TestRouting {
  const { groups, defaultTierGroupId, harnessId, model, catalog, conflicts } =
    input;
  const routed = routeTierGroupForFailedTuple({
    groups,
    defaultTierGroupId,
    harnessId,
    model,
    catalog,
  });
  if (routed === null) return { kind: "no-tier", defaultTierGroupId };
  const tier = { tierIndex: groups.indexOf(routed), tierId: routed.id };
  const own = findTierGroupForFailedTuple(groups, harnessId, model, catalog);
  if (own === null) return { kind: "default-tier", tier };
  const blocked = blockedIdentity(model, catalog);
  const candidateIndex = own.candidates.findIndex(
    (candidate) =>
      candidate.harnessId === harnessId &&
      modelMatchesPattern(candidate.modelFamily, blocked),
  );
  const slug = model.toLowerCase();
  const conflict = conflicts.find(
    (entry) =>
      entry.harnessId === harnessId && entry.model.slug.toLowerCase() === slug,
  );
  return {
    kind: "own-tier",
    tier,
    candidateIndex,
    rowValue: own.candidates[candidateIndex].modelFamily.trim(),
    conflict:
      conflict === undefined
        ? null
        : conflict.tiers.map((claim) => ({
            tierIndex: claim.tierIndex,
            tierId: claim.tierId,
            candidateIndex: claim.candidateIndexes[0],
          })),
  };
}

/**
 * What the draft's steps do around the equivalent-model step for this kind of
 * failure.
 *
 *  - `fallback-off` - the rate-limit override is `"off"`: nothing arms at all.
 *  - `tier-off` - the equivalent-model step does not run for this failure (not
 *    in its ladder, or after an early Notify); `steps` is what runs instead.
 *  - `after-tier` - it runs; `steps` is the draft's "If none of these work"
 *    tail.
 *
 * Every list ends at Notify: exhaustion always notifies (the ladder schema's
 * own rule), and a step stored after an early Notify never runs.
 */
export type TestNextSteps =
  | { readonly kind: "fallback-off" }
  | {
      readonly kind: "tier-off" | "after-tier";
      readonly steps: readonly FallbackRungKind[];
    };

/**
 * Whether `rung` can run for this kind of failure. A rate limit reads the
 * protocol's eligibility row; "another error" stands for every other failure,
 * none of which has a reset boundary to wait on - so it is every step but
 * `wait`.
 */
function stepRunsFor(kind: TestFailureKind, rung: FallbackRungKind): boolean {
  if (rung === "notify") return true;
  if (kind === "rate_limit") {
    return REASON_ELIGIBLE_RUNGS.rate_limit.includes(rung);
  }
  return rung !== "wait";
}

function endingAtNotify(
  steps: readonly FallbackRungKind[],
): readonly FallbackRungKind[] {
  const at = steps.indexOf("notify");
  return at === -1 ? [...steps, "notify"] : steps.slice(0, at + 1);
}

export function testNextSteps(
  policy: FallbackPolicy,
  kind: TestFailureKind,
): TestNextSteps {
  // A rate limit walks its override when the user set one; "another error"
  // names no single failure, so it walks the main order.
  const ladder =
    kind === "rate_limit"
      ? effectiveLadderFor(policy, "rate_limit")
      : policy.ladder;
  if (ladder === "off") return { kind: "fallback-off" };
  const reachable = endingAtNotify(
    ladder.filter((rung) => stepRunsFor(kind, rung)),
  );
  const tierAt = reachable.indexOf("tier");
  return tierAt === -1
    ? { kind: "tier-off", steps: reachable }
    : { kind: "after-tier", steps: reachable.slice(tierAt + 1) };
}

/**
 * The steps as the "If none of these work" line names them - wireframe 4's
 * words, which speak from Traycer's side ("Notify you").
 */
export const TEST_STEP_LABELS: Readonly<Record<FallbackRungKind, string>> = {
  profile: "Try another account",
  tier: "Try an equivalent model",
  wait: "Wait for the limit to reset",
  notify: "Notify you",
};

/**
 * `neutral` for a skip that is the walk working as designed (the blocked
 * model itself, a model tried a row earlier, a blank row); `warning` for the
 * world (a limit, a signed-out account, an unreadable catalog); `destructive`
 * for the one row the user has to fix, a pattern that matches nothing.
 */
export type TestSkipTone = "neutral" | "warning" | "destructive";

export interface TestSkip {
  /** The pill's whole text: "skipped · the blocked model", "blank, skipped". */
  readonly text: string;
  readonly tone: TestSkipTone;
}

/**
 * Each known reason's tone, and the wireframe's own copy where it names one;
 * `null` copy renders the host's label. Exhaustive with no default arm, so a
 * reason added to the protocol is a compile error here rather than a pill in
 * the wrong colour.
 */
const SKIP_PRESENTATION: Readonly<
  Record<
    TierRungSkipReason,
    { readonly copy: string | null; readonly tone: TestSkipTone }
  >
> = {
  "no-group": { copy: null, tone: "neutral" },
  "harness-not-gui": { copy: null, tone: "neutral" },
  "provider-unknown": { copy: null, tone: "warning" },
  "provider-unavailable": { copy: null, tone: "warning" },
  "profile-signed-out": { copy: null, tone: "warning" },
  "catalog-unreadable": { copy: null, tone: "warning" },
  "family-unmatched": { copy: null, tone: "destructive" },
  "same-as-failed": { copy: "the blocked model", tone: "neutral" },
  // The host's label, which is what tells the sibling rule ("same account, no
  // headroom after a rate limit") from a gauge that reads limited.
  "rate-limited": { copy: null, tone: "warning" },
  "tuple-unusable": { copy: null, tone: "warning" },
  "already-tried": { copy: null, tone: "neutral" },
};

/** A reason this build has never heard of: the host's label, as environmental. */
const UNKNOWN_SKIP_TONE: TestSkipTone = "warning";

const BLANK_ROW_SKIP: TestSkip = { text: "blank, skipped", tone: "neutral" };

function skipFor(reason: string | null, label: string | null): TestSkip {
  const parsed =
    reason === null ? null : tierRungSkipReasonSchema.safeParse(reason);
  const known = parsed !== null && parsed.success ? parsed.data : null;
  const presentation =
    known === null
      ? { copy: null, tone: UNKNOWN_SKIP_TONE }
      : SKIP_PRESENTATION[known];
  const copy = presentation.copy ?? label ?? reason ?? "not available";
  return { text: `skipped · ${copy}`, tone: presentation.tone };
}

/**
 * `switches` - the first usable match of the walk, where the chat goes;
 * `then` - a usable match after it; `skipped` - the walk passes it over;
 * `listed` - the older-host fallback, where nothing was simulated and a match
 * is only what the tier says.
 */
export type TestMatchStatus = "switches" | "then" | "skipped" | "listed";

export interface TestMatchLine {
  /** The match's slug - unique among one row's matches, so it keys the line. */
  readonly model: string;
  readonly label: string;
  readonly status: TestMatchStatus;
  readonly skip: TestSkip | null;
}

export type TestRowAnswer =
  | {
      readonly kind: "matches";
      readonly lines: readonly TestMatchLine[];
      readonly more: number;
    }
  | { readonly kind: "skipped"; readonly skip: TestSkip }
  /** The host said nothing about this row, so the panel says nothing either. */
  | { readonly kind: "unanswered" };

export interface TestRow {
  readonly candidateIndex: number;
  readonly harnessId: TierCandidate["harnessId"];
  /** The row's pattern or exact pick, trimmed; blank for a row not filled in yet. */
  readonly value: string;
  readonly isPattern: boolean;
  readonly effortLabel: string;
  /** The account the row's first usable match runs on, by name; `null` for none. */
  readonly account: string | null;
  readonly answer: TestRowAnswer;
}

/** How many matches a row names before "N more", unless the winner is further down. */
const MATCHES_NAMED = 2;

/**
 * The host's rows for one tier, or `null` when they cannot be attributed to
 * it. Rows carry `groupId`, the tier's editable NAME, so a name another tier
 * shares - the transient state a rename passes through - would pair one tier's
 * row with another's answer; the editor withholds in that case too
 * (`previewForGroup`).
 */
export function testPreviewForTier(
  candidates: readonly TierCandidatePreview[] | null,
  groups: readonly TierGroup[],
  tierIndex: number,
): readonly TierCandidatePreview[] | null {
  if (candidates === null) return null;
  const tierId = groups[tierIndex].id;
  const shared = groups.some(
    (group, at) => at !== tierIndex && group.id === tierId,
  );
  if (shared) return null;
  return candidates.filter((row) => row.groupId === tierId);
}

/**
 * Every row of the routed tier, as the panel draws it.
 *
 * `simulated` is the negotiated `previewTierGroups` line being 1.1 or later,
 * in which case `preview` is the host's walk for the blocked tuple and every
 * match is drawn with its verdict. Below it, `preview` is the editor's own
 * non-blocked preview and each row shows only its FIRST match, with no
 * "switches here" - nothing was simulated, so nothing is claimed about where
 * the chat would go.
 */
export function testRows(input: {
  readonly tier: TierGroup;
  readonly preview: readonly TierCandidatePreview[] | null;
  readonly simulated: boolean;
  readonly catalog: FallbackCatalogOptions;
  readonly labelFor: FallbackSettingsProfileLabel;
}): readonly TestRow[] {
  const { tier, preview, simulated, catalog, labelFor } = input;
  const rows: TestRow[] = [];
  let winnerFound = false;
  tier.candidates.forEach((candidate, candidateIndex) => {
    const value = candidate.modelFamily.trim();
    const efforts = catalog.effortsFor(
      candidate.harnessId,
      candidate.modelFamily,
    );
    const effortLabel =
      candidate.reasoningEffort === null
        ? "Any effort"
        : (efforts.find((option) => option.id === candidate.reasoningEffort)
            ?.label ?? candidate.reasoningEffort);
    const base = {
      candidateIndex,
      harnessId: candidate.harnessId,
      value,
      isPattern: isModelPattern(value),
      effortLabel,
    };
    // Drawn from the DRAFT, not the answer: a blank row is the editor's own
    // state, and it is skipped whatever the host calls it.
    if (value === "") {
      rows.push({
        ...base,
        account: null,
        answer: { kind: "skipped", skip: BLANK_ROW_SKIP },
      });
      return;
    }
    const row =
      preview === null
        ? null
        : (preview.find((entry) => entry.candidateIndex === candidateIndex) ??
          null);
    if (row === null) {
      rows.push({ ...base, account: null, answer: { kind: "unanswered" } });
      return;
    }
    const matches = simulated ? row.matches : row.matches.slice(0, 1);
    if (matches.length === 0) {
      rows.push({
        ...base,
        account: null,
        answer: {
          kind: "skipped",
          skip: skipFor(row.skipReason, row.skipLabel),
        },
      });
      return;
    }
    const models = catalog.modelsFor(candidate.harnessId);
    const lines = matches.map((match): TestMatchLine => {
      const skip =
        match.skipReason === null
          ? null
          : skipFor(match.skipReason, match.skipLabel);
      let status: TestMatchStatus;
      if (skip !== null) {
        status = "skipped";
      } else if (!simulated) {
        status = "listed";
      } else if (winnerFound) {
        status = "then";
      } else {
        winnerFound = true;
        status = "switches";
      }
      return {
        model: match.model,
        label: catalogModelForFamily(models, match.model)?.label ?? match.model,
        status,
        skip,
      };
    });
    const tried = matches.find((match) => match.skipReason === null);
    // Never cut the winner into "N more": the row shows at least as far as
    // the match the chat would switch to.
    const named = Math.max(
      MATCHES_NAMED,
      lines.findIndex((line) => line.status === "switches") + 1,
    );
    rows.push({
      ...base,
      account:
        tried === undefined || tried.profileId === null
          ? null
          : labelFor(tried.profileId),
      answer: {
        kind: "matches",
        lines: lines.slice(0, named),
        more: Math.max(0, lines.length - named),
      },
    });
  });
  return rows;
}

/**
 * Whether the draft's tiers can be sent as a dry run: every tier named, and no
 * two with one name. A blank name fails the request schema, and a shared one
 * makes the answer unattributable (`testPreviewForTier`); both are states a
 * rename passes through, and asking in them would spend a walk on a request
 * that cannot be used.
 */
export function testableTierNames(groups: readonly TierGroup[]): boolean {
  const seen = new Set<string>();
  for (const group of groups) {
    if (group.id.trim() === "" || seen.has(group.id)) return false;
    seen.add(group.id);
  }
  return true;
}
