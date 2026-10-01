import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import {
  agentModeSchema,
  guiHarnessIdSchema,
  permissionModeSchema,
} from "@traycer/protocol/persistence/epic/foundation";
import { harnessIdSchema, type HarnessId } from "./agent/shared";
import {
  HOST_NOTIFICATION_STOPPED_REASONS,
  type HostNotificationStoppedReason,
} from "./notifications/payloads";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const FALLBACK_RUNG_KINDS = [
  "profile",
  "tier",
  "wait",
  "notify",
] as const;
export const fallbackRungKindSchema = lazySchema(() =>
  z.enum(FALLBACK_RUNG_KINDS),
);
export type FallbackRungKind = z.infer<typeof fallbackRungKindSchema>;

// A nonzero cancellation window is required even for headless chats. The wait
// cap defaults to a session-scale limit, with at most a week configurable.
export const FALLBACK_POLICY_LIMITS = {
  minGraceWindowSeconds: 5,
  maxGraceWindowSeconds: 300,
  minWaitMinutes: 1,
  maxWaitMinutes: 10_080,
} as const;

export const fallbackLadderSchema = lazySchema(() =>
  z
    .array(fallbackRungKindSchema)
    .max(FALLBACK_RUNG_KINDS.length)
    .refine((rungs) => new Set(rungs).size === rungs.length, {
      message: "Fallback rungs must be unique",
    }),
);

export const tierCandidateSchema = lazySchema(() =>
  z.object({
    harnessId: harnessIdSchema,
    // A model PATTERN (see `modelMatchesPattern`): `*` is the only wildcard,
    // and a pattern with none names one model exactly. The wire name predates
    // patterns and is kept, because renaming a stored and transmitted field
    // would break every released host and client that reads a policy.
    // Resolution against the live catalog is host-owned.
    modelFamily: z.string().trim().min(1),
    reasoningEffort: z.string().trim().min(1).nullable(),
  }),
);
export type TierCandidate = z.infer<typeof tierCandidateSchema>;

export const tierGroupSchema = lazySchema(() =>
  z.object({
    id: z.string().trim().min(1),
    candidates: z.array(tierCandidateSchema),
  }),
);
export type TierGroup = z.infer<typeof tierGroupSchema>;

/**
 * Whether `haystack` contains `family` as a whole word.
 *
 * The agent-selection guide's definition of "belongs to this model family"
 * (`dynamic-default.ts`). Fallback tier rows no longer use it: they hold
 * patterns, matched by {@link modelMatchesPattern}, which has no word boundary.
 * The two answer different questions and must stay separate - a family word is
 * a vendor vocabulary guess, a pattern is exactly what the user typed.
 *
 * A plain `includes()` is wrong for short family names: `omp` is a substring of
 * "c-omp-uter" and `pi` of "co-pi-lot". The boundary is letter-vs-non-letter
 * rather than `\b` so digit-adjacent slugs still match - `gpt` must keep
 * matching `gpt4` and `gpt-4o`, which a token split on alphanumerics would have
 * broken.
 *
 * `family` is interpolated into a regular expression, so it is escaped first.
 * That was inert while the only families were the selection guide's own two
 * literals; it stopped being inert when the fallback tier rung began matching a
 * family the USER typed into a tier group. Unescaped, `.*` would match every
 * model in every catalog and `(a+)+$` would hang the fallback path on the input
 * that failed to match. Callers also lower-case `family` themselves for the
 * same reason the haystack is lower-cased: the boundary class is `[^a-z]`, so
 * an upper-case letter inside `family` could never match at all.
 */
