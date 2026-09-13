import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { harnessIdSchema, type HarnessId } from "./agent/shared";
import {
  HOST_NOTIFICATION_STOPPED_REASONS,
  type HostNotificationStoppedReason,
} from "./notifications/payloads";

export const FALLBACK_RUNG_KINDS = [
  "profile",
  "tier",
  "wait",
  "notify",
] as const;
export const fallbackRungKindSchema = z.enum(FALLBACK_RUNG_KINDS);
export type FallbackRungKind = z.infer<typeof fallbackRungKindSchema>;

// A nonzero cancellation window is required even for headless chats. The wait
// cap defaults to a session-scale limit, with at most a week configurable.
export const FALLBACK_POLICY_LIMITS = {
  minGraceWindowSeconds: 5,
  maxGraceWindowSeconds: 300,
  minWaitMinutes: 1,
  maxWaitMinutes: 10_080,
} as const;

export const fallbackLadderSchema = z
  .array(fallbackRungKindSchema)
  .max(FALLBACK_RUNG_KINDS.length)
  .refine((rungs) => new Set(rungs).size === rungs.length, {
    message: "Fallback rungs must be unique",
  });

export const tierCandidateSchema = z.object({
  harnessId: harnessIdSchema,
  // Store family intent; resolution against the live catalog is host-owned.
  modelFamily: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).nullable(),
});
export type TierCandidate = z.infer<typeof tierCandidateSchema>;

export const tierGroupSchema = z.object({
  id: z.string().trim().min(1),
  candidates: z.array(tierCandidateSchema),
});
export type TierGroup = z.infer<typeof tierGroupSchema>;

/**
 * Whether `haystack` contains `family` as a whole word.
 *
 * THE definition of "belongs to this model family", and the reason it lives in
 * the protocol rather than beside either of its callers: the host matches a
 * failed model against a group with it, and the settings panel has to answer
 * the same question about a DRAFT the host has never seen. A second copy on the
 * client would be a second answer, and it would diverge on exactly the inputs
 * that are hard - which is what the boundary rule below exists for.
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

function candidateFamilyMatchesSlug(family: string, slug: string): boolean {
  const needle = family.trim().toLowerCase();
  if (needle.length === 0) return false;
  return needle === slug || haystackHasFamilyWord(slug, needle);
}

/**
 * Step 1 of the tier walk: the group a failed tuple belongs to, or `null`.
 *
 * A candidate matches the failed tuple when it names the same harness and its
 * family matches the failed model. `null` makes the rung ineligible rather than
 * falling back to "walk every group": without a group the host has no statement
 * that any other model is equivalent to this one, and walking the rest would
 * move a chat from a standard model to a frontier one - or the reverse - on no
 * evidence at all.
 *
 * Matched against the failed model's SLUG only, while step 3
 * (`resolveModelFamilyAgainstCatalog`, host-side) matches slug and label
 * together. The asymmetry is deliberate: the label would have to come from the
 * FAILED harness's catalog, which is the one catalog most likely to be
 * unreadable there because its provider has just died, and every family a
 * seeded group names - `opus`, `sonnet`, `gpt`, `grok` - appears in the slug of
 * the models it describes. Trading a rare label-only match for a new failure
 * mode on the hop path is the wrong way round.
 *
 * The consequence is real and known: `claude/default` is a live slug whose
 * family lives ONLY in its catalog label (`Default (Sonnet 4.5)`), so it
 * belongs to no group under this rule, and a chat on it has no equivalent-model
 * destination. That is the fact the settings hint and the error card both
 * report; changing this rule is a separate decision with its own failure mode.
 *
 * The MOST SPECIFIC match wins across all groups: of every candidate whose
 * harness and family match, the one whose family token is LONGEST decides the
 * group. Ties go to the earlier group. Group order is otherwise not
 * load-bearing (D128).
 *
 * First-match was the obvious rule and it was wrong, because families nest.
 * The seeded groups name codex `gpt` in the frontier group and codex `spark` in
 * the standard one, and `gpt` is a whole word in every codex slug there is.
 * Under first-match a rate-limited light-model chat was routed to `frontier`
 * and offered opus at effort high: the exact harm the paragraph above says this
 * step exists to prevent, produced by the step itself.
 *
 * Requiring the seeded families to be DISJOINT instead was considered and
 * rejected on evidence - codex's live catalog carries no stable tier
 * vocabulary, so disjointness forces generation codenames (`astra`), and most
 * live codex slugs would then match no family at all and get no tier fallback
 * whatsoever. Mis-routing one model is a worse offer; matching nothing is no
 * offer. Length is the tiebreak because a longer family is a narrower claim.
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
): TierGroup | null {
  const slug = model.toLowerCase();
  let best: { readonly group: TierGroup; readonly length: number } | null =
    null;
  for (const group of groups) {
    for (const candidate of group.candidates) {
      if (candidate.harnessId !== harnessId) continue;
      const needle = candidate.modelFamily.trim().toLowerCase();
      if (!candidateFamilyMatchesSlug(candidate.modelFamily, slug)) continue;
      // Strictly greater, so an equal-length match in a LATER group never
      // displaces the earlier one - that is the documented tie rule.
      if (best === null || needle.length > best.length) {
        best = { group, length: needle.length };
      }
    }
  }
  return best?.group ?? null;
}

/**
 * The group a failed tuple ROUTES to: its own group under the most-specific
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
}): TierGroup | null {
  const matched = findTierGroupForFailedTuple(
    input.groups,
    input.harnessId,
    input.model,
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
 * The failed model's own entry is not somewhere else to go - matched at
 * FAMILY level here rather than on a resolved slug, because
 * resolving a slug is exactly the catalog read this function exists not to do.
 * Family-level is the coarser of the two in the safe direction: it can only
 * discard a candidate that is very likely the model itself, never invent one.
 */
