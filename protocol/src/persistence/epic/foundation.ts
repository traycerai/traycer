import { z } from "zod";
import {
  DEFAULT_AGENT_MODE,
  agentModeSchema,
  type AgentMode,
} from "@traycer/protocol/common/schemas";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export { DEFAULT_AGENT_MODE, agentModeSchema, type AgentMode };

/**
 * The grammar of an agent identity's id - one ASCII alphanumeric, then up to 35
 * more alphanumerics or underscores (36 max, no dash, no dot, no slash). The
 * same rule `packages/common` enforces where identities are minted; the protocol
 * cannot import it, so it is restated here and must move with it.
 *
 * Checked at the wire so a malformed id - a traversal string, an empty one -
 * is a 400 at parse rather than a throw inside a host resolver that joins it
 * into a room id, a blob key or a directory. Defined HERE, in the persistence
 * base, because the chat's run-settings tuple carries an `identityId` and
 * `persistence/` must not depend on `host/`; `host/agent-identity/schemas.ts`
 * re-exports it for the `agentIdentity.*` family.
 */
export const AGENT_IDENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{0,35}$/;

export const agentIdentityIdSchema = lazySchema(() =>
  z.string().regex(AGENT_IDENTITY_ID_PATTERN),
);
export type AgentIdentityId = z.infer<typeof agentIdentityIdSchema>;

/**
 * Foundational sub-schemas used across the epic persistence shape:
 * parent reference, token usage, harness ids, permission mode, and chat
 * run settings.
 *
 * Persistence keeps its own harness enums (separate from the host RPC
 * enum in `protocol/host/agent/shared.ts`) so persistence can stay
 * stable while RPC contracts evolve. Names match across layers.
 */

// ---- Parent reference ------------------------------------------------- //

export const parentArtifactReferenceSchema = lazySchema(() =>
  z.object({
    parentId: z.string().nullable(),
  }),
);
export type ParentArtifactReference = z.infer<
  typeof parentArtifactReferenceSchema
>;

// ---- Token usage ----------------------------------------------------- //

export const tokenUsageSchema = lazySchema(() =>
  z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    cacheReadInputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
    // Adapter-normalized "tokens currently occupying the context window".
    // Single canonical numerator for the "% context left" chip - avoids
    // double-counting cache reads on OpenAI-style SDKs where cached input
    // is a subset of input. See `runtimeTokenUsageSchema.contextTokens`.
    contextTokens: z.number().optional(),
    // Model context window at this turn. Adapter-sourced from its SDK; never
    // hardcoded.
    contextWindow: z.number().optional(),
    // Always-present tokens (fixed system prompt + tools) that the renderer
    // folds into the displayed used total while keeping contextWindow as the
    // reported model capacity. Harnesses without a separate baseline omit it.
    // See `runtimeTokenUsageSchema`.
    contextBaselineTokens: z.number().optional(),
    // Cumulative billed cost for the turn in USD, where the SDK reports it
    // (Claude/OpenCode). Omitted by harnesses without a price; the cost row in
    // the usage tooltip hides without it. See `runtimeTokenUsageSchema.costUsd`.
    costUsd: z.number().optional(),
  }),
);
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

// ---- Harness identity ------------------------------------------------ //

export const guiHarnessIdSchema = lazySchema(() =>
  z.enum([
    "claude",
    "codex",
    "opencode",
    "traycer",
    "cursor",
    "grok",
    "qwen",
    "kiro",
    "droid",
    "kimi",
    "copilot",
    "kilocode",
    "openrouter",
    "amp",
    "devin",
    "pi",
    "hermes",
    "omp",
    "huggingface",
    "reasonix",
    "antigravity",
  ]),
);
export type GuiHarnessId = z.infer<typeof guiHarnessIdSchema>;

/**
 * Frozen copy of the persisted harness enum as the released
 * `chat.subscribe@1.0–1.6` lines shipped it - everything before Reasonix, which
 * first rides `1.7`.
 *
 * This is the SECOND independent copy of the harness enum (the first lives in
 * `host/agent/shared.ts` as `guiHarnessIdSchemaPreReasonix`). They are kept
 * separate on purpose: this one is the PERSISTED spelling, and it reaches the
 * wire through `chatRunSettingsSchema` on released snapshot / `queueChanged`
 * frames. Do NOT add new harnesses here - extend `guiHarnessIdSchema` above.
 */
