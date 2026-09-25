/**
 * The two host-scoped settings the `auto` permission mode depends on, the
 * per-provider judge switch, and the host's log of recent judge decisions.
 *
 * Six methods:
 *
 * - `providers.setAutoJudge` - the per-provider judge switch.
 * - `autoJudge.get` / `autoJudge.set` - the host's judge selection.
 * - `autoPolicy.get` / `autoPolicy.set` - the account policy, proxied.
 * - `autoJudge.listRecent` - the fifth auto-mode method beside those four: the
 *   recent-decisions log, read-only and host-scoped.
 *
 * `autoJudge.get` / `autoJudge.set` also carry a `1.1` line, and it exists
 * because `1.0` is RELEASED (the `host-v1.3.2-staging.39` pin already
 * advertised it). An unset selection stopped meaning "the `traycer` harness" and
 * became Automatic, which can resolve to the conversation's own harness; a
 * `1.0` client reading that as `selection: null` would bill it to Traycer's
 * credits. So `1.1` gives `effective` a `{ source: "fallback" }` arm, and
 * the host projects that arm back onto `1.0` as "no judge can run", the safe
 * direction. See {@link projectAutoJudgeGetResponseToV10}. `1.1` also narrows
 * `blocked.reason` by dropping `no-default`, since a fallback candidate always
 * exists. In the other direction, a `1.0` host's `no-default` upgrades to
 * `unsupported-harness`, and `effective` stays `null` because a `1.0` host
 * never falls back ({@link autoJudgeGetUpgradeV10ToV11}).
 *
 * All six methods are OPTIONAL capabilities. None is in
 * `RELEASED_FLOOR_METHOD_NAMES` and none may ever enter it: the floor is the
 * `host-v1.0.0` name set, it is fail-closed on the name UNION, and a name
 * present on only one peer makes the whole connection incompatible - which is
 * exactly how `worktree.readScriptsAtRef` broke `1.0.1-rc.1`. So each declares
 * `degrade: { kind: "unsupported" }` in the registry and the renderer
 * feature-detects: a host that predates auto mode advertises none of them, and
 * the Agents / Providers panels render without those rows rather than failing.
 *
 * ## Why these are host RPCs at all
 *
 * Both settings are read by the HOST, at the approval seam, on whichever
 * machine the chat runs on. A remote host has to honour the same judge and the
 * same policy as the local one, so neither can live in client-side storage.
 * The decisions log is host-scoped for the same reason: it records what the
 * judge on THAT machine decided.
 *
 * Neither may live in the CLI config's `features` block either: that store
 * re-parses on every read and fails CLOSED to defaults on any error, so a
 * harness id an older build does not recognize would take `agentRoles` down
 * with it. They get their own host config files instead
 * (`auto-judge.json`, and the account policy fetched through the cloud data
 * service), which is what these methods front.
 */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

// ─── `providers.setAutoJudge` ─────────────────────────────────────────────

/**
 * Which classifier decides an `auto`-mode approval for one provider.
 *
 * `"traycer"` is the default everywhere (plan decision 3): one consistent
 * policy out of the box, with the provider's own classifier as an opt-in. Only
 * a harness whose catalog row carries `nativeAutoJudge: true` gets the switch
 * at all - a choice with one real option is not a choice - and the host still
 * resolves the effective judge per turn from catalog facts, so `"provider"`
 * here is a PREFERENCE, not a guarantee that the native judge ran.
 */
export const autoJudgeKindSchema = lazySchema(() =>
  z.enum(["provider", "traycer"]),
);
export type AutoJudgeKind = z.infer<typeof autoJudgeKindSchema>;

export const providersSetAutoJudgeRequestSchema = lazySchema(() =>
  z.object({
    // The live GUI harness enum: this is a client→host slot, and the host
    // re-validates against its own adapter roster regardless, so accepting an id
    // a given build does not implement is a clean rejection rather than a
    // handshake problem.
    harnessId: guiHarnessIdSchema,
    autoJudge: autoJudgeKindSchema,
  }),
);
export type ProvidersSetAutoJudgeRequest = z.infer<
  typeof providersSetAutoJudgeRequestSchema
>;

export const providersSetAutoJudgeResponseSchema = lazySchema(() =>
  z.object({
    /** The value now persisted, echoed so the settings row can settle on truth. */
    autoJudge: autoJudgeKindSchema,
  }),
);
export type ProvidersSetAutoJudgeResponse = z.infer<
  typeof providersSetAutoJudgeResponseSchema