export function haystackHasFamilyWord(
  haystack: string,
  family: string,
): boolean {
  return new RegExp(`(^|[^a-z])${escapeRegExpLiteral(family)}([^a-z]|$)`).test(
    haystack,
  );
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A catalog model as the pattern matcher sees it: its ID and its display name.
 *
 * Structural on purpose, so the host's `GuiAgentModelOption` and the settings
 * editor's catalog rows pass as they are rather than through a projection.
 */
export type TierModelIdentity = {
  readonly slug: string;
  readonly label: string;
};

/**
 * Whether a tier row's `pattern` matches `model` - THE definition of "this row
 * covers this model", in the protocol so the engine's routing and walk, the
 * settings editor and its Test panel cannot give two answers about one
 * pattern.
 *
 *  - `*` matches any run of characters, including none. Nothing else is
 *    special: `.`, `(`, `[`, `+`, `?` and `$` are literal characters.
 *  - Case-insensitive. Whitespace around the pattern is ignored, as the stored
 *    schema trims it anyway.
 *  - Matched against the WHOLE ID or the WHOLE display name, never a
 *    substring of either: `opus` names a model called exactly "opus", and
 *    `*opus*` is how to say "contains opus". A pattern with no `*` is therefore
 *    an exact pick, by ID or by name, so an old exact pick survives a vendor
 *    re-IDing a model that keeps its name.
 *  - `*` alone matches every model. A blank pattern matches none.
 *
 * No regular expression is built, so there is nothing to escape and nothing
 * to backtrack into: the pattern is split on `*` and the pieces are placed left
 * to right with `startsWith`, `indexOf` and `endsWith`, which is bounded by the
 * pattern's length times the subject's. A user-typed `(a+)+$` is six literal
 * characters, not a catastrophic regex on the failure path. Placing each middle
 * piece at its LEFTMOST occurrence is exact for `*`-only globs, since a later
 * placement can only leave less room for the pieces after it.
 *
 * Not {@link haystackHasFamilyWord}, which stays the agent-selection guide's
 * whole-word family test. There is no word boundary here, by design: `*pi*`
 * matches "copilot", and the editor shows what a pattern really catches.
 */
export function modelMatchesPattern(
  pattern: string,
  model: TierModelIdentity,
): boolean {
  const pieces = patternPieces(pattern);
  if (pieces === null) return false;
  return (
    piecesMatchWhole(pieces, model.slug.toLowerCase()) ||
    piecesMatchWhole(pieces, model.label.toLowerCase())
  );
}

/** The pattern lower-cased and split on `*`; `null` for a blank pattern. */
function patternPieces(pattern: string): readonly string[] | null {
  const needle = pattern.trim().toLowerCase();
  if (needle.length === 0) return null;
  return needle.split("*");
}

/**
 * Whether `subject` is exactly `pieces[0]`, anything, `pieces[1]`, anything,
 * ..., `pieces[n-1]`. One piece means the pattern had no `*`, so it must equal
 * the subject.
 */
function piecesMatchWhole(pieces: readonly string[], subject: string): boolean {
  const first = pieces[0];
  if (pieces.length === 1) return first === subject;
  const last = pieces[pieces.length - 1];
  // The fixed prefix and suffix must both fit without overlapping.
  if (first.length + last.length > subject.length) return false;
  if (!subject.startsWith(first) || !subject.endsWith(last)) return false;
  const end = subject.length - last.length;
  let cursor = first.length;
  for (let index = 1; index < pieces.length - 1; index += 1) {
    const piece = pieces[index];
    if (piece.length === 0) continue;
    const at = subject.indexOf(piece, cursor);
    if (at === -1 || at + piece.length > end) return false;
    cursor = at + piece.length;
  }
  return true;
}

/**
 * The failed model as routing matches it: its ID, plus the display name the
 * failed harness's `catalog` gives that ID. With no catalog, or no entry for
 * the ID, the "name" is the ID again, which makes the match ID-only.
 *
 * Exported because a surface that explains a routing answer has to name the
 * row the router matched - the settings Test panel's "is in it through
 * <pattern> (row n)" - and it can only find that row with the SAME identity
 * {@link findTierGroupForFailedTuple} matched against. A copy of this rule
 * that drifted (a trim, another field) would pick a group here and find no row
 * in it there.
 */
export function failedModelRoutingIdentity(
  model: string,
  catalog: readonly TierModelIdentity[] | null,
): TierModelIdentity {
  const slug = model.toLowerCase();
  const entry =
    catalog === null
      ? undefined
      : catalog.find((candidate) => candidate.slug.toLowerCase() === slug);
  return { slug: model, label: entry === undefined ? model : entry.label };
}

/**
 * Step 1 of the tier walk: the group a failed tuple belongs to, or `null`.
 *
 * A candidate matches the failed tuple when it names the same harness and its
 * pattern matches the failed model ({@link modelMatchesPattern}). `null` makes
 * the rung ineligible rather than falling back to "walk every group": without a
 * group the host has no statement that any other model is equivalent to this
 * one, and walking the rest would move a chat from a standard model to a
 * frontier one - or the reverse - on no evidence at all.
 *
 * ## ID, plus the display name when a catalog is supplied
 *
 * `catalog` is the FAILED harness's model list, or `null`. With it the failed
 * model is matched by its ID and by the name that catalog gives the ID; with
 * `null`, by ID only. The function stays pure and its callers acquire the
 * catalog cache-only: the failed provider is the one most likely to be dead,
 * and probing it on every failure is the cost the old slug-only rule existed to
 * avoid. The two answers differ only where a pattern reaches a model through
 * its name alone - Claude's `default`, which `*opus*` matches through the label
 * "Default (Opus 5.5)" and which, with no catalog, belongs to no group and
 * routes through the default group instead.
 *
 * ## First-listed wins
 *
 * A model is meant to be in one group. When more than one group matches it
 * anyway - a new release, a catalog the editor could not read, a policy saved
 * before patterns - the FIRST-LISTED group handles it, and
 * {@link findTierConflicts} is how a surface shows the overlap. This retires
 * the most-specific-match rule (D128), which existed because family WORDS
 * nested (`gpt` is a whole word in every codex slug, `spark` included). A
 * pattern is the user's own claim, the editor refuses a choice that would
 * overlap, and list order is the one tiebreak a user can see.
 *
 * In the PROTOCOL because three surfaces ask it and must not disagree: the
 * engine's hop, the destination menu behind it, and the settings ladder
 * editor's inert-step hint - which asks it about a draft that exists only in
 * the renderer, so it cannot be answered by an RPC at all.
 */
export function findTierGroupForFailedTuple(
  groups: readonly TierGroup[],
  harnessId: HarnessId,
  model: string,
  catalog: readonly TierModelIdentity[] | null,
): TierGroup | null {
  const blocked = failedModelRoutingIdentity(model, catalog);
  return (
    groups.find((group) =>
      group.candidates.some(
        (candidate) =>
          candidate.harnessId === harnessId &&
          modelMatchesPattern(candidate.modelFamily, blocked),
      ),
    ) ?? null
  );
}

/**
 * The group a failed tuple ROUTES to: its own group under the first-listed
 * match above, else the user's default group, else nothing.
 *
 * The default is a CONFIGURATION, not a guess. A model in no group used to be
 * a dead end for the "equivalent model" step - `no-group`, straight to the
 * next rung - and a user who had set up a group of models they were happy to
 * fall to had no way to say "and use that one for anything I haven't listed".
 * `defaultTierGroupId` is that sentence. It is consulted only when the
 * specific match finds nothing, so a model that IS listed keeps routing to its
 * own group even when a default is set.
 *
 * One function for both consumers - the engine's scoping and the frozen
 * error-card verdict ({@link tierGroupsNameDestinationFor}) - so the two cannot
 * disagree about whether a default applies. An id naming no group (the schema
 * refuses it on save, but a stored policy is a stored policy) routes nowhere
 * rather than to a lookalike.
 */
export function routeTierGroupForFailedTuple(input: {
  readonly groups: readonly TierGroup[];
  readonly defaultTierGroupId: string | null;
  readonly harnessId: HarnessId;
  readonly model: string;
  /** The failed harness's catalog, or `null` for ID-only - see {@link findTierGroupForFailedTuple}. */
  readonly catalog: readonly TierModelIdentity[] | null;
}): TierGroup | null {
  const matched = findTierGroupForFailedTuple(
    input.groups,
    input.harnessId,
    input.model,
    input.catalog,
  );
  if (matched !== null) return matched;
  if (input.defaultTierGroupId === null) return null;
  return (
    input.groups.find((group) => group.id === input.defaultTierGroupId) ?? null
  );
}

/**
 * Whether a set of groups NAMES an equivalent-model destination for a tuple - a
 * question about CONFIGURATION, answered with no I/O at all.
 *
 * ## Why this is not the walk
 *
 * It answers a deliberately coarser question than the host's candidate walk,
 * and the difference is the whole reason it exists rather than being a second
 * copy of it. The walk asks "which candidate could a hop TAKE right now", which
 * needs a live catalog, an availability probe, an account and a gauge per
 * candidate - every one of them a fact about the world that can be true at
 * 10:00 and false at 10:01. This asks "does this setup point anywhere else at
 * all", which the groups settle on their own.
 *
 * That distinction is what lets the answer be FROZEN and what lets it be
 * answered CLIENT-SIDE. The host stores it on a failed attempt's durable
 * envelope and reads it for as long as the error card is on screen, so a
 * verdict that had folded in "codex is signed out" would withhold a control the
 * moment the user signed back in and never restore it. The settings panel asks
 * it about a draft policy that has not been saved, which no host call could
 * answer.
 *
 * `catalog` is the failed harness's list as the caller already holds it (the
 * host reads it cache-only at failure time; the settings panel passes the
 * editor's cached one), never a read this function makes.
 *
 * ## The failed model's own row is not somewhere else to go
 *
 * A row on another harness always counts. A row on the failed harness counts
 * unless it provably names ONLY the failed model: its pattern matches the
 * failed model and nothing else is known to match it - with a `catalog`, no
 * OTHER model in it matches; with `null`, the pattern has no `*`, so it is an
 * exact pick of that one model. A wildcard row with no catalog to check it
 * against therefore counts, which can over-offer: "Switch…" for a pattern that
 * turns out to reach only the failed model, a hop the walk's same-as-failed
 * step then declines. That is the safe direction for a FROZEN verdict - a
 * control withheld wrongly stays withheld for as long as the card is on
 * screen, while one offered wrongly costs a refused hop. A row that matches
 * nothing at all still counts, as it did before patterns: "that pattern is
 * empty right now" is a fact about the catalog, and this is a question about
 * configuration.
 */
export function tierGroupsNameDestinationFor(input: {
  readonly groups: readonly TierGroup[];
  /** The default group, consulted for a model in no group - see {@link routeTierGroupForFailedTuple}. */
  readonly defaultTierGroupId: string | null;
  readonly harnessId: HarnessId;
  readonly model: string;
  /** The failed harness's catalog, or `null` for ID-only - see {@link findTierGroupForFailedTuple}. */
  readonly catalog: readonly TierModelIdentity[] | null;
}): boolean {
  const group = routeTierGroupForFailedTuple(input);
  if (group === null) return false;
  const blocked = failedModelRoutingIdentity(input.model, input.catalog);
  return group.candidates.some(
    (candidate) =>
      !(
        candidate.harnessId === input.harnessId &&
        patternNamesOnlyBlockedModel(
          candidate.modelFamily,
          blocked,
          input.catalog,
        )
      ),
  );
}

/**
 * Whether a row on the failed harness names the failed model and provably
 * nothing else - the exclusion rule {@link tierGroupsNameDestinationFor}
 * documents.
 */
function patternNamesOnlyBlockedModel(
  pattern: string,
  blocked: TierModelIdentity,
  catalog: readonly TierModelIdentity[] | null,
): boolean {
  if (!modelMatchesPattern(pattern, blocked)) return false;
  if (catalog === null) return !pattern.includes("*");
  const blockedSlug = blocked.slug.toLowerCase();
  return !catalog.some(
    (entry) =>
      entry.slug.toLowerCase() !== blockedSlug &&
      modelMatchesPattern(pattern, entry),
  );
}

/** One group's claim on a model, inside a {@link TierConflict}. */
export type TierConflictClaim = {
  /** The group's position in the list. The lowest one handles the model. */
  readonly tierIndex: number;
  readonly tierId: string;
  /** The group's rows whose pattern matches the model, in row order. */
  readonly candidateIndexes: readonly number[];
};

/** A model that more than one group claims. */
export type TierConflict = {
  readonly harnessId: HarnessId;
  /** The catalog entry, exactly as the catalog passed in gives it. */
  readonly model: TierModelIdentity;
  /**
   * Two or more claims, in group order. `tiers[0]` is the group that handles
   * the model until the overlap is fixed: it is the first-listed match, which
   * is where {@link findTierGroupForFailedTuple} routes this model.
   */
  readonly tiers: readonly TierConflictClaim[];
};

/**
 * Every model that more than one group claims - the "one model, one tier" rule
 * as data, with no I/O.
 *
 * Shared by every surface that draws the rule: the editor's red rows, the
 * picker that refuses an overlapping choice, and the Test panel's "in two
 * tiers" line. A conflict is rendered state, never a save gate, and never a
 * per-candidate skip reason: routing already has an answer for it (the
 * first-listed group), so it is a fact about the policy rather than a verdict
 * on a row.
 *
 *  - Exact picks count. An exact `gpt-5.6-terra` in one group and `*gpt*` in
 *    another is a conflict on Terra.
 *  - Two rows of the SAME group matching one model are not a conflict.
 *  - Only models in a supplied catalog are checked, matched by ID or display
 *    name. A harness with no entry in `catalogsByHarness` contributes nothing:
 *    which models a pattern reaches is unknowable without the list.
 *
 * Ordered by harness, in the order harnesses first appear among the groups'
 * rows, then by catalog order within a harness.
 */
export function findTierConflicts(
  groups: readonly TierGroup[],
  catalogsByHarness: ReadonlyMap<HarnessId, readonly TierModelIdentity[]>,
): readonly TierConflict[] {
  const harnesses: HarnessId[] = [];
  for (const group of groups) {
    for (const candidate of group.candidates) {
      if (!harnesses.includes(candidate.harnessId)) {
        harnesses.push(candidate.harnessId);
      }
    }
  }
  const conflicts: TierConflict[] = [];
  for (const harnessId of harnesses) {
    const catalog = catalogsByHarness.get(harnessId);
    if (catalog === undefined) continue;
    for (const model of catalog) {
      const tiers: TierConflictClaim[] = [];
      groups.forEach((group, tierIndex) => {
        const candidateIndexes: number[] = [];
        group.candidates.forEach((candidate, candidateIndex) => {
          if (
            candidate.harnessId === harnessId &&
            modelMatchesPattern(candidate.modelFamily, model)
          ) {
            candidateIndexes.push(candidateIndex);
          }
        });
        if (candidateIndexes.length > 0) {
          tiers.push({ tierIndex, tierId: group.id, candidateIndexes });
        }
      });
      if (tiers.length > 1) conflicts.push({ harnessId, model, tiers });
    }
  }
  return conflicts;
}

/**
 * Every reason a tier candidate can fail to be offered, across BOTH surfaces
 * that enumerate candidates: `chat.fallback.listTargets` (the destination menu)
 * and `providers.fallbackPolicy.previewTierGroups` (the groups editor's
 * per-row preview). One vocabulary rather than one per method, because the two
 * describe the same walk and a user meeting the same refusal in two places must
 * not be told two different things.
 *
 * The host's `TierRungSkipReason` derives from this rather than the other way
 * round, so the wire enum is the source and the engine cannot grow a reason the
 * protocol has never heard of.
 *
 * `no-group` is the rung-level one: the failed tuple belongs to no group at
 * all, so there are no candidates to have verdicts. It never describes a
 * candidate - it describes an EMPTY list - which is why a response carries it
 * beside the array rather than inside it.
 *
 * `family-unmatched` keeps its id although rows now hold patterns: released
 * clients colour exactly that id red, so renaming it would silently un-red the
 * one state the user has to fix. Its rendered copy is "no model matches this
 * pattern". There is deliberately no reason for "in two tiers": a conflict is a
 * fact about the policy ({@link findTierConflicts}), not a verdict on a row.
 *
 * `already-tried` is not a property of the candidate either: it is a fact about
 * the traversal that is asking. It is in this union so a surface rendering "why
 * not" has ONE vocabulary; a caller with no traversal (the settings preview
 * passes no failed tuple and no tried set) simply never produces it, along with
 * `same-as-failed` and `tuple-unusable`, which are equally unreachable without
 * a chat. Those three staying in the union is deliberate: the copy exists on
 * both surfaces, so neither has to special-case a reason the other can emit.
 *
 * IMPORTANT - this enum is the VOCABULARY, not the wire encoding. Response
 * fields carrying a reason are `z.string()` beside a rendered `label`, so a
 * reason a released client has not heard of degrades to rendering its label
 * rather than failing the whole response - the same choice, for the same
 * stated reason, as `pendingFallback.reason` in `agent/gui/subscribe.ts`.
 * Parse a received reason with this schema to branch on it; fall back to the
 * label when it does not match. Consumers keep compile-time exhaustiveness by
 * mapping copy over this type with no `default` arm.
 */
export const TIER_RUNG_SKIP_REASONS = [
  "no-group",
  "harness-not-gui",
  "provider-unknown",
  "provider-unavailable",
  "profile-signed-out",
  "catalog-unreadable",
  "family-unmatched",
  "same-as-failed",
  "rate-limited",
  "tuple-unusable",
  "already-tried",
] as const;
export const tierRungSkipReasonSchema = lazySchema(() =>
  z.enum(TIER_RUNG_SKIP_REASONS),
);
export type TierRungSkipReason = z.infer<typeof tierRungSkipReasonSchema>;

export const fallbackPolicySchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean(),
      // Empty is valid: exhaustion always notifies, even without an explicit rung.
      ladder: fallbackLadderSchema,
      reasonOverrides: z
        .partialRecord(
          z.enum(HOST_NOTIFICATION_STOPPED_REASONS),
          z.union([fallbackLadderSchema, z.literal("off")]),
        )
        .optional(),
      graceWindowSeconds: z
        .number()
        .int()
        .min(FALLBACK_POLICY_LIMITS.minGraceWindowSeconds)
        .max(FALLBACK_POLICY_LIMITS.maxGraceWindowSeconds),
      maxWaitMinutes: z
        .number()
        .int()
        .min(FALLBACK_POLICY_LIMITS.minWaitMinutes)
        .max(FALLBACK_POLICY_LIMITS.maxWaitMinutes),
      returnToPreferred: z.enum(["prompt", "auto", "stay"]),
      tierGroups: z
        .array(tierGroupSchema)
        .refine(
          (groups) =>
            new Set(groups.map((group) => group.id)).size === groups.length,
          { message: "Tier group IDs must be unique" },
        ),
      /**
       * The group the "equivalent model" step uses for a model that is in NO
       * group, by id, or `null` for none - see {@link routeTierGroupForFailedTuple}.
       *
       * `.default(null)` rather than required, for the reason the since-removed
       * exclusion list carried one: a policy stored by a build that predates the
       * field must still parse, and a required field would turn every such row
       * into `storedPolicyUnreadable` on upgrade. The refinement below is at the
       * OBJECT level because it relates two fields: the id has to name one of the
       * groups beside it.
       */
      defaultTierGroupId: z.string().trim().min(1).nullable().default(null),
    })
    .refine(
      (policy) =>
        policy.defaultTierGroupId === null ||
        policy.tierGroups.some(
          (group) => group.id === policy.defaultTierGroupId,
        ),
      {
        message: "The default tier group must name an existing group",
        path: ["defaultTierGroupId"],
      },
    ),
);
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>;