export const guiHarnessIdSchemaPreReasonix = lazySchema(() =>
  z.enum([
    "claude",
    "codex",
    "opencode",
    "traycer",
    "cursor",
    "grok",
    "qwen",
    "kiro",
    "droid",
    "kimi",
    "copilot",
    "kilocode",
    "openrouter",
    "amp",
    "devin",
    "pi",
    "hermes",
    "omp",
    "huggingface",
  ]),
);
export type GuiHarnessIdPreReasonix = z.infer<
  typeof guiHarnessIdSchemaPreReasonix
>;

/**
 * Frozen copy of the persisted harness enum as `cli-v1.3.0` / `host-v1.3.0`
 * shipped it - everything before Antigravity, which first rides
 * `chat.subscribe@1.9`, `sessionImport.scan@1.2` and `sessionImport.run@1.1`.
 *
 * Taken because 1.3.0 was cut from a branch that predates Antigravity while
 * `main` had already added the id to the LIVE enum above: every stream frame
 * that embeds this enum was therefore advertising a value the released peers
 * strict-decode against a twenty-id set. Freezing here is what lets those
 * released minors keep serializing exactly what they shipped with.
 *
 * Do NOT add new harnesses here - extend `guiHarnessIdSchema` above and gate
 * emission on the negotiated minor (streams have no downgrade bridge).
 */
export const guiHarnessIdSchemaPreAntigravity = lazySchema(() =>
  z.enum([
    "claude",
    "codex",
    "opencode",
    "traycer",
    "cursor",
    "grok",
    "qwen",
    "kiro",
    "droid",
    "kimi",
    "copilot",
    "kilocode",
    "openrouter",
    "amp",
    "devin",
    "pi",
    "hermes",
    "omp",
    "huggingface",
    "reasonix",
  ]),
);
export type GuiHarnessIdPreAntigravity = z.infer<
  typeof guiHarnessIdSchemaPreAntigravity
>;

// Cursor remains a reserved compatibility value: it shipped in this persisted
// enum before the unfinished runtime surface was withdrawn from the product.
export const tuiHarnessIdSchema = lazySchema(() =>
  z.enum(["claude", "codex", "opencode", "cursor"]),
);
export type TuiHarnessId = z.infer<typeof tuiHarnessIdSchema>;

// ---- Permission + run settings --------------------------------------- //

// Ordered most-restrictive to most-permissive; `ALL_PERMISSION_MODES` below
// documents that order as load-bearing. `auto` sits above `auto_accept_edits`
// because it does everything that mode does AND lets a judge approve the
// commands that mode still parks on a human.
//
// The literal list is the enum's source, not read back from it: reading
// `.options` at module scope would build the schema at import.
const PERMISSION_MODE_VALUES = [
  "supervised",
  "auto_accept_edits",
  "auto",
  "full_access",
] as const;
export const permissionModeSchema = lazySchema(() =>
  z.enum(PERMISSION_MODE_VALUES),
);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/**
 * Frozen copy of the permission-mode enum as every line before `auto` shipped
 * it.
 *
 * This enum is BOUND BY REFERENCE from more released surfaces than any other
 * value in this file - the persisted chat run settings, the `chat.subscribe`
 * server frames that carry them, the `listHarnesses` catalog rows, and the
 * `epic.getChatRunSettings` response - so widening the live enum above without
 * pinning this one into each of those would put `auto` on wires whose
 * installed peers strict-decode against a three-value set. One unknown member
 * fails the WHOLE frame or response, not the one field: the documented
 * `authStatus` / Reasonix hazard, in the mode dimension.
 *
 * **It is bound in the client→host direction too, which the harness rosters
 * beside it are not.** `chat.subscribe`'s client frames (`1.0`-`1.10`) and
 * `sessionImport.run`'s open request (`1.0`/`1.1`) name the frozen enum, so a
 * pre-`auto` line cannot be USED to set the mode either. The framework's
 * default for that direction is the opposite - a client→host enum addition is
 * advisory, on the argument that an old host rejects the value per call
 * (`framework/surface-compat.ts`) - and two things take this value out of it: no
 * released client can spell `auto`, so nothing honest is being narrowed out,
 * and a CURRENT host accepting it on an old line mints a durable chat that line
 * is then refused (`chatSubscribeSupportsPermissionMode`). Other pre-`auto`
 * request contracts whose method has no post-`auto` line yet -
 * `epic.createChat`, `epic.updateChatRunSettings`, `epic.create`,
 * `agent.create`, `agent.configure`, `agent.fork` - still bind the live enum,
 * because pinning a head line would make the mode unsettable rather than
 * version-gated. Those need a new line before they can be pinned.
 *
 * Do NOT add modes here. Add them to `permissionModeSchema` above and gate
 * emission on the negotiated version, exactly as `guiHarnessIdSchemaPreReasonix`
 * does for the harness roster.
 */