>;

export const providersSetAutoJudgeV10 = defineRpcContract({
  method: "providers.setAutoJudge",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSetAutoJudgeRequestSchema,
  responseSchema: providersSetAutoJudgeResponseSchema,
});

// ─── `autoJudge.get` / `autoJudge.set` ────────────────────────────────────

/**
 * The harness+model that runs Traycer's judge, host-scoped.
 *
 * `harnessId` is a CHECKED STRING, not `guiHarnessIdSchema`, and the difference
 * matters in the response direction: this record is written by the host and
 * read back by whatever client connects, so pinning it to an enum would make a
 * selection written on a newer roster fail an older client's decode - and it is
 * the whole selection that fails, not the id. The client renders an id it does
 * not recognize as a plain label; the host is the only side that has to resolve
 * it to a real adapter.
 *
 * `null` for the whole record means "unset": the host falls back to the
 * `traycer` harness and the model the server catalog flags as the auto-judge
 * default, which is what makes auto mode work before anyone opens Settings.
 * From the `1.1` line on, "unset" is Automatic: that same Traycer default
 * first, and the conversation's own harness when Traycer cannot answer. The
 * record is unchanged; `effective` on the `1.1` response says which one a host
 * would use.
 *
 * FROZEN at this shape for the `1.0` and `1.1` lines, which bind it by
 * identity through their request and response objects. The live selection
 * below extends it; do not add fields here.
 */
export const autoJudgeSelectionSchemaPreEffort = lazySchema(() =>
  z.object({
    harnessId: z.string().min(1),
    model: z.string().min(1),
    /** Which of the harness's logged-in profiles to bill; `null` is ambient. */
    profileId: z.string().nullable(),
  }),
);
export type AutoJudgeSelectionPreEffort = z.infer<
  typeof autoJudgeSelectionSchemaPreEffort
>;

/**
 * The live selection (`1.2`): the frozen triple plus the reasoning effort the
 * judge runs the model at.
 *
 * `reasoningEffort` is one of the ids the model's catalog row advertises under
 * `supportedReasoningEfforts`, as a checked string for the same reason
 * `harnessId` is one: written by the host, read by whatever client connects.
 * `null` means "the host's default for this model", which is the LOWEST effort
 * the row advertises - a stage-1 verdict is a short classification, and the
 * measured difference on Grok 4.7 was 8 s at low against 14 s at the model's
 * own default - and the model's own default when it advertises none. A `1.1`
 * peer's write arrives as `null` (see the request upgrade), so a save from an
 * older desktop resets the effort to the default rather than inventing one.
 */
export const autoJudgeSelectionSchema = lazySchema(() =>
  autoJudgeSelectionSchemaPreEffort.extend({
    reasoningEffort: z.string().nullable(),
  }),
);
export type AutoJudgeSelection = z.infer<typeof autoJudgeSelectionSchema>;

/** The `1.0` / `1.1` reading of a live selection: the effort dropped. */
export function projectAutoJudgeSelectionPreEffort(
  selection: AutoJudgeSelection | null,
): AutoJudgeSelectionPreEffort | null {
  if (selection === null) return null;
  return {
    harnessId: selection.harnessId,
    model: selection.model,
    profileId: selection.profileId,
  };
}

/** A `1.0` / `1.1` selection read as live: no effort was ever chosen. */
export function upgradeAutoJudgeSelectionFromPreEffort(
  selection: AutoJudgeSelectionPreEffort | null,
): AutoJudgeSelection | null {
  if (selection === null) return null;
  return { ...selection, reasoningEffort: null };
}

// ─── The released `1.0` response ──────────────────────────────────────────
//
// FROZEN: `autoJudge.get@1.0` and `autoJudge.set@1.0` shipped in
// `host-v1.3.2-staging.39`. They bind these `...V10` objects by identity, and
// the canonical names further down belong to the `1.2` head, which is the line
// host resolvers answer and clients read. Do not add fields here.

export const autoJudgeEffectiveSchemaV10 = lazySchema(() =>
  z.object({
    harnessId: z.string().min(1),
    model: z.string().min(1),
    source: z.enum(["selection", "default"]),
  }),
);
export type AutoJudgeEffectiveV10 = z.infer<typeof autoJudgeEffectiveSchemaV10>;

