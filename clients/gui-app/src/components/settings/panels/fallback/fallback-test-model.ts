import {
  EXCLUDED_FALLBACK_REASONS,
  REASON_ELIGIBLE_RUNGS,
  TIER_PREVIEW_FAILURE_KINDS,
  failedModelRoutingIdentity,
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
import {
  guiHarnessIdSchema,
  type GuiHarnessId,
  type HarnessId,
} from "@traycer/protocol/host/agent/shared";
import {
  HOST_NOTIFICATION_STOPPED_REASONS,
  type HostNotificationStoppedReason,
} from "@traycer/protocol/host/notifications/payloads";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { TERMINAL_ACCOUNT_LABEL } from "@/components/chat/fallback/fallback-identity";
import {
  catalogModelForFamily,
  type FallbackCatalogOptions,
} from "@/components/settings/panels/fallback/fallback-catalog-options";
import {
  isModelPattern,
  tierCountPhrase,
  tierDisplayName,
} from "@/components/settings/panels/fallback/fallback-model-patterns";
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
 *  - `own-tier` - a row reaches it. `row` is the first such row of that tier,
 *    which is what "through <pattern> (row n)" names. `conflict` lists every
 *    tier that claims the model, first-listed (the handler) first, when there
 *    are two or more - decision 4's "first-listed handles it".
 *  - `default-tier` - no row reaches it and the draft names a default tier.
 *  - `no-tier` - no row reaches it and there is no default tier to go to.
 */
export type TestRouting =
  | {
      readonly kind: "own-tier";
      readonly tier: TestTierRef;
      /**
       * `null` only if the router and this lookup ever disagree about which
       * row matched. They share the protocol's identity and pattern matcher,
       * so that is not expected - but the header then drops "(row n)" rather
       * than reading row -1 in render.
       */
      readonly row: TestRowRef | null;
      readonly conflict: readonly TestTierClaim[] | null;
    }
  | { readonly kind: "default-tier"; readonly tier: TestTierRef }
  | { readonly kind: "no-tier"; readonly defaultTierGroupId: string | null };

/** The row "(row n)" names, and its value as the Model cell shows it. */
export interface TestRowRef {
  readonly candidateIndex: number;
  readonly value: string;
}

/**
 * The blocked model's display name, or its ID when the catalog does not list
 * it: the protocol's own routing identity, so the name the verdict prints is
 * the name the router matched patterns against.
 */
export function blockedModelLabel(
  model: string,
  catalog: readonly TierModelIdentity[] | null,
): string {
  return failedModelRoutingIdentity(model, catalog).label;
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
  // The router's own identity and predicate, so this finds the row it matched.
  const blocked = failedModelRoutingIdentity(model, catalog);
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
    row:
      candidateIndex === -1
        ? null
        : {
            candidateIndex,
            value: own.candidates[candidateIndex].modelFamily.trim(),
          },
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
 *  - `fallback-off` - the failure's override is `"off"`: nothing arms at all.
 *  - `tier-off` - the equivalent-model step does not run for this failure (not
 *    in its ladder, or after an early Notify); `steps` is what runs instead.
 *  - `after-tier` - it runs; `steps` is the draft's "If none of these work"
 *    tail.
 *  - `depends` - "another error" stands for several failures, and their own
 *    ladders do not give one answer; `tierRuns` is whether any of them reaches
 *    the equivalent-model step, which is what decides whether the walk is
 *    worth drawing at all.
 *
 * Every list ends at Notify: exhaustion always notifies (the ladder schema's
 * own rule), and a step stored after an early Notify never runs.
 */
export type TestNextSteps =
  | { readonly kind: "fallback-off" }
  | {
      readonly kind: "tier-off" | "after-tier";
      readonly steps: readonly FallbackRungKind[];
    }
  | { readonly kind: "depends"; readonly tierRuns: boolean };

/**
 * The failures "another error" stands for: every reason that arms a
 * traversal, other than a rate limit, for which the equivalent-model step is
 * eligible at all. A connection failure arms (its same-tuple retries) but can
 * never switch models, so counting it would make every answer "depends" about
 * a step it cannot take - and this panel is a test of that step.
 */
const OTHER_ERROR_REASONS: readonly HostNotificationStoppedReason[] =
  HOST_NOTIFICATION_STOPPED_REASONS.filter(
    (reason) =>
      reason !== "rate_limit" &&
      !EXCLUDED_FALLBACK_REASONS.has(reason) &&
      REASON_ELIGIBLE_RUNGS[reason].includes("tier"),
  );

function endingAtNotify(
  steps: readonly FallbackRungKind[],
): readonly FallbackRungKind[] {
  const at = steps.indexOf("notify");
  return at === -1 ? [...steps, "notify"] : steps.slice(0, at + 1);
}

/**
 * One failure's answer, as the host resolves its ladder (`resolveFallbackLadder`):
 * its override when the user set one, else the main order, narrowed to the
 * steps that can change this failure's outcome, and Notify always.
 */
function stepsForReason(
  policy: FallbackPolicy,
  reason: HostNotificationStoppedReason,
): Exclude<TestNextSteps, { readonly kind: "depends" }> {
  const ladder = effectiveLadderFor(policy, reason);
  if (ladder === "off") return { kind: "fallback-off" };
  const eligible = REASON_ELIGIBLE_RUNGS[reason];
  const reachable = endingAtNotify(
    ladder.filter((rung) => rung === "notify" || eligible.includes(rung)),
  );
  const tierAt = reachable.indexOf("tier");
  return tierAt === -1
    ? { kind: "tier-off", steps: reachable }
    : { kind: "after-tier", steps: reachable.slice(tierAt + 1) };
}

function sameNextSteps(a: TestNextSteps, b: TestNextSteps): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "fallback-off" || b.kind === "fallback-off") return true;
  if (a.kind === "depends" || b.kind === "depends") return false;
  return (
    a.steps.length === b.steps.length &&
    a.steps.every((step, at) => step === b.steps[at])
  );
}