const PERMISSION_MODE_VALUES_PRE_AUTO = [
  "supervised",
  "auto_accept_edits",
  "full_access",
] as const;
export const permissionModeSchemaPreAuto = lazySchema(() =>
  z.enum(PERMISSION_MODE_VALUES_PRE_AUTO),
);
export type PermissionModePreAuto = z.infer<typeof permissionModeSchemaPreAuto>;

// Canonical full set of permission modes, ordered most-restrictive to
// most-permissive. Single source of truth shared by:
//   - the host-RPC schema default for protocol skew (unary-schemas.ts)
//   - adapter declarations that honor every mode (claude, codex, opencode)
//   - the renderer's safest-fallback clamp (normalizePermissionMode)
// Adding a mode here propagates to every consumer; never duplicate this list.
export const ALL_PERMISSION_MODES: readonly PermissionMode[] =
  PERMISSION_MODE_VALUES;

// The same list as the released lines shipped it, for the `.default(...)` of
// every FROZEN `supportedPermissionModes` slot. A frozen enum whose default
// still came from the live list would carry `auto` as a parse-time fill on a
// line whose enum cannot spell it - a value zod's `.default()` never
// re-validates, so it would reach a released client's reducer intact.
export const ALL_PERMISSION_MODES_PRE_AUTO: readonly PermissionModePreAuto[] =
  PERMISSION_MODE_VALUES_PRE_AUTO;

export const chatRunSettingsSchema = lazySchema(() =>
  z.object({
    harnessId: guiHarnessIdSchema,
    // Concrete model slug; there is no "use the harness default" sentinel. The
    // renderer resolves a real model (defaulting to the provider's first listed
    // model) before a turn is sent.
    model: z.string().min(1),
    permissionMode: permissionModeSchema,
    reasoningEffort: z.string().nullable(),
    // Codex-style service / speed tier (e.g. `"fast"`). Defaults to null so
    // chats persisted before this field was introduced still parse cleanly.
    serviceTier: z.string().nullable().default(null),
    agentMode: agentModeSchema,
    // Which of the harness's logged-in profiles (subscriptions) this chat runs
    // on. `null` = the ambient/host login, so chats persisted before profiles
    // existed still parse cleanly. See the multi-profile decision log.
    profileId: z.string().nullable().default(null),
    // Which agent IDENTITY this chat runs as - the soul, memories and skills
    // injected into its system prompt, and the single skill root its run sees.
    // `null` is the ordinary state and means the host-managed STOCK identity,
    // not an absence: a run always has exactly one active skill root, so "no
    // identity" is a default rather than a missing value. Defaulted so chats
    // persisted before identities existed still parse cleanly - the `profileId`
    // precedent above, field for field.
    //
    // No narrow patch method accompanies it. The identity changes with the same
    // frequency as the model, so it rides the existing whole-tuple settings
    // write; see the strict variant's comment below for why a partial tuple is
    // a validation error on a write path.
    //
    // FROZEN COPIES ARE DELIBERATELY NOT FOLLOWING THIS. Every
    // `chatRunSettingsSchema*` copy below is hand-frozen field-for-field for
    // exactly this case, and so are `chatRunSettingsSchemaV10` / `V20` in
    // `host/epic/chat-records.ts`. What DOES pick the field up by reference is
    // `snapshotChatRunSettingsSchema` (`persistence/chat-sync/open-harness.ts`),
    // which derives from this live shape on purpose - so a published chat
    // carries its identity. That is a chat-sync record change and rides the
    // still-unreleased 1.6 minor; see the note in `chat-sync/version.ts`.
    identityId: agentIdentityIdSchema.nullable().default(null),
  }),
);
export type ChatRunSettings = z.infer<typeof chatRunSettingsSchema>;