/** Fresh data on every read; no caller can mutate another user's defaults. */
export function createDefaultFallbackPolicy(): FallbackPolicy {
  return {
    enabled: false,
    ladder: ["profile", "tier", "wait", "notify"],
    graceWindowSeconds: 15,
    maxWaitMinutes: 360,
    returnToPreferred: "prompt",
    // Tier seeding owns the distinction between never seeded and user emptied.
    tierGroups: [],
    // No groups, so no group to name. The host's tier seeding owns the seeded
    // default, set alongside the seeded groups and only when the user has not
    // chosen one; this bare default must not name a group that is not in it.
    defaultTierGroupId: null,
  };
}

export const providersFallbackPolicyGetRequestSchema = lazySchema(() =>
  z.object({}),
);
export type ProvidersFallbackPolicyGetRequest = z.infer<
  typeof providersFallbackPolicyGetRequestSchema
>;

export const providersFallbackPolicyGetResponseSchema = lazySchema(() =>
  z.object({
    policy: fallbackPolicySchema,
    // Settings can render and offer an explicit repair when stored data is bad.
    storedPolicyUnreadable: z.boolean(),
    // Derived from active traversals, never part of the persisted policy.
    inFlightCount: z.number().int().nonnegative(),
  }),
);
export type ProvidersFallbackPolicyGetResponse = z.infer<
  typeof providersFallbackPolicyGetResponseSchema
