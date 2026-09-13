/**
 * The two host-scoped settings the `auto` permission mode depends on, plus the
 * per-provider judge switch.
 *
 * All five methods are OPTIONAL capabilities. None is in
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
 *
 * Neither may live in the CLI config's `features` block either: that store
 * re-parses on every read and fails CLOSED to defaults on any error, so a
 * harness id an older build does not recognize would take `agentRoles` down
 * with it. They get their own host config files instead
 * (`auto-judge.json`, and the account policy fetched through the cloud data
 * service), which is what these methods front.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";

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
export const autoJudgeKindSchema = z.enum(["provider", "traycer"]);
export type AutoJudgeKind = z.infer<typeof autoJudgeKindSchema>;

export const providersSetAutoJudgeRequestSchema = z.object({
  // The live GUI harness enum: this is a client→host slot, and the host
  // re-validates against its own adapter roster regardless, so accepting an id
  // a given build does not implement is a clean rejection rather than a
  // handshake problem.
  harnessId: guiHarnessIdSchema,
  autoJudge: autoJudgeKindSchema,
});
export type ProvidersSetAutoJudgeRequest = z.infer<
  typeof providersSetAutoJudgeRequestSchema
>;

export const providersSetAutoJudgeResponseSchema = z.object({
  /** The value now persisted, echoed so the settings row can settle on truth. */
  autoJudge: autoJudgeKindSchema,
});
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
 */
export const autoJudgeSelectionSchema = z.object({
  harnessId: z.string().min(1),
  model: z.string().min(1),
  /** Which of the harness's logged-in profiles to bill; `null` is ambient. */
  profileId: z.string().nullable(),
});
export type AutoJudgeSelection = z.infer<typeof autoJudgeSelectionSchema>;

export const autoJudgeEffectiveSchema = z.object({
  harnessId: z.string().min(1),
  model: z.string().min(1),
  source: z.enum(["selection", "default"]),
});
export type AutoJudgeEffective = z.infer<typeof autoJudgeEffectiveSchema>;

/** Known configuration blockers only; this does not probe availability. */
export const autoJudgeBlockedSchema = z.object({
  reason: z.enum(["provider-disabled", "no-default", "unsupported-harness"]),
});
export type AutoJudgeBlocked = z.infer<typeof autoJudgeBlockedSchema>;

export const autoJudgeGetRequestSchema = z.object({});
export type AutoJudgeGetRequest = z.infer<typeof autoJudgeGetRequestSchema>;

export const autoJudgeGetResponseSchema = z.object({
  selection: autoJudgeSelectionSchema.nullable(),
  // Unreleased 1.0 widened in place, like autoPolicy.get.readState. Older
  // hosts omit these fields; readers preserve their existing copy then.
  effective: autoJudgeEffectiveSchema.nullable().optional(),
  blocked: autoJudgeBlockedSchema.nullable().optional(),
});
export type AutoJudgeGetResponse = z.infer<typeof autoJudgeGetResponseSchema>;

export const autoJudgeGetV10 = defineRpcContract({
  method: "autoJudge.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoJudgeGetRequestSchema,
  responseSchema: autoJudgeGetResponseSchema,
});

export const autoJudgeSetRequestSchema = z.object({
  /** `null` clears the selection and restores the catalog default. */
  selection: autoJudgeSelectionSchema.nullable(),
});
export type AutoJudgeSetRequest = z.infer<typeof autoJudgeSetRequestSchema>;

export const autoJudgeSetResponseSchema = z.object({
  selection: autoJudgeSelectionSchema.nullable(),
  effective: autoJudgeEffectiveSchema.nullable().optional(),
  blocked: autoJudgeBlockedSchema.nullable().optional(),
});
export type AutoJudgeSetResponse = z.infer<typeof autoJudgeSetResponseSchema>;

export const autoJudgeSetV10 = defineRpcContract({
  method: "autoJudge.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoJudgeSetRequestSchema,
  responseSchema: autoJudgeSetResponseSchema,
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
 * (`<gitToplevel>/.traycer/auto-policy.md`) replaces the account policy when it
 * exists, and it is committed and edited in the repo - never through this RPC.
 * Modelling the discriminator now means the day a panel needs to say "this
 * workspace overrides your account policy", the field is already on the wire
 * and a new member rides an ordinary minor.
 */
export const autoPolicySourceSchema = z.enum(["account"]);
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
export const autoPolicyReadStateSchema = z.enum([
  "fresh",
  "stale",
  "unreadable",
]);
export type AutoPolicyReadState = z.infer<typeof autoPolicyReadStateSchema>;

export const autoPolicyGetRequestSchema = z.object({});
export type AutoPolicyGetRequest = z.infer<typeof autoPolicyGetRequestSchema>;

export const autoPolicyGetResponseSchema = z.object({
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
});
export type AutoPolicyGetResponse = z.infer<typeof autoPolicyGetResponseSchema>;

export const autoPolicyGetV10 = defineRpcContract({
  method: "autoPolicy.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoPolicyGetRequestSchema,
  responseSchema: autoPolicyGetResponseSchema,
});

export const autoPolicySetRequestSchema = z.object({
  /** Last-write-wins; an empty string is a real value that clears the policy. */
  body: z.string(),
});
export type AutoPolicySetRequest = z.infer<typeof autoPolicySetRequestSchema>;

export const autoPolicySetResponseSchema = z.object({
  updatedAt: z.string().nullable(),
});
export type AutoPolicySetResponse = z.infer<typeof autoPolicySetResponseSchema>;

export const autoPolicySetV10 = defineRpcContract({
  method: "autoPolicy.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: autoPolicySetRequestSchema,
  responseSchema: autoPolicySetResponseSchema,
});