export function tierGroupsNameDestinationFor(input: {
  readonly groups: readonly TierGroup[];
  /** The default group, consulted for a model in no group - see {@link routeTierGroupForFailedTuple}. */
  readonly defaultTierGroupId: string | null;
  readonly harnessId: HarnessId;
  readonly model: string;
}): boolean {
  const group = routeTierGroupForFailedTuple(input);
  if (group === null) return false;
  const slug = input.model.toLowerCase();
  return group.candidates.some((candidate) => {
    return !(
      candidate.harnessId === input.harnessId &&
      candidateFamilyMatchesSlug(candidate.modelFamily, slug)
    );
  });
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
export const tierRungSkipReasonSchema = z.enum(TIER_RUNG_SKIP_REASONS);
export type TierRungSkipReason = z.infer<typeof tierRungSkipReasonSchema>;

export const fallbackPolicySchema = z
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
      policy.tierGroups.some((group) => group.id === policy.defaultTierGroupId),
    {
      message: "The default tier group must name an existing group",
      path: ["defaultTierGroupId"],
    },
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
    // A configuration the user makes, never a seed: the seeded groups are a
    // starting point, and silently routing every unlisted model into one of
    // them would be a decision taken on their behalf.
    defaultTierGroupId: null,
  };
}

export const providersFallbackPolicyGetRequestSchema = z.object({});
export type ProvidersFallbackPolicyGetRequest = z.infer<
  typeof providersFallbackPolicyGetRequestSchema
>;

export const providersFallbackPolicyGetResponseSchema = z.object({
  policy: fallbackPolicySchema,
  // Settings can render and offer an explicit repair when stored data is bad.
  storedPolicyUnreadable: z.boolean(),
  // Derived from active traversals, never part of the persisted policy.
  inFlightCount: z.number().int().nonnegative(),
});
export type ProvidersFallbackPolicyGetResponse = z.infer<
  typeof providersFallbackPolicyGetResponseSchema
>;

export const providersFallbackPolicySetRequestSchema = z.object({
  policy: fallbackPolicySchema,
});
export type ProvidersFallbackPolicySetRequest = z.infer<
  typeof providersFallbackPolicySetRequestSchema
>;

export const providersFallbackPolicySetResponseSchema = z.object({
  policy: fallbackPolicySchema,
});
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
 * "Restore the default model groups" - the groups editor's empty state.
 *
 * Empty request: the seed is DERIVED host-side from the live provider set, and
 * the client has no business proposing what the defaults are. It is not the
 * same operation as `.set` with a hand-built list, which is why it is a method
 * rather than a client-side convenience: only the host can build a seed that
 * matches what a first read would have produced for this user.
 */
export const providersFallbackPolicyRestoreTierGroupsRequestSchema = z.object(
  {},
);
export type ProvidersFallbackPolicyRestoreTierGroupsRequest = z.infer<
  typeof providersFallbackPolicyRestoreTierGroupsRequestSchema
>;

export const providersFallbackPolicyRestoreTierGroupsResponseSchema = z.object({
  policy: fallbackPolicySchema,
});
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
export const providersFallbackPolicyResetRequestSchema = z.object({});
export type ProvidersFallbackPolicyResetRequest = z.infer<
  typeof providersFallbackPolicyResetRequestSchema
>;

export const providersFallbackPolicyResetResponseSchema = z.object({
  policy: fallbackPolicySchema,
});
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
 */
export const tierCandidatePreviewSchema = z.object({
  groupId: z.string(),
  candidateIndex: z.number().int().nonnegative(),
  harnessId: harnessIdSchema,
  modelFamily: z.string(),
  reasoningEffort: z.string().nullable(),
  /** The slug the family resolved to, or `null` when it resolved to nothing. */
  resolvedModel: z.string().nullable(),
  profileId: z.string().nullable(),
  skipReason: z.string().nullable(),
  /** Host-rendered; the only thing to show for a reason the client cannot parse. */
  skipLabel: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type TierCandidatePreview = z.infer<typeof tierCandidatePreviewSchema>;

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
 */
export const providersFallbackPolicyPreviewTierGroupsRequestSchema = z.object({
  groups: z.array(tierGroupSchema),
});
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
 */
export const providersFallbackPolicyPreviewTierGroupsResponseSchema = z.object({
  candidates: z.array(tierCandidatePreviewSchema),
});
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
  requestSchema: providersFallbackPolicyPreviewTierGroupsRequestSchema,
  responseSchema: providersFallbackPolicyPreviewTierGroupsResponseSchema,
});