export function testNextSteps(
  policy: FallbackPolicy,
  kind: TestFailureKind,
): TestNextSteps {
  if (kind === "rate_limit") return stepsForReason(policy, "rate_limit");
  // "Another error" names no single failure, so it is answered only when every
  // failure it stands for gives the same answer.
  const answers = OTHER_ERROR_REASONS.map((reason) =>
    stepsForReason(policy, reason),
  );
  const [first] = answers;
  if (answers.every((answer) => sameNextSteps(answer, first))) return first;
  return {
    kind: "depends",
    tierRuns: answers.some((answer) => answer.kind === "after-tier"),
  };
}

/** Whether the equivalent-model step runs for at least one failure the test stands for. */
export function testTierStepRuns(steps: TestNextSteps): boolean {
  return (
    steps.kind === "after-tier" || (steps.kind === "depends" && steps.tierRuns)
  );
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
 * The account a row's first usable match runs on, by name: the account's own
 * label, the Terminal account's for `null` on a provider that has accounts,
 * and nothing for `null` on one that has none (Traycer), where there is no
 * account to name.
 */
export function testAccountLabel(
  harnessId: HarnessId,
  profileId: string | null,
  labelFor: FallbackSettingsProfileLabel,
): string | null {
  if (profileId !== null) return labelFor(profileId);
  const gui = guiHarnessIdSchema.safeParse(harnessId);
  if (!gui.success || providerCliIdForHarness(gui.data) === null) return null;
  return TERMINAL_ACCOUNT_LABEL;
}

/**
 * What an answer says about one tier.
 *
 *  - `none` - nothing to draw from: no answer yet, or one that cannot be
 *    attributed (a tier name another tier shares - the transient state a
 *    rename passes through - would pair one tier's row with another's answer;
 *    the editor withholds in that case too, `previewForGroup`).
 *  - `rows` - the tier's own rows.
 *  - `elsewhere` - a WALK (the blocked dry run, which answers only the tier
 *    the host routed to) came back without this tier's rows: the host routed
 *    the model to `walkedTierId`, or to no tier at all. The two routings share
 *    the protocol's router and the groups sent, so what differs is the
 *    catalog each read the model's name from.
 */
export type TestTierPreview =
  | { readonly kind: "none" }
  | { readonly kind: "rows"; readonly rows: readonly TierCandidatePreview[] }
  | { readonly kind: "elsewhere"; readonly walkedTierId: string | null };

/**
 * `groups` are the tiers the answer was asked about, and ids compare TRIMMED:
 * the host trims a tier's name on the way in (`tierGroupSchema`), so its rows
 * name "flagship" for a tier sent as "flagship ".
 */
export function testPreviewForTier(input: {
  readonly candidates: readonly TierCandidatePreview[] | null;
  readonly groups: readonly TierGroup[];
  readonly tierIndex: number;
  /** A walk for one blocked tuple, rather than the editor's all-tier preview. */
  readonly walked: boolean;
}): TestTierPreview {
  const { candidates, groups, tierIndex, walked } = input;
  if (candidates === null) return { kind: "none" };
  const tier = groups[tierIndex];
  const tierId = tier.id.trim();
  const shared = groups.some(
    (group, at) => at !== tierIndex && group.id.trim() === tierId,
  );
  if (shared) return { kind: "none" };
  const rows = candidates.filter((row) => row.groupId.trim() === tierId);
  if (rows.length > 0 || !walked || tier.candidates.length === 0) {
    return { kind: "rows", rows };
  }
  const walkedRow = candidates.at(0);
  return {
    kind: "elsewhere",
    walkedTierId: walkedRow === undefined ? null : walkedRow.groupId,
  };
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
        tried === undefined
          ? null
          : testAccountLabel(candidate.harnessId, tried.profileId, labelFor),
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
 * Whether the tiers can be sent as a dry run: every tier named, and no two
 * with one name once trimmed - the host trims names, so "flagship" and
 * "flagship " are one tier to it. A blank name fails the request schema, and a
 * shared one makes the answer unattributable (`testPreviewForTier`); asking in
 * either state would spend a walk on a request that cannot be used.
 */
export function testableTierNames(groups: readonly TierGroup[]): boolean {
  const seen = new Set<string>();
  for (const group of groups) {
    const name = group.id.trim();
    if (name === "" || seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}

/** The failure kinds as the steps lines name them. */
export const TEST_FAILURE_PLURALS: Readonly<Record<TestFailureKind, string>> = {
  rate_limit: "rate limits",
  // Said only when every failure "another error" stands for agrees, so it can
  // claim all of them (a disagreement says "depends on the error" instead).
  other: "every other error",
};

/**
 * The lead the verdict carries while the master switch is off. The host arms
 * nothing then (`resolveFallbackLadder` returns no steps), so a bare "switches
 * here" would be false - but this page is where the user configures what it
 * WILL do, so the dry run is still shown, under this sentence.
 */
export const ROUTE_AUTOMATICALLY_OFF_LEAD =
  "Route automatically is off, so nothing switches on its own. With it on:";

/** Where the "If none of these work" words for a disagreement point. */
export const DEPENDS_ON_THE_ERROR = "depends on the error; see Overrides";

/** A routing that names a tier - the two kinds the full verdict draws. */
export type RoutedTestRouting = Exclude<
  TestRouting,
  { readonly kind: "no-tier" }
>;

/**
 * The routed tier's rows as the verdict draws them, or the one line that
 * replaces them when the host walked a different tier - a named tier over rows
 * with nothing under them would read as "this tier has nothing to try".
 */
export type TestRowsAnswer =
  | {
      readonly kind: "rows";
      readonly rows: readonly TestRow[];
      readonly status: "ready" | "pending" | "failed";
    }
  | { readonly kind: "elsewhere"; readonly walkedTierName: string | null };

/** The blocked model as the verdict names it. */
export interface TestBlockedModel {
  readonly harnessId: GuiHarnessId;
  readonly label: string;
}

/** Everything the verdict draws and the announcement says, in one shape. */
export type TestVerdictModel =
  | { readonly kind: "incomplete"; readonly text: string }
  | { readonly kind: "fallback-off"; readonly failure: TestFailureKind }
  | {
      readonly kind: "tier-off";
      readonly failure: TestFailureKind;
      /** What runs instead, or `null` when that depends on the error. */
      readonly steps: readonly FallbackRungKind[] | null;
    }
  | {
      readonly kind: "no-tier";
      readonly blocked: TestBlockedModel;
      readonly defaultTierGroupId: string | null;
      /** The step it goes straight to, or `null` when that depends on the error. */
      readonly next: FallbackRungKind | null;
    }
  | {
      readonly kind: "routed";
      readonly routing: RoutedTestRouting;
      readonly tierName: string;
      readonly blocked: TestBlockedModel;
      readonly simulated: boolean;
      readonly namesTestable: boolean;
      readonly answer: TestRowsAnswer;
      /** The steps after the tier, or `null` when they depend on the error. */
      readonly then: readonly FallbackRungKind[] | null;
      readonly failure: TestFailureKind;
    };

/**
 * The verdict, from the tuple's routing and the answers in hand.
 *
 * Two tier lists, on purpose (review C1). `groups` is the live draft: the
 * header routes on it and the rows are its rows, so a rename reads through at
 * once. `committedGroups` is what the walk was ASKED about - the tiers as last
 * committed, since a tier name commits on blur and a walk per keystroke would
 * stream answers into the live region. The two differ only by an uncommitted
 * name, so the routed tier sits at one index in both; when a transient name
 * collision routes them to different tiers, the rows wait for the commit
 * rather than borrow another tier's answer.
 */
export interface TestVerdictInput {
  /** Why there is no tuple yet, drawn when `tuple` is `null`. */
  readonly incomplete: string;
  /**
   * The complete tuple's blocked model and where it routes - over the live
   * draft (`routing`) and over the tiers the walk was asked about
   * (`committedRouting`) - or `null` until a provider and a model are known.
   */
  readonly tuple: {
    readonly blocked: TestBlockedModel;
    readonly routing: TestRouting;
    readonly committedRouting: TestRouting;
  } | null;
  readonly nextSteps: TestNextSteps;
  readonly failure: TestFailureKind;
  readonly groups: readonly TierGroup[];
  readonly committedGroups: readonly TierGroup[];
  readonly simulated: boolean;
  readonly namesTestable: boolean;
  readonly walk: {
    /** A walk was asked for; without one nothing is pending or failed. */
    readonly asked: boolean;
    readonly candidates: readonly TierCandidatePreview[] | null;
    readonly failed: boolean;
  };
  /** The editor's own non-blocked preview, for a host that cannot walk. */
  readonly unsimulated: readonly TierCandidatePreview[] | null;
  readonly catalog: FallbackCatalogOptions;
  readonly labelFor: FallbackSettingsProfileLabel;
}

export function testVerdictModel(input: TestVerdictInput): TestVerdictModel {
  const { tuple, nextSteps, failure } = input;
  if (tuple === null) return { kind: "incomplete", text: input.incomplete };
  const { routing, blocked } = tuple;
  if (nextSteps.kind === "fallback-off")
    return { kind: "fallback-off", failure };
  if (nextSteps.kind === "tier-off") {
    return { kind: "tier-off", failure, steps: nextSteps.steps };
  }
  if (nextSteps.kind === "depends" && !nextSteps.tierRuns) {
    return { kind: "tier-off", failure, steps: null };
  }
  const then = nextSteps.kind === "after-tier" ? nextSteps.steps : null;
  if (routing.kind === "no-tier") {
    return {
      kind: "no-tier",
      blocked,
      defaultTierGroupId: routing.defaultTierGroupId,
      next: then === null ? null : then[0],
    };
  }
  return {
    kind: "routed",
    routing,
    tierName: tierDisplayName(routing.tier.tierId, routing.tier.tierIndex),
    blocked,
    simulated: input.simulated,
    namesTestable: input.namesTestable,
    answer: routedAnswer(input, tuple.committedRouting, routing.tier.tierIndex),
    then,
    failure,
  };
}

function routedAnswer(
  input: TestVerdictInput,
  committed: TestRouting,
  tierIndex: number,
): TestRowsAnswer {
  const { groups, catalog, labelFor, walk } = input;
  const tier = groups[tierIndex];
  if (!input.simulated) {
    const preview = testPreviewForTier({
      candidates: input.unsimulated,
      groups,
      tierIndex,
      walked: false,
    });
    return {
      kind: "rows",
      rows: testRows({
        tier,
        preview: preview.kind === "rows" ? preview.rows : null,
        simulated: false,
        catalog,
        labelFor,
      }),
      status: "ready",
    };
  }
  const attributable =
    committed.kind !== "no-tier" && committed.tier.tierIndex === tierIndex;
  const preview = attributable
    ? testPreviewForTier({
        candidates: walk.candidates,
        groups: input.committedGroups,
        tierIndex,
        walked: true,
      })
    : ({ kind: "none" } satisfies TestTierPreview);
  if (preview.kind === "elsewhere" && !walk.failed) {
    return { kind: "elsewhere", walkedTierName: preview.walkedTierId };
  }
  return {
    kind: "rows",
    rows: testRows({
      tier,
      preview: preview.kind === "rows" ? preview.rows : null,
      simulated: true,
      catalog,
      labelFor,
    }),
    status: walkStatus(walk, attributable),
  };
}

/**
 * A failed walk is failed; an asked one is pending until it answers, and also
 * while the answer in hand belongs to a different tier than the header names
 * (a transient name collision mid-rename) - the commit will ask again.
 */
function walkStatus(
  walk: TestVerdictInput["walk"],
  attributable: boolean,
): "ready" | "pending" | "failed" {
  if (walk.failed) return "failed";
  if (walk.asked && (walk.candidates === null || !attributable)) {
    return "pending";
  }
  return "ready";
}

/** Steps as one phrase: "Try another account, then Notify you". */
export function testStepsPhrase(steps: readonly FallbackRungKind[]): string {
  return steps.map((step) => TEST_STEP_LABELS[step]).join(", then ");
}

/**
 * The verdict as ONE sentence, for the panel's polite status (review A1).
 *
 * The visible verdict is a tree of rows, pills and footers; announcing it
 * would read a run of fragments ("then", "then", "2 more") on every change.
 * This says what a person asked - which tier, and where the chat goes - in
 * the words the visible verdict uses.
 */
export function testVerdictSentence(
  model: TestVerdictModel,
  masterOff: boolean,
): string {
  const body = verdictBody(model);
  return masterOff && model.kind !== "incomplete"
    ? `${ROUTE_AUTOMATICALLY_OFF_LEAD} ${body}`
    : body;
}

function verdictBody(model: TestVerdictModel): string {
  switch (model.kind) {
    case "incomplete":
      return model.text;
    case "fallback-off":
      return `Your steps are turned off for ${TEST_FAILURE_PLURALS[model.failure]}, so Traycer doesn't try another model.`;
    case "tier-off":
      return model.steps === null
        ? `The equivalent-model step doesn't run for these errors, and what Traycer does instead ${DEPENDS_ON_THE_ERROR}.`
        : `The equivalent-model step is off for ${TEST_FAILURE_PLURALS[model.failure]}, so Traycer goes straight to ${testStepsPhrase(model.steps)}.`;
    case "no-tier":
      return `${model.blocked.label} is not in any tier, so there is no equivalent-model step; ${
        model.next === null
          ? `what happens next ${DEPENDS_ON_THE_ERROR}`
          : `it goes straight to ${TEST_STEP_LABELS[model.next]}`
      }.`;
    case "routed":
      return routedSentence(model);
  }
}

function routedSentence(
  model: Extract<TestVerdictModel, { readonly kind: "routed" }>,
): string {
  const start =
    model.routing.kind === "default-tier"
      ? `Traycer uses your default tier, ${model.tierName}`
      : `Traycer uses the ${model.tierName} tier`;
  const conflict =
    model.routing.kind === "own-tier" && model.routing.conflict !== null
      ? ` It is in ${tierCountPhrase(model.routing.conflict.length)}; ${tierDisplayName(model.routing.conflict[0].tierId, model.routing.conflict[0].tierIndex)} handles it until you fix the conflict.`
      : "";
  return `${routedAnswerSentence(model, start)}${conflict}`;
}

function routedAnswerSentence(
  model: Extract<TestVerdictModel, { readonly kind: "routed" }>,
  start: string,
): string {
  const { answer } = model;
  if (answer.kind === "elsewhere") {
    return answer.walkedTierName === null
      ? `${start} here, but this host would route it to no tier right now.`
      : `${start} here, but this host would use the ${answer.walkedTierName} tier right now.`;
  }
  if (answer.status === "pending")
    return `${start}. Checking what it would try.`;
  if (answer.status === "failed") return `${start}. Couldn't run the test.`;
  if (!model.simulated) return `${start}. This host can't simulate the walk.`;
  if (!model.namesTestable) {
    return `${start}. Give every tier its own name to see what each row would try.`;
  }
  const winner = switchTarget(answer.rows);
  if (winner !== null) {
    return winner.account === null
      ? `${start} and switches to ${winner.label}.`
      : `${start} and switches to ${winner.label} on ${winner.account}.`;
  }
  return model.then === null
    ? `${start}, but nothing in it would switch now; what happens next ${DEPENDS_ON_THE_ERROR}.`
    : `${start}, but nothing in it would switch now. Next: ${testStepsPhrase(model.then)}.`;
}

/** The match the chat would switch to, and the account its row runs on. */
function switchTarget(
  rows: readonly TestRow[],
): { readonly label: string; readonly account: string | null } | null {
  for (const row of rows) {
    if (row.answer.kind !== "matches") continue;
    const line = row.answer.lines.find((entry) => entry.status === "switches");
    if (line !== undefined) return { label: line.label, account: row.account };
  }
  return null;
}