>;

export const providersFallbackPolicySetRequestSchema = lazySchema(() =>
  z.object({
    policy: fallbackPolicySchema,
  }),
);
export type ProvidersFallbackPolicySetRequest = z.infer<
  typeof providersFallbackPolicySetRequestSchema
>;

export const providersFallbackPolicySetResponseSchema = lazySchema(() =>
  z.object({
    policy: fallbackPolicySchema,
  }),
);
export type ProvidersFallbackPolicySetResponse = z.infer<
  typeof providersFallbackPolicySetResponseSchema
>;

/**
 * Which rungs can possibly help each failure reason - the parent plan's seeded
 * matrix, and the single source both the engine and the settings UI read.
 *
 * The reasoning behind each row is "would the rung change the outcome?" rather
 * than "is the rung available?":
 *
 *   - a `provider_unavailable` outage is the same infrastructure for every
 *     PROFILE of that provider, so the profile rung is inert - but a different
 *     provider entirely is not, so the tier rung stands;
 *   - `model_unavailable` is about one model, so only the tier rung answers it;
 *   - `provider_connection_failed` is usually the LOCAL network, in which case
 *     nothing helps; it stays eligible only so the engine's transient pre-retry
 *     runs and the ladder then exhausts honestly to notify;
 *   - a `wait` is meaningful only for a reason that HAS a reset boundary, which
 *     is `rate_limit` alone (and only when that boundary is verified - the
 *     engine gates that separately, per failure).
 *
 * An empty array means "no switching or waiting rung helps this reason". It is
 * NOT the same as exclusion: the traversal still arms, the user still gets a
 * cancellable window, and the ladder ends at `notify`. Exclusion is
 * {@link EXCLUDED_FALLBACK_REASONS}.
 *
 * ## Why this lives in the protocol package
 *
 * It is not a wire schema and nothing sends it. It is here because it has two
 * readers that must agree and cannot import each other: the host engine, which
 * narrows a user's ladder per failure, and the GUI's per-failure overrides
 * matrix, which draws a chip per (reason, rung) cell and has to distinguish
 * "turned off" from "cannot help". A second copy on the GUI side would render
 * a policy the engine does not execute the first time a row moves, and the
 * divergence would show as chips that lie rather than as a failure anyone
 * notices.
 *
 * `notify` never appears in a row. It is eligible for every reason that arms at
 * all, so listing it would say nothing; the ladder filter admits it
 * unconditionally, and the matrix has no column for it.
 */