/** Known configuration blockers only; this does not probe availability. */
export const autoJudgeBlockedSchemaV10 = lazySchema(() =>
  z.object({
    reason: z.enum(["provider-disabled", "no-default", "unsupported-harness"]),
  }),
);
export type AutoJudgeBlockedV10 = z.infer<typeof autoJudgeBlockedSchemaV10>;

export const autoJudgeGetRequestSchema = lazySchema(() => z.object({}));
export type AutoJudgeGetRequest = z.infer<typeof autoJudgeGetRequestSchema>;

export const autoJudgeGetResponseSchemaV10 = lazySchema(() =>
  z.object({
    selection: autoJudgeSelectionSchemaPreEffort.nullable(),
    // Widened in place while 1.0 was unreleased, like autoPolicy.get.readState.
    // Older hosts omit these fields; readers preserve their existing copy then.
    effective: autoJudgeEffectiveSchemaV10.nullable().optional(),
    blocked: autoJudgeBlockedSchemaV10.nullable().optional(),
  }),
);
export type AutoJudgeGetResponseV10 = z.infer<
  typeof autoJudgeGetResponseSchemaV10
>;

export const autoJudgeGetV10 = defineRpcContract({
  method: "autoJudge.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoJudgeGetRequestSchema,
  responseSchema: autoJudgeGetResponseSchemaV10,
});

/** The `1.0` / `1.1` request: a selection with no effort field. */
export const autoJudgeSetRequestSchemaPreEffort = lazySchema(() =>
  z.object({
    /** `null` clears the selection and restores the catalog default. */
    selection: autoJudgeSelectionSchemaPreEffort.nullable(),
  }),
);
export type AutoJudgeSetRequestPreEffort = z.infer<
  typeof autoJudgeSetRequestSchemaPreEffort
>;

export const autoJudgeSetResponseSchemaV10 = lazySchema(() =>
  z.object({
    selection: autoJudgeSelectionSchemaPreEffort.nullable(),
    effective: autoJudgeEffectiveSchemaV10.nullable().optional(),
    blocked: autoJudgeBlockedSchemaV10.nullable().optional(),
  }),
);
export type AutoJudgeSetResponseV10 = z.infer<
  typeof autoJudgeSetResponseSchemaV10
>;

export const autoJudgeSetV10 = defineRpcContract({
  method: "autoJudge.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoJudgeSetRequestSchemaPreEffort,
  responseSchema: autoJudgeSetResponseSchemaV10,
});

// ─── `autoJudge.get@1.1` / `autoJudge.set@1.1` ────────────────────────────
//
// `1.1` changes the RESPONSE only; both requests are the `1.0` ones.
//
// FROZEN: `1.1` shipped in `host-v1.3.2-staging.52`. Its response objects are
// the `...V11` ones below, on the pre-effort selection; the canonical names
// belong to the `1.2` head.

/**
 * The judge a host would use, as the `1.1` line reports it.
 *
 * `selection` / `default` are the `1.0` object, unchanged: an explicit pick,
 * or the Traycer harness on the catalog's auto-judge default model while that
 * harness's cached availability row is green.
 *
 * `fallback` means Automatic is falling back to the conversation's OWN harness
 * and profile. It carries no harness or model because a host-scoped read has
 * no conversation to name them from; the approval seam resolves them per
 * chat. A client must not read it as "Traycer", which is the billing error the
 * `1.0` downgrade below exists to prevent.
 */
export const autoJudgeEffectiveSchema = lazySchema(() =>
  z.discriminatedUnion("source", [
    z.object({
      harnessId: z.string().min(1),
      model: z.string().min(1),
      source: z.enum(["selection", "default"]),
    }),
    z.object({
      source: z.literal("fallback"),
    }),
  ]),
);
export type AutoJudgeEffective = z.infer<typeof autoJudgeEffectiveSchema>;

/**
 * Known configuration blockers on the `1.1` line; this does not probe
 * availability. They are reachable only under an explicit selection: with a
 * fallback candidate, Automatic always has a judge that can run, which is why
 * `1.0`'s `no-default` is gone.
 */
export const autoJudgeBlockedReasonSchema = lazySchema(() =>
  z.enum(["provider-disabled", "unsupported-harness"]),
);
export type AutoJudgeBlockedReason = z.infer<
  typeof autoJudgeBlockedReasonSchema
