import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { harnessIdSchema } from "./agent/shared";
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
  "destination-excluded",
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

export const fallbackPolicySchema = z.object({
  enabled: z.boolean(),
  // Excluded providers remain group members and valid sources; never switch TO them.
  // This unreleased policy accepts stored rows from before the field existed.
  destinationExclusions: z.array(harnessIdSchema).readonly().default([]),
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
});
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>;

/** Fresh data on every read; no caller can mutate another user's defaults. */
export function createDefaultFallbackPolicy(): FallbackPolicy {
  return {
    enabled: false,
    destinationExclusions: [],
    ladder: ["profile", "tier", "wait", "notify"],
    graceWindowSeconds: 15,
    maxWaitMinutes: 360,
    returnToPreferred: "prompt",
    // Tier seeding owns the distinction between never seeded and user emptied.
    tierGroups: [],
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
  // Excluded reasons carry no rungs at all; the set below is what actually
  // stops them arming, and these rows exist so the record is exhaustive.
  context_exhausted: [],
  request_rejected: [],
  turn_start_timeout: [],
  missing_terminal_event: [],
  background_work_failed: [],
};

/**
 * Reasons that arm NO traversal at all - not even a notify hold.
 *
 * Two different arguments, both about the fallback being unable to help:
 *
 *   - `context_exhausted` and `request_rejected` reproduce anywhere. The same
 *     input hits the same wall on the next provider, and rerouting a policy
 *     refusal to a different vendor to see if it says yes is a bad look on top
 *     of being useless.
 *   - `turn_start_timeout`, `missing_terminal_event` and
 *     `background_work_failed` are HOST-synthesized: they describe this host's
 *     view of a stream, not the provider's capacity. The Claude case that
 *     matters already has its own mechanism in the stale-session retry.
 *
 * A reason with no structured code at all derives `null` and is likewise never
 * eligible - which is the intended incentive to improve per-harness
 * classification rather than to guess here.
 *
 * The settings matrix collapses these five into one read-only row: they are not
 * a preference, so offering a control for them would invite a user to turn on
 * something that cannot run.
 */
export const EXCLUDED_FALLBACK_REASONS: ReadonlySet<HostNotificationStoppedReason> =
  new Set([
    "context_exhausted",
    "request_rejected",
    "turn_start_timeout",
    "missing_terminal_event",
    "background_work_failed",
  ]);

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