export const REASON_ELIGIBLE_RUNGS: Readonly<
  Record<HostNotificationStoppedReason, readonly FallbackRungKind[]>
> = {
  rate_limit: ["profile", "tier", "wait"],
  provider_unavailable: ["tier"],
  billing: ["profile", "tier"],
  model_unavailable: ["tier"],
  auth: ["profile", "tier"],
  provider_connection_failed: [],
  // Excluded reasons carry no rungs at all; `FALLBACK_REASON_ARMING` below is
  // what actually stops them arming, and these rows exist so this record stays
  // exhaustive. An empty row here is NOT what excludes them - see the doc above.
  context_exhausted: [],
  request_rejected: [],
  turn_start_timeout: [],
  missing_terminal_event: [],
  background_work_failed: [],
  session_budget: [],
};

/**
 * Whether each reason arms a traversal at all, and the source
 * {@link EXCLUDED_FALLBACK_REASONS} is derived from.
 *
 * ## Why a total record and not a hand-kept set
 *
 * This decision used to live directly in a `ReadonlySet` literal, which made it
 * the ONE edit of a new reason's five that could be forgotten silently. The
 * other four are all exhaustive `Record`s or `switch`es and fail to compile when
 * skipped; a set does not, and the omission's effect is the largest of the five
 * - a reason that should arm nothing instead arms a traversal, and the user gets
 * a cancellable window whose only possible outcome is "Nothing else to try".
 * Missing a row here is now a type error like the rest.
 *
 * `"arms"` is not the same statement as a non-empty
 * {@link REASON_ELIGIBLE_RUNGS} row, which is why this is a second record rather
 * than a derivation from that one. `provider_connection_failed` arms with an
 * empty rung list on purpose (the transient pre-retry runs and the ladder
 * exhausts honestly to `notify`), so "no eligible rung" and "do not arm" have to
 * stay separately sayable.
 *
 * ## The arguments behind the `"excluded"` rows
 *
 * Three different ones, all about the fallback being unable to help:
 *
 *   - `context_exhausted` and `request_rejected` reproduce anywhere. The same
 *     input hits the same wall on the next provider, and rerouting a policy
 *     refusal to a different vendor to see if it says yes is a bad look on top
 *     of being useless.
 *   - `turn_start_timeout`, `missing_terminal_event` and
 *     `background_work_failed` are HOST-synthesized: they describe this host's
 *     view of a stream, not the provider's capacity. The Claude case that
 *     matters already has its own mechanism in the stale-session retry.
 *   - `session_budget` is scoped to the SESSION, on an account that is fine.
 *     Switching profile or tier relaunches it somewhere that was never the
 *     problem, and it has no reset boundary to wait on. Its remedy is a fresh
 *     session, which is what the error card's manual `retry` already does - so
 *     it is excluded from the AUTOMATIC traversal while still carrying a typed
 *     failure, which is what keeps those manual rungs on the card.
 *
 * A reason with no structured code at all derives `null` and is likewise never
 * eligible - which is the intended incentive to improve per-harness
 * classification rather than to guess here.
 *
 * The settings matrix collapses every excluded reason into one read-only row:
 * they are not a preference, so offering a control for them would invite a user
 * to turn on something that cannot run.
 */