>;

export const autoJudgeBlockedSchema = lazySchema(() =>
  z.object({
    reason: autoJudgeBlockedReasonSchema,
  }),
);
export type AutoJudgeBlocked = z.infer<typeof autoJudgeBlockedSchema>;

export const autoJudgeGetResponseSchemaV11 = lazySchema(() =>
  z.object({
    selection: autoJudgeSelectionSchemaPreEffort.nullable(),
    // Still optional, as on `1.0`: a `1.0` host that predates these fields
    // omits them, and the `1.0 -> 1.1` upgrade cannot invent them. Absent
    // means "this host did not say", which readers keep distinct from `null`.
    effective: autoJudgeEffectiveSchema.nullable().optional(),
    blocked: autoJudgeBlockedSchema.nullable().optional(),
  }),
);
export type AutoJudgeGetResponseV11 = z.infer<
  typeof autoJudgeGetResponseSchemaV11
>;

export const autoJudgeSetResponseSchemaV11 = lazySchema(() =>
  z.object({
    selection: autoJudgeSelectionSchemaPreEffort.nullable(),
    effective: autoJudgeEffectiveSchema.nullable().optional(),
    blocked: autoJudgeBlockedSchema.nullable().optional(),
  }),
);
export type AutoJudgeSetResponseV11 = z.infer<
  typeof autoJudgeSetResponseSchemaV11
>;

export const autoJudgeGetV11 = defineRpcContract({
  method: "autoJudge.get",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: autoJudgeGetRequestSchema,
  responseSchema: autoJudgeGetResponseSchemaV11,
});

export const autoJudgeSetV11 = defineRpcContract({
  method: "autoJudge.set",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: autoJudgeSetRequestSchemaPreEffort,
  responseSchema: autoJudgeSetResponseSchemaV11,
});

// ─── `autoJudge.get@1.2` / `autoJudge.set@1.2` (the head) ─────────────────
//
// `1.2` adds `reasoningEffort` to the selection, on the `set` REQUEST and on
// both responses' `selection` echo. `effective` and `blocked` are the `1.1`
// objects, unchanged.

export const autoJudgeSetRequestSchema = lazySchema(() =>
  z.object({
    /** `null` clears the selection and restores the catalog default. */
    selection: autoJudgeSelectionSchema.nullable(),
  }),
);
export type AutoJudgeSetRequest = z.infer<typeof autoJudgeSetRequestSchema>;

export const autoJudgeGetResponseSchema = lazySchema(() =>
  z.object({
    selection: autoJudgeSelectionSchema.nullable(),
    effective: autoJudgeEffectiveSchema.nullable().optional(),
    blocked: autoJudgeBlockedSchema.nullable().optional(),
  }),
);
export type AutoJudgeGetResponse = z.infer<typeof autoJudgeGetResponseSchema>;

export const autoJudgeSetResponseSchema = lazySchema(() =>
  z.object({
    selection: autoJudgeSelectionSchema.nullable(),
    effective: autoJudgeEffectiveSchema.nullable().optional(),
    blocked: autoJudgeBlockedSchema.nullable().optional(),
  }),
);
export type AutoJudgeSetResponse = z.infer<typeof autoJudgeSetResponseSchema>;

export const autoJudgeGetV12 = defineRpcContract({
  method: "autoJudge.get",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: autoJudgeGetRequestSchema,
  responseSchema: autoJudgeGetResponseSchema,
});

export const autoJudgeSetV12 = defineRpcContract({
  method: "autoJudge.set",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: autoJudgeSetRequestSchema,
  responseSchema: autoJudgeSetResponseSchema,
});

// No `1.2 -> 1.1` projection: `reasoningEffort` is a KEY, and a `1.1` caller's
// non-strict decode drops it. The `1.0` projections below strip it themselves
// because they re-parse through the frozen `1.0` schema.

export const autoJudgeGetUpgradeV11ToV12 = defineUpgradePath<
  typeof autoJudgeGetV11,
  typeof autoJudgeGetV12
>({
  from: { major: 1, minor: 1 },
  to: { major: 1, minor: 2 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    selection: upgradeAutoJudgeSelectionFromPreEffort(response.selection),
  }),
});

export const autoJudgeSetUpgradeV11ToV12 = defineUpgradePath<
  typeof autoJudgeSetV11,
  typeof autoJudgeSetV12