/**
 * Wire-freeze copy of the settings tuple with `harnessId` pinned to the
 * pre-Reasonix enum. Bound by every released `chat.subscribe@1.0–1.6`
 * server-frame path that carries settings - the queue items embedded in
 * snapshot / `queueChanged` frames, and `chat.settings` on the frozen chat
 * records - so a newer host cannot project `harnessId: "reasonix"` onto a minor
 * whose installed client would reject the whole frame.
 *
 * Hand-frozen field-for-field rather than `chatRunSettingsSchema.extend(...)`:
 * a later required field added to the live tuple must not silently leak into
 * this frozen contract.
 *
 * Client→host coverage on the HARNESS axis is deliberately NARROWER than
 * server→client, and the asymmetry is the point: the host is the side that must
 * stay permissive, since a `1.7` peer has to be able to send `reasonix` in a
 * settings write. Only `chatSubscribeClientFrameSchemaV10` pins this tuple -
 * that line is frozen verbatim against a shipped host and gets the enum pin
 * with everything else. `1.1`-`1.6` client frames bind the roster live, which
 * costs nothing today: a released client's own enum cannot spell `reasonix`, so
 * only a crafted peer could send it, and the server-frame freezes above are
 * what stop such a chat from ever being served back to a line that cannot
 * decode it.
 *
 * The MODE axis does not inherit that asymmetry, and `chat.subscribe`'s client
 * frames from `1.1` up bind `chatRunSettingsSchemaPreAuto` instead. The
 * difference is what the two values mean once accepted: an unknown harness id
 * is a label the host can refuse per call, while an accepted `auto` mints a
 * durable chat the accepting LINE is then refused
 * (`chatSubscribeSupportsPermissionMode`). There is also no honest sender to
 * keep permissive - no released client can spell the value at all.
 *
 * The tuple is frozen on TWO axes now. `harnessId` is pinned to the
 * pre-Reasonix roster for the reason above; `permissionMode` is pinned to
 * `permissionModeSchemaPreAuto` for the identical reason one dimension over -
 * every released `chat.subscribe` line below `1.7` reaches the permission mode
 * only through this tuple, so pinning it here is what stops an `auto` chat's
 * settings from being served onto a line whose client rejects the value.
 *
 * It is also short a FIELD the live tuple now carries - `identityId` - and that
 * is the plain hand-frozen rule doing its job rather than a third axis. A
 * released line must not gain a key at all, whatever its schema would tolerate
 * (`protocol/README.md`'s additivity note, and the providers.list #258 rule):
 * schema tolerance says nothing about a consumer that skips the parse. A client
 * on one of these minors simply never learns a chat has an identity, which is
 * exactly what it showed before identities existed.
 */
export const chatRunSettingsSchemaPreReasonix = lazySchema(() =>
  z.object({
    harnessId: guiHarnessIdSchemaPreReasonix,
    model: z.string().min(1),
    permissionMode: permissionModeSchemaPreAuto,
    reasoningEffort: z.string().nullable(),
    serviceTier: z.string().nullable().default(null),
    agentMode: agentModeSchema,
    profileId: z.string().nullable().default(null),
  }),
);
export type ChatRunSettingsPreReasonix = z.infer<
  typeof chatRunSettingsSchemaPreReasonix
>;