const FALLBACK_REASON_ARMING: Readonly<
  Record<HostNotificationStoppedReason, "arms" | "excluded">
> = {
  rate_limit: "arms",
  provider_unavailable: "arms",
  billing: "arms",
  model_unavailable: "arms",
  auth: "arms",
  provider_connection_failed: "arms",
  context_exhausted: "excluded",
  request_rejected: "excluded",
  turn_start_timeout: "excluded",
  missing_terminal_event: "excluded",
  background_work_failed: "excluded",
  session_budget: "excluded",
};

/**
 * Reasons that arm NO traversal at all - not even a notify hold. The reasoning
 * per reason is on {@link FALLBACK_REASON_ARMING}, which this projects.
 *
 * Derived rather than declared, so the set cannot disagree with the record and a
 * new reason cannot reach it by omission. Built by filtering the taxonomy tuple
 * rather than by `Object.entries`, which would widen the key back to `string`
 * and force the exported type through a cast.
 */
export const EXCLUDED_FALLBACK_REASONS: ReadonlySet<HostNotificationStoppedReason> =
  new Set(
    HOST_NOTIFICATION_STOPPED_REASONS.filter(
      (reason) => FALLBACK_REASON_ARMING[reason] === "excluded",
    ),
  );

// These are new optional methods. Any later enum expansion must freeze this
// released line's vocabulary before adding the next method version.
export const providersFallbackPolicyGetV10 = defineRpcContract({
  method: "providers.fallbackPolicy.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersFallbackPolicyGetRequestSchema,
  responseSchema: providersFallbackPolicyGetResponseSchema,
});

export const providersFallbackPolicySetV10 = defineRpcContract({
  method: "providers.fallbackPolicy.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersFallbackPolicySetRequestSchema,
  responseSchema: providersFallbackPolicySetResponseSchema,
});

// 1.1 changes MEANING, not shape: from 1.1 a tier row's `modelFamily` is a
// pattern (`modelMatchesPattern`), where on 1.0 it was a family word matched on
// word boundaries. The bytes are identical, so both lines share one schema and
// the upgrades are identities. The minor exists so a client can ask what a
// host will DO with a row: a pattern editor on a 1.0 host would save `*opus*`,
// which that host's word matcher never matches, so the editor gates on the
// negotiated line and keeps the select-only cell below 1.1. An old client on a
// new host shows a pattern as an opaque pick, which is acceptable.
//
// Still off `released-baseline-surface.json`, like the 1.0 line, so the minor
// is unconstrained by the released floor.
export const providersFallbackPolicyGetV11 = defineRpcContract({
  method: "providers.fallbackPolicy.get",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: providersFallbackPolicyGetRequestSchema,
  responseSchema: providersFallbackPolicyGetResponseSchema,
});

export const providersFallbackPolicyGetUpgradeV10ToV11 = defineUpgradePath<
  typeof providersFallbackPolicyGetV10,
  typeof providersFallbackPolicyGetV11
>({
  from: { major: 1, minor: 0 },
  to: { major: 1, minor: 1 },
  upgradeRequest: (request) => ({ ...request }),
  upgradeResponse: (response) => ({ ...response }),
});

export const providersFallbackPolicySetV11 = defineRpcContract({
  method: "providers.fallbackPolicy.set",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: providersFallbackPolicySetRequestSchema,
  responseSchema: providersFallbackPolicySetResponseSchema,
});

export const providersFallbackPolicySetUpgradeV10ToV11 = defineUpgradePath<
  typeof providersFallbackPolicySetV10,
  typeof providersFallbackPolicySetV11
>({
  from: { major: 1, minor: 0 },
  to: { major: 1, minor: 1 },
  upgradeRequest: (request) => ({ ...request }),
  upgradeResponse: (response) => ({ ...response }),
});

// ---------------------------------------------------------------------------
// Settings-only methods (ticket 08). Their own section below the get/set pair
// rather than interleaved with it, so a compile error in any symbol from here
// down belongs to the settings surface and not to the engine's vocabulary or
// to the batch-2 policy read.
//
// All three are ADDITIVE on the live line: none is in `RELEASED_FLOOR_METHOD_
// NAMES` and none goes into `__fixtures__/released-baseline-surface.json`,
// exactly as `providers.fallbackPolicy.get`/`.set` were kept out. A released
// client never calls them; a host that predates them answers `unsupported`,
// which is what the registry's `degrade` says.
// ---------------------------------------------------------------------------

/**
 * "Restore the default tiers" - the tiers editor's empty state, and its footer
 * behind a confirm.
 *
 * Empty request: the seed is OWNED host-side - the three pattern tiers and the
 * default tier a first read writes - and the client has no business proposing
 * what the defaults are. It is not the same operation as `.set` with a
 * hand-built list, which is why it is a method rather than a client-side
 * convenience: only the host knows the seed a first read would have written,
 * and a restore writes exactly that, default tier included.
 */
export const providersFallbackPolicyRestoreTierGroupsRequestSchema = lazySchema(
  () => z.object({}),
);
export type ProvidersFallbackPolicyRestoreTierGroupsRequest = z.infer<
  typeof providersFallbackPolicyRestoreTierGroupsRequestSchema
>;

export const providersFallbackPolicyRestoreTierGroupsResponseSchema =
  lazySchema(() =>
    z.object({
      policy: fallbackPolicySchema,
    }),
  );
export type ProvidersFallbackPolicyRestoreTierGroupsResponse = z.infer<
  typeof providersFallbackPolicyRestoreTierGroupsResponseSchema
>;

/**
 * "Reset all fallback settings" - the danger zone.
 *
 * Returns the whole policy rather than an ack, so the panel re-renders from
 * what is now stored instead of assuming it knows what a reset produces. The
 * seed marker is cleared host-side, so the next read seeds this user exactly as
 * it seeds a new one; that is the store's decision, not a flag on the wire.
 */
export const providersFallbackPolicyResetRequestSchema = lazySchema(() =>
  z.object({}),
);
export type ProvidersFallbackPolicyResetRequest = z.infer<
  typeof providersFallbackPolicyResetRequestSchema
>;