>({
  from: { major: 1, minor: 1 },
  to: { major: 1, minor: 2 },
  // A `1.1` desktop cannot name an effort, so its save resets the effort to
  // the host's default rather than keeping a value it never saw.
  upgradeRequest: (request) => ({
    selection: upgradeAutoJudgeSelectionFromPreEffort(request.selection),
  }),
  upgradeResponse: (response) => ({
    ...response,
    selection: upgradeAutoJudgeSelectionFromPreEffort(response.selection),
  }),
});

/**
 * The `effective` / `blocked` pair a `1.0` peer is served.
 *
 * A fallback answer becomes `effective: null` with
 * `blocked: { reason: "provider-disabled" }`. That is deliberately the
 * pessimistic reading. A `1.0` desktop resolves a null selection with no
 * blocker to the Traycer pocket and prints "Uses your Traycer credits." while
 * the judge bills the user's own account. Given a blocker, it says "no judge
 * will run" instead. That is wrong in the safe direction: the host does judge,
 * but nothing claims a pocket it is not spending.
 *
 * Any other value is already a valid `1.0` value (the `selection` / `default`
 * arm is the `1.0` object, and the narrowed reasons are a subset of `1.0`'s),
 * so it passes through. An absent key stays absent.
 */
function projectAutoJudgeVerdictToV10(
  response: AutoJudgeGetResponse,
): Pick<AutoJudgeGetResponseV10, "effective" | "blocked"> {
  if (response.effective?.source === "fallback") {
    return { effective: null, blocked: { reason: "provider-disabled" } };
  }
  const projected: Pick<AutoJudgeGetResponseV10, "effective" | "blocked"> = {};
  if (response.effective !== undefined) {
    projected.effective = response.effective;
  }
  if (response.blocked !== undefined) {
    projected.blocked = response.blocked;
  }
  return projected;
}

/**
 * Serve a canonical `autoJudge.get@1.1` answer to a caller that negotiated
 * `1.0`.
 *
 * The generic dispatcher only re-parses within a major, and that re-parse
 * REJECTS a `{ source: "fallback" }` answer outright instead of degrading it.
 * So host dispatch calls this after canonical `1.1` validation and before
 * the caller's `1.0` parse. That is `projectResponseWithinMajor` in
 * `traycer-host`'s `handler.ts`, the seam `agent.roles.claim` uses. The
 * registry's `responseGrowthProjectionGated` on `1.1` is the reviewed claim
 * that this projection runs. The `1.0` contract is never wrapped in a
 * preprocess, because its schema object identity is what the freeze tests pin.
 */
export function projectAutoJudgeGetResponseToV10(
  response: AutoJudgeGetResponse,
): AutoJudgeGetResponseV10 {
  return autoJudgeGetResponseSchemaV10.parse({
    selection: projectAutoJudgeSelectionPreEffort(response.selection),
    ...projectAutoJudgeVerdictToV10(response),
  });
}

/** {@link projectAutoJudgeGetResponseToV10} for `autoJudge.set`'s echo. */
export function projectAutoJudgeSetResponseToV10(
  response: AutoJudgeSetResponse,
): AutoJudgeSetResponseV10 {
  return autoJudgeSetResponseSchemaV10.parse({
    selection: projectAutoJudgeSelectionPreEffort(response.selection),
    ...projectAutoJudgeVerdictToV10(response),
  });
}

/**
 * Read a `1.0` host's answer as `1.1`.
 *
 * - `effective`: the `1.0` object IS the `1.1` `selection` / `default` arm. It
 *   already names its own `source`, so it passes through unchanged, and so do
 *   `null` and absent. A `1.0` host never answers `fallback`, because it has no
 *   fallback behaviour. Upgrading anything to that arm would claim the
 *   conversation's provider judges while the old host escalates every approval.
 * - `blocked`: `no-default` upgrades to `unsupported-harness`. A `1.0` host
 *   says `no-default` when it cannot resolve the Traycer catalog default (which
 *   includes failing to list Traycer's models at all), so "this machine cannot
 *   run that judge; pick another" is the truthful `1.1` reading, and its remedy
 *   is the one the `1.0` copy gave. `effective` stays `null`, as that host sent
 *   it. The other reasons are `1.1` members already.
 */