// The wire-strict variant of `chatRunSettingsSchema`: identical output type,
// but every field is REQUIRED - no `.default(...)` backstops. The defaults
// above exist for PERSISTED records written before a field was introduced;
// on a write path they are a misuse foothold: a caller sending a partial
// tuple would have the omitted fields silently defaulted, turning a
// subset-field "patch" into a null-clobber of settings it never looked at.
// A settings write is a whole-tuple WYSIWYG replace - the caller must state
// every field of the tuple it resolved, so a partial object is a validation
// error instead. Field-level updates get their own narrow methods (e.g.
// `epic.updateChatProfile`); there is deliberately no narrow model/harness
// update - changing the model invalidates the reasoning/thinking/tier
// selection, so it is only expressible as a full tuple.
//
// `identityId` is REQUIRED here like every other field, which is the point:
// a writer on a line that binds this tuple must say which identity the chat
// runs as, and `null` is a statement ("the stock identity"), not an omission.
// The released line that predates the field binds the frozen copy below
// instead - see `chatRunSettingsStrictSchemaPreIdentity`.
/**
 * Wire-freeze copy of the LIVE settings tuple with `permissionMode` pinned
 * pre-`auto`, and ONLY `permissionMode`.
 *
 * Bound by every `chat.subscribe` line from `1.7` through `1.12` - directly as
 * `chatSchemaV18.settings`, and through `chatQueueStateSchemaPreAuto` on the
 * queued prompts each of those lines carries. `1.13` is the first that binds
 * the live tuple. Hand-frozen field-for-field rather than `.extend()`ed, so a
 * later required field on the live tuple cannot leak onto those lines.
 *
 * It reaches FURTHER than the server frames that named it. The same tuple is
 * bound by the `chat.subscribe` CLIENT frames of `1.1` through `1.12` - `send`,
 * `editUserMessage`, `queueSteerNow`, `queueSettingsUpdate` and
 * `queueSettingsRestamp` - so a settings write on one of those lines cannot say
 * `auto` either. That direction is deliberately narrowed where the harness axis
 * beside it is not; see `chatRunSettingsSchemaPreReasonix` above for why the
 * two axes part company here. (`1.0` reaches the same place through
 * `chatRunSettingsSchemaPreReasonix`, which pins both.)
 *
 * **The harness roster is deliberately live here, and that is a one-axis
 * freeze rather than a complete one.** Four lines share this tuple and they do
 * not agree about the roster: `1.9` and `1.10` are the Antigravity lines and
 * MUST be able to spell `antigravity`, while `1.7` and `1.8` shipped in
 * `cli-v1.3.0` / `host-v1.3.0` and strict-decode the twenty ids
 * `guiHarnessIdSchemaPreAntigravity` records. Pinning the roster on this object
 * would therefore break the two lines it exists to serve; giving `1.7`/`1.8`
 * the pin needs a THIRD tier (pre-Antigravity AND pre-auto) plus a split of
 * `chatSubscribeCommonServerFrameSchemasV18`, which is bound to `1.7`-`1.9`
 * as one bundle.
 *
 * What holds the harness axis for `1.7`/`1.8` meanwhile is the host's floor
 * gate - `minimumChatSubscribeMinorForHarness` puts `antigravity` at `9`, so
 * such a chat is REFUSED to a subscriber below `1.9` rather than projected,
 * exactly as an `auto` chat is refused below `1.13`. That gate predates this
 * schema and is not weakened by it. Distinct from
 * `chatRunSettingsSchemaPreReasonix`, which pins BOTH axes for the lines below
 * `1.7`, where no such sharing forces the compromise.
 *
 * Like the pre-Reasonix copy, it is short the live tuple's `identityId`. Same
 * rule, same reason: `1.7`-`1.12` are released, and a released line does not
 * gain a key. `1.13` binds the live tuple and is the first that may carry one.
 */
export const chatRunSettingsSchemaPreAuto = lazySchema(() =>
  z.object({
    harnessId: guiHarnessIdSchema,
    model: z.string().min(1),
    permissionMode: permissionModeSchemaPreAuto,
    reasoningEffort: z.string().nullable(),
    serviceTier: z.string().nullable().default(null),
    agentMode: agentModeSchema,
    profileId: z.string().nullable().default(null),
  }),
);
export type ChatRunSettingsPreAuto = z.infer<
  typeof chatRunSettingsSchemaPreAuto
>;

export const chatRunSettingsStrictSchema = lazySchema(() =>
  z.object({
    harnessId: guiHarnessIdSchema,
    model: z.string().min(1),
    permissionMode: permissionModeSchema,
    reasoningEffort: z.string().nullable(),
    serviceTier: z.string().nullable(),
    agentMode: agentModeSchema,
    profileId: z.string().nullable(),
    identityId: agentIdentityIdSchema.nullable(),
  }),
);
export type ChatRunSettingsStrict = z.infer<typeof chatRunSettingsStrictSchema>;

/**
 * Wire-freeze copy of the strict tuple as it stood before `identityId`.
 *
 * Bound by `epic.updateChatRunSettings@1.1`, which SHIPPED in `host-v1.3.x`
 * and must stay byte-identical: every field here is required, so adding one
 * would refuse the write every shipped `@1.1` client sends, and defaulting it
 * instead would clear a chat's identity on each of those writes. Identity
 * writes ride `@1.2`, which binds the live strict tuple above.
 *
 * Hand-frozen field-for-field rather than `.omit()`-derived, on the discipline
 * every frozen copy of this tuple follows: a later field on the live tuple
 * must not leak onto the released line. The enums stay LIVE, as they do on
 * `updateChatRunSettingsTupleSchemaV10`: this is a client->host request, and
 * pinning a roster would make a harness unsettable rather than version-gated.
 */
export const chatRunSettingsStrictSchemaPreIdentity = lazySchema(() =>
  z.object({
    harnessId: guiHarnessIdSchema,
    model: z.string().min(1),
    permissionMode: permissionModeSchema,
    reasoningEffort: z.string().nullable(),
    serviceTier: z.string().nullable(),
    agentMode: agentModeSchema,
    profileId: z.string().nullable(),
  }),
);
export type ChatRunSettingsStrictPreIdentity = z.infer<
  typeof chatRunSettingsStrictSchemaPreIdentity
>;