export const providersFallbackPolicyResetResponseSchema = lazySchema(() =>
  z.object({
    policy: fallbackPolicySchema,
  }),
);
export type ProvidersFallbackPolicyResetResponse = z.infer<
  typeof providersFallbackPolicyResetResponseSchema
>;

/**
 * One candidate's verdict as the groups editor draws it.
 *
 * A projection of the engine's `TierCandidateVerdict`, not a copy, and the
 * differences are all "this surface has no chat":
 *
 *   - no `tuple` and no `selectable`. The preview passes no failed tuple, so
 *     the walk stops at the resolved slug and never assembles a run tuple;
 *     `selectable` would be `false` on every row, which is a field that says
 *     nothing while looking like it says something.
 *   - no `severity`. A settings preview is a picture of CONFIGURATION - "does
 *     this row resolve to a model, on which account" - and a live rate-limit
 *     status would go stale on screen with nothing to refresh it. Where a limit
 *     is the actual reason a candidate is out, `skipReason` already says so.
 *
 * `skipReason` is `z.string()` beside a rendered `skipLabel`, NOT
 * {@link tierRungSkipReasonSchema}, for the reason recorded on that enum: a
 * strict enum would fail the whole response on a client that has not heard of a
 * newly added reason, blanking a preview that was otherwise fine. Parse it with
 * that schema to branch; render `skipLabel` when it does not match.
 *
 * Frozen: the `previewTierGroups@1.0` row. {@link tierCandidatePreviewSchema}
 * is the live (1.1) row, which adds `matches`.
 */
export const tierCandidatePreviewSchemaV10 = lazySchema(() =>
  z.object({
    groupId: z.string(),
    candidateIndex: z.number().int().nonnegative(),
    harnessId: harnessIdSchema,
    modelFamily: z.string(),
    reasoningEffort: z.string().nullable(),
    /**
     * The first model the row resolved to, or `null` when it resolved to
     * nothing. From 1.1 it equals the first USABLE entry of `matches`, so a
     * client that reads only this field renders as it always did.
     */
    resolvedModel: z.string().nullable(),
    profileId: z.string().nullable(),
    skipReason: z.string().nullable(),
    /** Host-rendered; the only thing to show for a reason the client cannot parse. */
    skipLabel: z.string().nullable(),
    warnings: z.array(z.string()),
  }),
);
export type TierCandidatePreviewV10 = z.infer<
  typeof tierCandidatePreviewSchemaV10
>;

/**
 * One model a row's pattern matched, in the provider's catalog order - which is
 * the order the walk tries them in - with its own verdict. `skipReason` /
 * `skipLabel` follow the row-level rule above: an open string beside a
 * host-rendered label.
 */
export const tierCandidatePreviewMatchSchema = lazySchema(() =>
  z.object({
    model: z.string(),
    profileId: z.string().nullable(),
    skipReason: z.string().nullable(),
    skipLabel: z.string().nullable(),
  }),
);
export type TierCandidatePreviewMatch = z.infer<
  typeof tierCandidatePreviewMatchSchema
>;

/**
 * The live (1.1) preview row: the 1.0 row plus `matches`, every model the
 * row's pattern reaches in try order. Empty when the row matched nothing, in
 * which case the row-level `skipReason` says why. Required rather than
 * optional, because the transport returns an equal-minor response unparsed: an
 * optional field could not tell "this host does not list matches" from "this
 * row has none", and the negotiated line already answers the first question.
 */
export const tierCandidatePreviewSchema = lazySchema(() =>
  tierCandidatePreviewSchemaV10.extend({
    matches: z.array(tierCandidatePreviewMatchSchema),
  }),
);
export type TierCandidatePreview = z.infer<typeof tierCandidatePreviewSchema>;

/**
 * A draft row as the 1.1 preview accepts it: the stored row, except that the
 * pattern may be BLANK. The editor's "Add model or pattern" creates a blank
 * row, and the preview has to answer for it ("blank, skipped") instead of
 * failing the whole request, or every verdict's `candidateIndex` would stop
 * pairing with the row on screen. Widened as a union that keeps the stored
 * form as its first arm, so the 1.0 → 1.1 request stays additive; a
 * whitespace-only pattern trims to `""` through the second arm.
 */
export const tierCandidateDraftSchema = lazySchema(() =>
  tierCandidateSchema.extend({
    modelFamily: z.union([z.string().trim().min(1), z.string().trim().max(0)]),
  }),
);

/** A draft group for the 1.1 preview: the stored group over draft rows. */
export const tierGroupDraftSchema = lazySchema(() =>
  tierGroupSchema.extend({
    candidates: z.array(tierCandidateDraftSchema),
  }),
);

/** What kind of failure a Test-panel simulation stands for. */
export const TIER_PREVIEW_FAILURE_KINDS = ["rate_limit", "other"] as const;

/**
 * The hypothetical blocked run tuple the Test panel asks about.
 *
 * A full run tuple rather than a harness and model, because the host runs the
 * live walk against it: same-as-failed needs the model, permission-mode fit
 * needs the permission and agent modes, and the sibling-after-rate-limit rule
 * needs the failed account (`profileId`) and the failure `kind`. Reasoning
 * effort is not part of it - the walk takes each target's effort from the
 * row, not from the failed tuple.
 */
export const tierPreviewBlockedTupleSchema = lazySchema(() =>
  z.object({
    harnessId: guiHarnessIdSchema,
    model: z.string().min(1),
    /** `null` is the ambient login, as on `ChatRunSettings`. */
    profileId: z.string().nullable(),
    permissionMode: permissionModeSchema,
    agentMode: agentModeSchema,
    serviceTier: z.string().nullable(),
    kind: z.enum(TIER_PREVIEW_FAILURE_KINDS),
  }),
);
export type TierPreviewBlockedTuple = z.infer<
  typeof tierPreviewBlockedTupleSchema
>;

/**
 * Preview the DRAFT groups, which is why they travel in the request rather than
 * being read from the stored policy: the editor draws each row's verdict as it
 * is edited, and a preview of what is saved would lag every change by a save.
 *
 * Uncapped, deliberately. Each candidate costs a catalog read, so the temptation
 * is a `.max()` here - but the cost is already bounded by what this same user
 * can persist through `.set`, whose `tierGroups` is uncapped too. A cap only
 * here would produce a policy that can be saved and then not previewed, which is
 * a worse failure than a slow preview.
 *
 * Frozen: the `previewTierGroups@1.0` request, whose rows need a non-blank
 * pattern.
 */