function upgradeAutoJudgeVerdictFromV10(
  response: AutoJudgeGetResponseV10,
): Pick<AutoJudgeGetResponse, "effective" | "blocked"> {
  const upgraded: Pick<AutoJudgeGetResponse, "effective" | "blocked"> = {};
  if (response.effective !== undefined) {
    upgraded.effective = response.effective;
  }
  if (response.blocked !== undefined) {
    upgraded.blocked =
      response.blocked === null
        ? null
        : {
            reason:
              response.blocked.reason === "no-default"
                ? "unsupported-harness"
                : response.blocked.reason,
          };
  }
  return upgraded;
}

export const autoJudgeGetUpgradeV10ToV11 = defineUpgradePath<
  typeof autoJudgeGetV10,
  typeof autoJudgeGetV11
>({
  from: { major: 1, minor: 0 },
  to: { major: 1, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    selection: response.selection,
    ...upgradeAutoJudgeVerdictFromV10(response),
  }),
});

export const autoJudgeSetUpgradeV10ToV11 = defineUpgradePath<
  typeof autoJudgeSetV10,
  typeof autoJudgeSetV11
>({
  from: { major: 1, minor: 0 },
  to: { major: 1, minor: 1 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    selection: response.selection,
    ...upgradeAutoJudgeVerdictFromV10(response),
  }),
});

// ─── The judge's tier vocabulary ──────────────────────────────────────────

/**
 * Which tier of the judge's policy a refusal came from, in the host's own
 * category vocabulary (`auto-judge-categories.ts`, derived from the shipped
 * `defaults.md`). It is on the wire, not mirrored client-side, because hosts on
 * different versions ship different rule sets. A client keyed on a copy of
 * `defaults.md` would render the wrong sentence for a rule that changed tier.
 *
 * - `hard` - a hard-block rule. No policy may override it.
 * - `soft` - a soft-block rule. The user asking for this exact action clears it.
 * - `policy` - one of the user's own rules (the `User Policy` category).
 * - `unsure` - the judge reached no verdict it would stand behind (the
 *   `unsure` categories).
 *
 * Carried by the approval card's reason (`chat.subscribe@1.16`) and by every
 * recent-decisions entry. `null` wherever no rule decided.
 */
export const AUTO_JUDGE_TIER_VALUES = [
  "hard",
  "soft",
  "policy",
  "unsure",
] as const;
export const autoJudgeTierSchema = lazySchema(() =>
  z.enum(AUTO_JUDGE_TIER_VALUES),
);
export type AutoJudgeTier = z.infer<typeof autoJudgeTierSchema>;

// ─── `autoJudge.listRecent` ───────────────────────────────────────────────

/**
 * The bounds a host clamps `autoJudge.listRecent`'s `limit` to. The upper
 * bound is the host's ring size: the log keeps the last 200 decisions, so a
 * larger page could only ever return the same 200.
 */
export const AUTO_JUDGE_RECENT_LIMIT_MIN = 1;
export const AUTO_JUDGE_RECENT_LIMIT_MAX = 200;

/**
 * The longest `inputSummary` an entry may carry, in UTF-16 code units
 * (`String.length`, the unit zod's `.max` counts). The host truncates to it.
 */
export const AUTO_JUDGE_RECENT_INPUT_SUMMARY_MAX_CHARS = 200;

/**
 * Clamp a requested page size into
 * [`AUTO_JUDGE_RECENT_LIMIT_MIN`, `AUTO_JUDGE_RECENT_LIMIT_MAX`].
 *
 * The request schema accepts any integer, so an out-of-range ask is served
 * rather than refused. A client asking for "everything" gets everything the
 * ring holds. A zero or negative ask still gets the newest entry, because the
 * one thing a caller of this method cannot want is an empty page it did not
 * need a round trip for.
 */
export function clampAutoJudgeRecentLimit(limit: number): number {
  return Math.min(
    AUTO_JUDGE_RECENT_LIMIT_MAX,
    Math.max(AUTO_JUDGE_RECENT_LIMIT_MIN, limit),
  );
}

export const autoJudgeListRecentRequestSchema = lazySchema(() =>
  z.object({
    /** Page size; clamped by the host with {@link clampAutoJudgeRecentLimit}. */
    limit: z.number().int(),
  }),
);
export type AutoJudgeListRecentRequest = z.infer<
  typeof autoJudgeListRecentRequestSchema
>;

/**
 * What the judge that decided an entry was. `harnessId` is a CHECKED STRING
 * for the reason `autoJudgeSelectionSchema`'s is: a log written on a newer
 * roster must not fail an older client's decode of the whole page. `model` is
 * `null` when the host does not know it (a provider-native classifier).
 */
export const autoJudgeRecentJudgeSchema = lazySchema(() =>
  z.object({
    harnessId: z.string().min(1),
    model: z.string().min(1).nullable(),
  }),
);
export type AutoJudgeRecentJudge = z.infer<typeof autoJudgeRecentJudgeSchema>;

/**
 * One judge decision, as the host's recent-decisions log recorded it.
 *
 * The log is host-local: it is never logged and never synced. That is why a
 * chat title and a redacted command line may live in it. It carries no user
 * id, email, org id or notification room id, no raw tool input, no policy
 * body and no workspace path. `inputSummary` and `reason` are produced by the
 * host's secret redaction before they are written.
 */
export const autoJudgeRecentEntrySchema = lazySchema(() =>
  z.object({
    id: z.string().min(1),
    /** ISO-8601 time of the decision. */
    at: z.string().min(1),
    chatId: z.string().min(1),
    /**
     * The chat's title when the decision was made. A client that can see the
     * chat should resolve the live title from `chatId`; this is the fallback
     * for one that cannot.
     */
    chatTitle: z.string().nullable(),
    toolName: z.string().min(1),
    /** The redacted input on one line, truncated by the host. */
    inputSummary: z.string().max(AUTO_JUDGE_RECENT_INPUT_SUMMARY_MAX_CHARS),
    /**
     * `allow`: the judge let it run. `block`: it went to a person, or was
     * refused because nobody could be asked (`unattended`). `unavailable`: no
     * judge could decide it.
     */
    outcome: z.enum(["allow", "block", "unavailable"]),
    /** The judge stage that decided; `null` when none ran to a verdict. */
    stage: z.enum(["fast", "deep"]).nullable(),
    /** The rule's canonical name, exactly as the host's vocabulary spells it. */
    rule: z.string().nullable(),
    reason: z.string().nullable(),
    tier: autoJudgeTierSchema.nullable(),
    judge: autoJudgeRecentJudgeSchema.nullable(),
    /** Traycer's judge, or the provider's own classifier. */
    judgeKind: z.enum(["traycer", "provider"]),
    /**
     * How Traycer's judge was chosen: the explicit selection, the Automatic
     * default, or Automatic's fallback to the conversation's harness. `null`
     * for a provider-native decision.
     */
    judgeSource: z.enum(["selection", "default", "fallback"]).nullable(),
    /** No person could be asked: the chat was running for another agent. */
    unattended: z.boolean(),
    /**
     * Why no judge could decide, as the host names it. A CHECKED STRING, not
     * an enum, so a failure kind a newer host adds renders as a label rather
     * than failing the decode of the whole page.
     */
    failureKind: z.string().min(1).nullable(),
  }),
);
export type AutoJudgeRecentEntry = z.infer<typeof autoJudgeRecentEntrySchema>;

export const autoJudgeListRecentResponseSchema = lazySchema(() =>
  z.object({
    /** Newest first. */
    entries: z.array(autoJudgeRecentEntrySchema),
  }),
);
export type AutoJudgeListRecentResponse = z.infer<
  typeof autoJudgeListRecentResponseSchema
>;

export const autoJudgeListRecentV10 = defineRpcContract({
  method: "autoJudge.listRecent",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoJudgeListRecentRequestSchema,
  responseSchema: autoJudgeListRecentResponseSchema,
});

// ─── `autoPolicy.get` / `autoPolicy.set` ──────────────────────────────────

/**
 * The account-level auto-mode policy, proxied through the host.
 *
 * The record itself lives on traycer-server so it follows the user across
 * hosts; these methods exist so the GUI edits it through whichever host the
 * settings panel is bound to, rather than reaching the cloud directly and
 * showing a remote host a policy it is not actually running under.
 *
 * `source` is a single-member enum on purpose. The PROJECT policy
 * (`<gitToplevel>/.traycer/auto-policy.md`) does not replace the account
 * policy. It can only tighten it: its "Ask first" and "Never allow" sections
 * are added on top of the account policy's, and its "Environment" and "Always
 * allow" sections are ignored. It is committed and edited in the repo - never
 * through this RPC. Modelling the discriminator now means the day a panel
 * needs to say "this workspace adds restrictions to your account policy", the
 * field is already on the wire and a new member rides an ordinary minor.
 */