export const providersFallbackPolicyPreviewTierGroupsRequestSchemaV10 =
  lazySchema(() =>
    z.object({
      groups: z.array(tierGroupSchema),
    }),
  );

/**
 * The live (1.1) request: draft rows, blank patterns included, and an optional
 * `blocked` tuple.
 *
 * Without `blocked` this is the settings preview: every draft group is
 * enumerated and nothing is routed. With it, the host runs the walk as if that
 * tuple had just failed - routing to one group, same-as-failed, permission-mode
 * fit and the sibling rule - which is what the Test panel draws. Optional
 * rather than defaulted so the editor's existing call, which has no tuple to
 * send, is unchanged.
 */
export const providersFallbackPolicyPreviewTierGroupsRequestSchema = lazySchema(
  () =>
    z.object({
      groups: z.array(tierGroupDraftSchema),
      /**
       * The draft's default tier; absent means none, and only a `blocked`
       * request routes. A blocked model that no row matches is walked in this
       * tier, exactly as the live walk routes it through the policy's
       * `defaultTierGroupId` - so the Test panel simulates the draft the user
       * is looking at, default included, rather than the stored policy.
       */
      defaultTierGroupId: z.string().nullable().optional(),
      blocked: tierPreviewBlockedTupleSchema.optional(),
    }),
);
export type ProvidersFallbackPolicyPreviewTierGroupsRequest = z.infer<
  typeof providersFallbackPolicyPreviewTierGroupsRequestSchema
>;

/**
 * Flat, carrying `groupId` per row exactly as the engine's verdict list does.
 * Nesting by group would re-shape the walk's own output for no gain and would
 * have to invent an answer for a group with no candidates.
 *
 * No `rungSkipReason` beside the array: that field exists to carry `no-group`,
 * which is step 1 routing a FAILED TUPLE, and this surface passes none. A field
 * that is structurally always `null` is one a reader has to disprove.
 *
 * Frozen: the `previewTierGroups@1.0` response.
 */
export const providersFallbackPolicyPreviewTierGroupsResponseSchemaV10 =
  lazySchema(() =>
    z.object({
      candidates: z.array(tierCandidatePreviewSchemaV10),
    }),
  );

/**
 * The live (1.1) response: the 1.0 response over rows that carry `matches`.
 *
 * Still no `rungSkipReason`, although a `blocked` request does route: a tuple
 * that belongs to no group and has no default group yields an empty list, and
 * WHICH group a tuple routes to is answered client-side by the pure
 * {@link routeTierGroupForFailedTuple} over the same draft, so the wire does
 * not carry a second copy of that verdict.
 */
export const providersFallbackPolicyPreviewTierGroupsResponseSchema =
  lazySchema(() =>
    z.object({
      candidates: z.array(tierCandidatePreviewSchema),
    }),
  );
export type ProvidersFallbackPolicyPreviewTierGroupsResponse = z.infer<
  typeof providersFallbackPolicyPreviewTierGroupsResponseSchema
>;

export const providersFallbackPolicyRestoreTierGroupsV10 = defineRpcContract({
  method: "providers.fallbackPolicy.restoreTierGroups",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersFallbackPolicyRestoreTierGroupsRequestSchema,
  responseSchema: providersFallbackPolicyRestoreTierGroupsResponseSchema,
});

export const providersFallbackPolicyResetV10 = defineRpcContract({
  method: "providers.fallbackPolicy.reset",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersFallbackPolicyResetRequestSchema,
  responseSchema: providersFallbackPolicyResetResponseSchema,
});

export const providersFallbackPolicyPreviewTierGroupsV10 = defineRpcContract({
  method: "providers.fallbackPolicy.previewTierGroups",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersFallbackPolicyPreviewTierGroupsRequestSchemaV10,
  responseSchema: providersFallbackPolicyPreviewTierGroupsResponseSchemaV10,
});

// 1.1 accepts blank draft rows and a `blocked` tuple, and answers every match
// per row. A client gates the first two on the negotiated line being >= 1.1: a
// 1.0 host refuses a blank row (the client's same-major projection fails
// before sending, as `DOWNGRADE_UNSUPPORTED`) and would silently ignore
// `blocked`, which the request projection strips.
export const providersFallbackPolicyPreviewTierGroupsV11 = defineRpcContract({
  method: "providers.fallbackPolicy.previewTierGroups",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: providersFallbackPolicyPreviewTierGroupsRequestSchema,
  responseSchema: providersFallbackPolicyPreviewTierGroupsResponseSchema,
});

/**
 * A 1.0 request is a 1.1 request with no `blocked` tuple, no default tier and
 * no blank rows. With no `blocked` tuple nothing is routed, so the absent
 * default changes nothing about the answer.
 *
 * A 1.0 response gains `matches` built from the one model 1.0 reports: a
 * single entry for a row that resolved, carrying the row's own verdict, and
 * none for a row that did not - whose row-level `skipReason` still says why.
 * That is exactly what a 1.0 host knows, so a 1.1 client renders one shape on
 * either host and learns from the negotiated line, not from the response,
 * that it cannot have more.
 */
export const providersFallbackPolicyPreviewTierGroupsUpgradeV10ToV11 =
  defineUpgradePath<
    typeof providersFallbackPolicyPreviewTierGroupsV10,
    typeof providersFallbackPolicyPreviewTierGroupsV11
  >({
    from: { major: 1, minor: 0 },
    to: { major: 1, minor: 1 },
    upgradeRequest: (request) => ({ groups: request.groups }),
    upgradeResponse: (response) => ({
      candidates: response.candidates.map((candidate) => ({
        ...candidate,
        matches:
          candidate.resolvedModel === null
            ? []
            : [
                {
                  model: candidate.resolvedModel,
                  profileId: candidate.profileId,
                  skipReason: candidate.skipReason,
                  skipLabel: candidate.skipLabel,
                },
              ],
      })),
    }),
  });