export const autoPolicySourceSchema = lazySchema(() => z.enum(["account"]));
export type AutoPolicySource = z.infer<typeof autoPolicySourceSchema>;

/**
 * How much this answer can be TRUSTED, independent of what it says.
 *
 * Orthogonal to `source`, which answers *which policy this is* and whose doc
 * above reserves it for a future `project` arm: folding availability into that
 * enum would make one field carry two axes.
 *
 * - `fresh` - read or refreshed successfully; `body` and `updatedAt` are
 *   current.
 * - `stale` - a cached copy a refresh could not confirm. `body` may be behind
 *   another device, and `updatedAt` is withheld for that reason, which is why
 *   a null stamp means "cannot tell" rather than "never edited".
 * - `unreadable` - there was no cached copy AND the fetch failed. `body: null`
 *   here means NOTHING; it is not "never saved". A panel must not offer to
 *   write over a policy it could not read.
 */
export const autoPolicyReadStateSchema = lazySchema(() =>
  z.enum(["fresh", "stale", "unreadable"]),
);
export type AutoPolicyReadState = z.infer<typeof autoPolicyReadStateSchema>;

export const autoPolicyGetRequestSchema = lazySchema(() => z.object({}));
export type AutoPolicyGetRequest = z.infer<typeof autoPolicyGetRequestSchema>;

export const autoPolicyGetResponseSchema = lazySchema(() =>
  z.object({
    /** The policy prose; `null` when the account has never saved one. */
    body: z.string().nullable(),
    /**
     * ISO-8601 of the last save, so the panel can warn before clobbering an edit
     * made on another device. `null` whenever `body` is - and also when the host
     * is serving a CACHED copy it could not refresh, which is why the panel must
     * treat a null here as "cannot tell", not as "never edited".
     */
    updatedAt: z.string().nullable(),
    source: autoPolicySourceSchema,
    /**
     * See {@link autoPolicyReadStateSchema}.
     *
     * `.optional()`, not required and not `.default("fresh")`, because this
     * property was added to `1.0` IN PLACE - the line is unreleased, so it takes
     * no minor of its own, and the consequence of that is that nothing on the
     * wire distinguishes a host whose resolver fills this field from one that
     * predates it. The negotiated version is `1.0` either way, so the READER has
     * to spell the fallback (`autoPolicyReadStateFor` in the GUI), exactly as
     * `ProviderCliState.autoJudge` makes its reader spell `?? "traycer"`. The
     * fallback is `fresh`: it reproduces the panel's behaviour before the field
     * existed, which is the only behaviour an older host can support.
     */
    readState: autoPolicyReadStateSchema.optional(),
    /**
     * The WHOLE shipped judge policy this host would apply, verbatim.
     *
     * The document, not a parsed tier: the client renders sections of it under
     * user-facing labels, and parsing it on the wire would freeze the section
     * list into the contract - every edit to the shipped policy would then be a
     * protocol change. It is bundled with the host
     * (`resources/auto-judge/defaults.md`) rather than fetched, so it is
     * readable even when the account policy above is not.
     *
     * `.optional()` for the same reason as `readState`. A client that does not
     * receive it renders no shipped-policy view at all - the right direction,
     * since a view is only honest about rules the host actually applies.
     */
    shippedDefaults: z.string().optional(),
  }),
);
export type AutoPolicyGetResponse = z.infer<typeof autoPolicyGetResponseSchema>;

export const autoPolicyGetV10 = defineRpcContract({
  method: "autoPolicy.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoPolicyGetRequestSchema,
  responseSchema: autoPolicyGetResponseSchema,
});

export const autoPolicySetRequestSchema = lazySchema(() =>
  z.object({
    /** Last-write-wins; an empty string is a real value that clears the policy. */
    body: z.string(),
  }),
);
export type AutoPolicySetRequest = z.infer<typeof autoPolicySetRequestSchema>;

export const autoPolicySetResponseSchema = lazySchema(() =>
  z.object({
    updatedAt: z.string().nullable(),
  }),
);
export type AutoPolicySetResponse = z.infer<typeof autoPolicySetResponseSchema>;

export const autoPolicySetV10 = defineRpcContract({
  method: "autoPolicy.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoPolicySetRequestSchema,
  responseSchema: autoPolicySetResponseSchema,
});
