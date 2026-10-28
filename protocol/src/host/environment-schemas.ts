import { z } from "zod";
import {
  environmentChangedBySchema,
  type EnvironmentChangedBy,
} from "@traycer/protocol/framework/environment-stale-write";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { executableWriteGrantSchema } from "@traycer/protocol/host/executable-write-grant";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import {
  SANDBOX_ROUTE_PROTOCOLS,
  SANDBOX_SECRET_FORM_KINDS,
  SANDBOX_SECRET_SWAP_SITES,
} from "@traycer/protocol/host/secret-intake-catalogue";

/**
 * Wire shapes of the environment methods: the desktop Settings pages a person's
 * Personal environment drives, and the secrets, agent definitions, machine
 * setup, status, notices and review the host proxies to the environment routes.
 * Every method is new at `@1.0`, off the released floor with
 * `degrade: unsupported` (`environment-contracts.ts`).
 *
 * Timestamps are epoch milliseconds, as elsewhere on this wire. A code or a
 * state that may grow is an open string with its known values exported beside
 * it, so a value newer than the client never fails the parse (the
 * `SandboxSummary.routes` rule); a closed set is an enum.
 */

// ── Shared ──────────────────────────────────────────────────────────────────

/** The OS axis of an item (`EnvironmentItem.os`). */
export const environmentOsSchema = lazySchema(() =>
  z.enum(["any", "linux", "macos", "windows"]),
);
export type EnvironmentOs = z.infer<typeof environmentOsSchema>;

/** An item's kind. Open: kinds may grow. */
export const ENVIRONMENT_ITEM_KINDS = [
  "managed_profile",
  "env_override",
  "variable",
  "shell",
  "mcp_server",
  "skill",
  "agent_definition",
  "setup_script",
  "pack_policy",
  "fallback_policy",
  "browser_agent_access",
  "agent_selection_guide",
  "auto_policy",
  "member",
  "secret",
  "sandbox_defaults",
  "traycer_inference",
] as const;
export const environmentItemKindSchema = lazySchema(() =>
  z.string().min(1).max(64),
);

/**
 * The applier's code for one item (`HostEnvironmentReport`, the starting list
 * in `packages/common/src/environments/codes.ts`). Open on this wire so a code
 * newer than the client never fails the parse.
 */
export const ENVIRONMENT_ITEM_STATUS_CODES = [
  "ok",
  "native_write_failed",
  "permission_denied",
  "not_installed",
  "unsupported_kind",
  "superseded",
  "binding_purged",
  "fetch_failed",
  "script_failed",
  "timed_out",
  "invalid_value",
] as const;
export const environmentItemStatusCodeSchema = lazySchema(() =>
  z.string().min(1).max(64),
);

/** The per-item apply status. Known: applied, failed, unsupported, pending. */
export const ENVIRONMENT_ITEM_APPLY_STATUSES = [
  "applied",
  "failed",
  "unsupported",
  "pending",
] as const;

/**
 * Who changed an item the editor last read, for the stale-save copy:
 * "changed in the dashboard just now" or "changed on <host> just now".
 */
export { environmentChangedBySchema };
export type { EnvironmentChangedBy };

/**
 * The answer to an item write. A page edit is `live` and compare-and-set on the
 * revision the editor read: `saved` with the new revision, or `stale` with the
 * current revision and who changed it. `pending` is an edit the host queued
 * while the environment is unreachable (shown pending until its receipt).
 * `needs_grant` is a write that reaches an execution sink made without an
 * executable-write grant, which the host holds as "needs you".
 */
export const environmentWriteOutcomeSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("saved"), revision: z.number().int() }),
    z.object({ outcome: z.literal("pending"), uploadId: z.string().min(1) }),
    z.object({
      outcome: z.literal("stale"),
      currentRevision: z.number().int().nullable(),
      changedBy: environmentChangedBySchema,
    }),
    z.object({ outcome: z.literal("needs_grant") }),
  ]),
);
export type EnvironmentWriteOutcome = z.infer<
  typeof environmentWriteOutcomeSchema
>;

const emptyRequestSchema = lazySchema(() => z.object({}));

// ── environment.status ──────────────────────────────────────────────────────

/** Remote access on this host (closed). */
export const remoteAccessStateSchema = lazySchema(() =>
  z.enum(["on", "off", "turning_off"]),
);
export type RemoteAccessState = z.infer<typeof remoteAccessStateSchema>;

/** Setup stages a host shows. Open: stages may grow. */
export const ENVIRONMENT_SETUP_STAGES = [
  "registering",
  "moving_settings",
  "applying",
  "done",
] as const;

export const environmentItemStatusSchema = lazySchema(() =>
  z.object({
    kind: environmentItemKindSchema,
    key: z.string().min(1),
    os: environmentOsSchema,
    desiredRevision: z.number().int(),
    status: z.string().min(1).max(32),
    code: environmentItemStatusCodeSchema,
    /** Typed allowlisted arguments only, never free text. */
    args: z.object({
      exitStatus: z.number().int().nullable(),
      stage: z.string().max(64).nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
      /**
       * Which case of the code, when one code covers several the client
       * words differently. Known: on `unsupported_kind`,
       * `headers_in_sandbox` (an MCP server whose credential is custom
       * headers, on a sandbox). Open, so a newer case never fails the parse;
       * absent from a host that predates it.
       */
      kind: z.string().min(1).max(64).nullable().default(null),
    }),
    /**
     * The broker-enforced half for a `secret` item: whether every incarnation
     * serving this host has acknowledged the item's version, and the evidence
     * kind it rests on (the rotation wire's `session_closed`,
     * `cache_cleared`, `probe_refused`). `null` for every other kind.
     */
    brokerEnforced: z
      .object({
        enforced: z.boolean(),
        evidenceKind: z.string().min(1).max(32).nullable(),
      })
      .nullable(),
    /** An `unsupported` item's compatibility floor: the host version needed. */
    minimumHostVersion: z.string().max(64).nullable(),
    /**
     * The native entry this host wrote an `mcp_server` or `skill` item as, by
     * name in the provider's global config. The desktop marks a native row
     * Personal by it, since a skill's item key is not something a client can
     * compose. `null` for every other kind and until the item is applied.
     */
    appliedAs: z
      .object({
        entryKind: z.enum(["mcp", "skills"]),
        name: z.string().min(1),
      })
      .nullable(),
  }),
);
export type EnvironmentItemStatus = z.infer<typeof environmentItemStatusSchema>;

export const environmentPendingUploadSchema = lazySchema(() =>
  z.object({
    uploadId: z.string().min(1),
    kind: environmentItemKindSchema,
    key: z.string().min(1),
    os: environmentOsSchema,
    queuedAt: z.number(),
    /** Known: pending, accepted, refused. */
    receipt: z.string().min(1).max(32),
    code: environmentItemStatusCodeSchema.nullable(),
  }),
);
export type EnvironmentPendingUpload = z.infer<
  typeof environmentPendingUploadSchema
>;

export const environmentStatusRequestSchema = emptyRequestSchema;
export type EnvironmentStatusRequest = z.infer<
  typeof environmentStatusRequestSchema
>;

/**
 * `environment.status@1.0`: the host's own view of its environment. `principal`
 * is `null` on a host that has no environment yet (it renders its old per-host
 * pages read-only).
 */
export const environmentStatusResponseSchema = lazySchema(() =>
  z.object({
    principal: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("personal") }),
        z.object({ kind: z.literal("team"), teamName: z.string() }),
      ])
      .nullable(),
    /** Known: connected, reconnecting, offline. */
    reachability: z.string().min(1).max(32),
    bindingGeneration: z.number().int().nullable(),
    desiredRevision: z.number().int().nullable(),
    receivedRevision: z.number().int().nullable(),
    appliedRevision: z.number().int().nullable(),
    /** Age of the host's last accepted report, in milliseconds. */
    receiptAgeMs: z.number().int().nonnegative().nullable(),
    items: z.array(environmentItemStatusSchema),
    pendingUploads: z.array(environmentPendingUploadSchema),
    setup: z
      .object({
        stage: z.string().min(1).max(32),
        /**
         * Known: running, stalled, failed, done, and `awaiting_consent` (the
         * move waits for the person's `Move to Personal`; served at `@1.1`).
         */
        state: z.string().min(1).max(32),
      })
      .nullable(),
    remoteAccess: remoteAccessStateSchema,
  }),
);
export type EnvironmentStatusResponse = z.infer<
  typeof environmentStatusResponseSchema
>;

/**
 * Where one plane of this computer's settings stands: still `local`,
 * `moved` by the person's accepted move, `shared_unrecorded` by an earlier
 * build with no acceptance on record, or `stopped` sharing.
 */
export const environmentPlaneStateSchema = lazySchema(() =>
  z.enum(["local", "moved", "shared_unrecorded", "stopped"]),
);
export type EnvironmentPlaneState = z.infer<typeof environmentPlaneStateSchema>;

/**
 * `environment.status@1.1`: `@1.0` plus the move. `consent` is the accepted
 * move sheet, null before one. `planes` is where the records, the broker's
 * secrets and the room's files each stand; a `@1.0` answer upgrades as fully
 * moved, which is what a host that predates the move had done. `returnedFromTeam`
 * is when this computer went back to its own settings after a team, null when
 * it never did. `stoppedAt` is when this computer stopped sharing, null while
 * it shares or never did.
 */
export const environmentStatusResponseSchemaV11 = lazySchema(() =>
  environmentStatusResponseSchema.extend({
    /** Current sandbox apply operation; absent on older hosts, null while unknown or applying. */
    sandboxSettingsOperationId: z.string().min(1).nullable().optional(),
    consent: z
      .object({ acceptedAt: z.number(), planHash: z.string().min(1) })
      .nullable()
      .default(null),
    planes: z
      .object({
        records: environmentPlaneStateSchema,
        broker: environmentPlaneStateSchema,
        room: environmentPlaneStateSchema,
      })
      .default({ records: "moved", broker: "moved", room: "moved" }),
    returnedFromTeam: z.object({ at: z.number() }).nullable().default(null),
    stoppedAt: z.number().nullable().default(null),
  }),
);
export type EnvironmentStatusResponseV11 = z.infer<
  typeof environmentStatusResponseSchemaV11
>;

// ── environment.notices / .undo / .review ───────────────────────────────────

export const environmentNoticesRequestSchema = emptyRequestSchema;
export type EnvironmentNoticesRequest = z.infer<
  typeof environmentNoticesRequestSchema
>;

/**
 * One convergence notice: a change in the last 30 days with a displaced value
 * and no later change on its key; Undo is offered exactly while that holds. A
 * secret's notice names the secret only, never a value.
 */
export const environmentNoticeSchema = lazySchema(() =>
  z.object({
    noticeId: z.string().min(1),
    kind: environmentItemKindSchema,
    key: z.string().min(1),
    os: environmentOsSchema,
    /** Known: offline, migration (the later-arrival sources that displace). */
    source: z.string().min(1).max(32),
    from: environmentChangedBySchema,
    writtenAt: z.number(),
    undoAvailable: z.boolean(),
  }),
);
export type EnvironmentNotice = z.infer<typeof environmentNoticeSchema>;

export const environmentNoticesResponseSchema = lazySchema(() =>
  z.object({ notices: z.array(environmentNoticeSchema) }),
);
export type EnvironmentNoticesResponse = z.infer<
  typeof environmentNoticesResponseSchema
>;

/**
 * `environment.undo@1.0`: writes a notice's displaced value back as a new
 * revision (source `undo`). The displaced value can be executable content (an
 * MCP server, a setup script), so the call carries the grant.
 */
export const environmentUndoRequestSchema = lazySchema(() =>
  z.object({
    noticeId: z.string().min(1),
    executableWriteGrant: executableWriteGrantSchema,
  }),
);
export type EnvironmentUndoRequest = z.infer<
  typeof environmentUndoRequestSchema
>;

export const environmentUndoResponseSchema = environmentWriteOutcomeSchema;
export type EnvironmentUndoResponse = z.infer<
  typeof environmentUndoResponseSchema
>;

export const environmentReviewRequestSchema = emptyRequestSchema;
export type EnvironmentReviewRequest = z.infer<
  typeof environmentReviewRequestSchema
>;

/**
 * One "needs you" row: a held credential-like value ("Make it a secret" or
 * "Keep as a variable"), a held executable entry, or a sink-reaching write made
 * without a grant. Apply goes through the dashboard's Review page; this method
 * only lists.
 */
export const ENVIRONMENT_REVIEW_REASONS = [
  "credential_like_value",
  "executable_entry",
  "needs_grant",
] as const;
export const environmentReviewEntrySchema = lazySchema(() =>
  z.object({
    entryId: z.string().min(1),
    reason: z.string().min(1).max(64),
    kind: environmentItemKindSchema,
    key: z.string().min(1),
    os: environmentOsSchema,
    hostId: z.string().min(1).nullable(),
    heldAt: z.number(),
  }),
);
export type EnvironmentReviewEntry = z.infer<
  typeof environmentReviewEntrySchema
>;

export const environmentReviewResponseSchema = lazySchema(() =>
  z.object({ entries: z.array(environmentReviewEntrySchema) }),
);
export type EnvironmentReviewResponse = z.infer<
  typeof environmentReviewResponseSchema
>;

/**
 * `environment.review@1.1`: `@1.0` plus the retrospective sheet's record.
 * `shownAt` and `acknowledgedAt` are two timestamps (shown is not read);
 * `evidence` is the earlier build that shared this computer's settings and
 * when, each null where unknown. Defaulted, so a `@1.0` answer upgrades as a
 * sheet never shown with no evidence.
 */
export const environmentReviewResponseSchemaV11 = lazySchema(() =>
  environmentReviewResponseSchema.extend({
    shownAt: z.number().nullable().default(null),
    acknowledgedAt: z.number().nullable().default(null),
    evidence: z
      .object({
        version: z.string().min(1).max(64).nullable(),
        at: z.number().nullable(),
      })
      .default({ version: null, at: null }),
  }),
);
export type EnvironmentReviewResponseV11 = z.infer<
  typeof environmentReviewResponseSchemaV11
>;

/**
 * `environment.review@1.2`: each entry names what a held executable does, the
 * facts its line on the retrospective sheet reads. All null on a held value
 * and on any row the host cannot describe; a `@1.1` answer upgrades with all
 * null.
 *
 * - `command`: what it runs, as configured: an MCP server's or hook's command
 *   line, arguments included and env values left out; a shell's path and
 *   arguments; a setup script's lines.
 * - `event`: when it runs: a hook's trigger, or a setup script's.
 * - `description`: a skill's one-line description, as the skill states it.
 * - `harness`: the harness id an agent definition is for, or the program an
 *   env setting changes (its key's `<harness>:` prefix).
 * - `value`: a launch-sensitive variable's or env setting's value as
 *   configured. A value that looks like a credential is never here: that row
 *   is a held value.
 */
export const environmentReviewEntrySchemaV12 = lazySchema(() =>
  environmentReviewEntrySchema.extend({
    command: z.string().min(1).max(8192).nullable().default(null),
    event: z.string().min(1).max(256).nullable().default(null),
    description: z.string().min(1).max(1024).nullable().default(null),
    harness: z.string().min(1).max(64).nullable().default(null),
    value: z.string().min(1).max(8192).nullable().default(null),
  }),
);
export type EnvironmentReviewEntryV12 = z.infer<
  typeof environmentReviewEntrySchemaV12
>;

export const environmentReviewResponseSchemaV12 = lazySchema(() =>
  environmentReviewResponseSchemaV11.extend({
    entries: z.array(environmentReviewEntrySchemaV12),
  }),
);
export type EnvironmentReviewResponseV12 = z.infer<
  typeof environmentReviewResponseSchemaV12
>;

/**
 * `environment.review.heldApply@1.0`: the retrospective sheet's choice for one
 * held entry (`EnvironmentReviewEntry.entryId`). `secret`, `variable` and
 * `stays` answer a held credential-like value; `approve` a held hook;
 * `discard` either. `gone` is an entry already applied or discarded.
 *
 * `secret` promotes the held value, already sealed in the broker, to a secret
 * with the binding the add dialog collects: its kind, protocol, hosts and
 * port, the swap sites, and the plaintext-at-the-gateway consent's disclosure
 * version where the protocol needs it. The value never travels again.
 */
export const environmentReviewHeldApplyRequestSchema = lazySchema(() =>
  z.discriminatedUnion("choice", [
    z.object({
      heldId: z.string().min(1),
      choice: z.literal("secret"),
      kind: z.enum(SANDBOX_SECRET_FORM_KINDS),
      protocol: z.enum(SANDBOX_ROUTE_PROTOCOLS),
      hosts: z.array(z.string().min(1).max(253)).min(1).max(16),
      port: z.number().int().min(1).max(65_535).nullable(),
      portOverride: z.boolean(),
      swapSites: z.array(z.enum(SANDBOX_SECRET_SWAP_SITES)).min(1).max(3),
      plaintextConsent: z
        .object({ disclosureVersion: z.number().int().nonnegative() })
        .nullable(),
    }),
    z.object({
      heldId: z.string().min(1),
      choice: z.enum(["variable", "stays", "discard", "approve"]),
    }),
  ]),
);
export type EnvironmentReviewHeldApplyRequest = z.infer<
  typeof environmentReviewHeldApplyRequestSchema
>;

export const environmentReviewHeldApplyResponseSchema = lazySchema(() =>
  z.object({ outcome: z.enum(["applied", "gone", "forbidden"]) }),
);
export type EnvironmentReviewHeldApplyResponse = z.infer<
  typeof environmentReviewHeldApplyResponseSchema
>;

/**
 * `environment.review.record@1.0`: this computer's retrospective sheet was
 * `shown`, or the person `acknowledged` it (Got it); the two are recorded
 * separately and read back as `review@1.1`'s `shownAt` and `acknowledgedAt`.
 * `not_shared` is a computer an earlier build never shared, which has no
 * sheet.
 */
export const environmentReviewRecordRequestSchema = lazySchema(() =>
  z.object({ event: z.enum(["shown", "acknowledged"]) }),
);
export type EnvironmentReviewRecordRequest = z.infer<
  typeof environmentReviewRecordRequestSchema
>;

export const environmentReviewRecordResponseSchema = lazySchema(() =>
  z.object({ outcome: z.enum(["recorded", "not_shared"]) }),
);
export type EnvironmentReviewRecordResponse = z.infer<
  typeof environmentReviewRecordResponseSchema
>;

// ── Local overrides ─────────────────────────────────────────────────────────

/**
 * What a local override replaces on this host: a variable, or one harness's
 * env override ("Keep dev-box's value on dev-box").
 */
export const localOverrideTargetSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("variable"), key: z.string().min(1) }),
    z.object({
      kind: z.literal("env_override"),
      providerId: providerIdSchema,
      key: z.string().min(1),
    }),
  ]),
);
export type LocalOverrideTarget = z.infer<typeof localOverrideTargetSchema>;

export const localOverrideSchema = lazySchema(() =>
  z.object({
    target: localOverrideTargetSchema,
    os: environmentOsSchema,
    value: z.string(),
    setAt: z.number(),
  }),
);
export type LocalOverride = z.infer<typeof localOverrideSchema>;

export const environmentLocalOverridesRequestSchema = emptyRequestSchema;
export type EnvironmentLocalOverridesRequest = z.infer<
  typeof environmentLocalOverridesRequestSchema
>;

/** `environment.localOverrides@1.0`: this host's machine facts. */
export const environmentLocalOverridesResponseSchema = lazySchema(() =>
  z.object({ overrides: z.array(localOverrideSchema) }),
);
export type EnvironmentLocalOverridesResponse = z.infer<
  typeof environmentLocalOverridesResponseSchema
>;

/**
 * `config.env.localOverride.set@1.0`: a value that applies on this host only.
 * It can select what starts (a launch-sensitive name), so it carries the
 * grant.
 */
export const configEnvLocalOverrideSetRequestSchema = lazySchema(() =>
  z.object({
    target: localOverrideTargetSchema,
    value: z.string(),
    executableWriteGrant: executableWriteGrantSchema,
  }),
);
export type ConfigEnvLocalOverrideSetRequest = z.infer<
  typeof configEnvLocalOverrideSetRequestSchema
>;

/** `config.env.localOverride.clear@1.0`: back to the environment's value. */
export const configEnvLocalOverrideClearRequestSchema = lazySchema(() =>
  z.object({ target: localOverrideTargetSchema }),
);
export type ConfigEnvLocalOverrideClearRequest = z.infer<
  typeof configEnvLocalOverrideClearRequestSchema
>;

/** Both answer the host's overrides after the write, or `needs_grant`. */
export const configEnvLocalOverrideResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("saved"),
      overrides: z.array(localOverrideSchema),
    }),
    z.object({ outcome: z.literal("needs_grant") }),
  ]),
);
export type ConfigEnvLocalOverrideResponse = z.infer<
  typeof configEnvLocalOverrideResponseSchema
>;

// ── host.remoteAccess.set ───────────────────────────────────────────────────

/**
 * `host.remoteAccess.set@1.0`: the deliberate enable, and the visible Off.
 * Off answers `turning_off` until the host confirms its sessions are closed;
 * the page then reads `environment.status`.
 */
export const hostRemoteAccessSetRequestSchema = lazySchema(() =>
  z.object({ enabled: z.boolean() }),
);
export type HostRemoteAccessSetRequest = z.infer<
  typeof hostRemoteAccessSetRequestSchema
>;

export const hostRemoteAccessSetResponseSchema = lazySchema(() =>
  z.object({ state: remoteAccessStateSchema }),
);
export type HostRemoteAccessSetResponse = z.infer<
  typeof hostRemoteAccessSetResponseSchema
>;

// ── providers.link / linkComplete ───────────────────────────────────────────

/**
 * `providers.link@1.0`: starts the server-side link of a plan, which returns
 * the sign-in URL and a code prompt, for a profile that is on this host only or
 * for a new one.
 */
export const providersLinkRequestSchema = lazySchema(() =>
  z.object({
    providerId: providerIdSchema,
    profileId: z.string().min(1).nullable(),
  }),
);
export type ProvidersLinkRequest = z.infer<typeof providersLinkRequestSchema>;

export const providersLinkResponseSchema = lazySchema(() =>
  z.object({
    linkId: z.string().min(1),
    prompt: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("sign_in_url"),
        url: z.string().min(1),
        /** The code prompt's label, or `null` when no code is pasted back. */
        codePrompt: z.string().nullable(),
      }),
      z.object({
        kind: z.literal("device_code"),
        verificationUrl: z.string().min(1),
        userCode: z.string().min(1),
        expiresAt: z.number(),
      }),
      /**
       * No prompt: the harness's server-side sign-in is unavailable, so the
       * host hands this profile's local sign-in to the account (the
       * link-and-rewrite fallback). The dialog shows "linking"
       * and polls `providers.linkComplete` until it answers `linked`.
       */
      z.object({ kind: z.literal("local_handoff") }),
    ]),
  }),
);
export type ProvidersLinkResponse = z.infer<typeof providersLinkResponseSchema>;

export const providersLinkCompleteRequestSchema = lazySchema(() =>
  z.object({
    linkId: z.string().min(1),
    /** The pasted code for a `sign_in_url` prompt; `null` to poll. */
    code: z.string().min(1).nullable(),
  }),
);
export type ProvidersLinkCompleteRequest = z.infer<
  typeof providersLinkCompleteRequestSchema
>;

/**
 * Known states: pending, linked, failed, expired, mismatch (the sign-in
 * resolved to another account than the profile's; nothing was stored) and
 * unavailable (Traycer is not reachable, so the link waits).
 *
 * `account` is the account the profile is linked as on `linked`, and the
 * account the person signed in as on `mismatch`; `expectedAccount` is the
 * profile's own account, non-null only on `mismatch`. Both are account
 * identifiers: shown in the person's own window, never logged.
 */
export const providersLinkCompleteResponseSchema = lazySchema(() =>
  z.object({
    state: z.string().min(1).max(32),
    code: z.string().max(64).nullable(),
    account: z.string().max(320).nullable(),
    expectedAccount: z.string().max(320).nullable(),
  }),
);
export type ProvidersLinkCompleteResponse = z.infer<
  typeof providersLinkCompleteResponseSchema
>;

/**
 * The `@1.1` requests of `providers.link` and `providers.linkComplete`:
 * `@1.0`'s plus the environment whose plan is linked, so a team's plan links
 * through the same host. Null is the serving host's own environment, which is
 * what every `@1.0` request meant. The responses are `@1.0`'s.
 */
const providersLinkEnvironmentIdField = {
  environmentId: lazySchema(() => z.string().min(1).nullable().default(null)),
};

export const providersLinkRequestSchemaV11 = lazySchema(() =>
  providersLinkRequestSchema.extend(providersLinkEnvironmentIdField),
);
export type ProvidersLinkRequestV11 = z.infer<
  typeof providersLinkRequestSchemaV11
>;

export const providersLinkCompleteRequestSchemaV11 = lazySchema(() =>
  providersLinkCompleteRequestSchema.extend(providersLinkEnvironmentIdField),
);
export type ProvidersLinkCompleteRequestV11 = z.infer<
  typeof providersLinkCompleteRequestSchemaV11
>;

// ── environment.agentDefinitions.* ──────────────────────────────────────────

/** An `agent_definition` item: file name and text. */
export const agentDefinitionSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1),
    text: z.string(),
    revision: z.number().int(),
  }),
);
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const environmentAgentDefinitionsListRequestSchema = emptyRequestSchema;
export type EnvironmentAgentDefinitionsListRequest = z.infer<
  typeof environmentAgentDefinitionsListRequestSchema
>;

export const environmentAgentDefinitionsListResponseSchema = lazySchema(() =>
  z.object({ definitions: z.array(agentDefinitionSchema) }),
);
export type EnvironmentAgentDefinitionsListResponse = z.infer<
  typeof environmentAgentDefinitionsListResponseSchema
>;

/**
 * `environment.agentDefinitions.put@1.0`: a live edit, compare-and-set on
 * `expectedRevision` (`null` for a new name). An agent definition is content
 * an agent runs, so the call carries the grant.
 */
export const environmentAgentDefinitionsPutRequestSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1),
    text: z.string(),
    expectedRevision: z.number().int().nullable(),
    executableWriteGrant: executableWriteGrantSchema,
  }),
);
export type EnvironmentAgentDefinitionsPutRequest = z.infer<
  typeof environmentAgentDefinitionsPutRequestSchema
>;

export const environmentAgentDefinitionsDeleteRequestSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1),
    expectedRevision: z.number().int(),
  }),
);
export type EnvironmentAgentDefinitionsDeleteRequest = z.infer<
  typeof environmentAgentDefinitionsDeleteRequestSchema
>;

// ── environment.setup.* ─────────────────────────────────────────────────────

/** A `setup_script` item, one per OS. */
export const setupScriptSchema = lazySchema(() =>
  z.object({
    os: environmentOsSchema,
    text: z.string(),
    revision: z.number().int(),
  }),
);
export type SetupScript = z.infer<typeof setupScriptSchema>;

export const environmentSetupGetRequestSchema = emptyRequestSchema;
export type EnvironmentSetupGetRequest = z.infer<
  typeof environmentSetupGetRequestSchema
>;

export const environmentSetupGetResponseSchema = lazySchema(() =>
  z.object({ scripts: z.array(setupScriptSchema) }),
);
export type EnvironmentSetupGetResponse = z.infer<
  typeof environmentSetupGetResponseSchema
>;

/** `environment.setup.put@1.0`: one OS's script; it runs, so it carries the grant. */
export const environmentSetupPutRequestSchema = lazySchema(() =>
  z.object({
    os: environmentOsSchema,
    text: z.string(),
    expectedRevision: z.number().int().nullable(),
    executableWriteGrant: executableWriteGrantSchema,
  }),
);
export type EnvironmentSetupPutRequest = z.infer<
  typeof environmentSetupPutRequestSchema
>;

/**
 * The typed setup-attempt record: attempt id, script content hash, item
 * revision, trigger, started, ended, exit status, stage reached, result. Closed
 * codes and typed arguments only, never script output.
 */
export const setupAttemptSchema = lazySchema(() =>
  z.object({
    attemptId: z.string().min(1),
    scriptHash: z.string().min(1).max(128),
    itemRevision: z.number().int(),
    trigger: z.enum(["change", "retry", "resume", "restart"]),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    exitStatus: z.number().int().nullable(),
    stageReached: z.string().max(64).nullable(),
    result: z
      .enum(["succeeded", "failed", "timed_out", "cancelled", "unknown"])
      .nullable(),
  }),
);
export type SetupAttempt = z.infer<typeof setupAttemptSchema>;

export const environmentSetupAttemptsRequestSchema = emptyRequestSchema;
export type EnvironmentSetupAttemptsRequest = z.infer<
  typeof environmentSetupAttemptsRequestSchema
>;

export const environmentSetupAttemptsResponseSchema = lazySchema(() =>
  z.object({ attempts: z.array(setupAttemptSchema) }),
);
export type EnvironmentSetupAttemptsResponse = z.infer<
  typeof environmentSetupAttemptsResponseSchema
>;

/**
 * `environment.setup.retry@1.0`: reruns the script already applied, so it
 * takes no grant (the content was authorised when it was written).
 */
export const environmentSetupRetryRequestSchema = emptyRequestSchema;
export type EnvironmentSetupRetryRequest = z.infer<
  typeof environmentSetupRetryRequestSchema
>;

export const environmentSetupRetryResponseSchema = lazySchema(() =>
  z.object({ attemptId: z.string().min(1) }),
);
export type EnvironmentSetupRetryResponse = z.infer<
  typeof environmentSetupRetryResponseSchema
>;

// ── environment.secrets.* ───────────────────────────────────────────────────

/** A secret row on the Personal Secrets page (the value is never here). */
export const environmentSecretSchema = lazySchema(() =>
  z.object({
    secretId: z.string().min(1),
    name: z.string().min(1),
    /** Known: api_key, github, harness, login, key. */
    kind: z.string().min(1).max(32),
    protocol: z.string().min(1).max(32).nullable(),
    destinations: z.array(z.string().min(1)),
    /** Known: brokered, exposed. */
    mode: z.string().min(1).max(32),
    /** Known: live, pending_review. */
    state: z.string().min(1).max(32),
    currentVersionId: z.string().min(1).nullable(),
    revoked: z.boolean(),
    updatedAt: z.number(),
  }),
);
export type EnvironmentSecret = z.infer<typeof environmentSecretSchema>;

export const environmentSecretsListRequestSchema = emptyRequestSchema;
export type EnvironmentSecretsListRequest = z.infer<
  typeof environmentSecretsListRequestSchema
>;

export const environmentSecretsListResponseSchema = lazySchema(() =>
  z.object({ secrets: z.array(environmentSecretSchema) }),
);
export type EnvironmentSecretsListResponse = z.infer<
  typeof environmentSecretsListResponseSchema
>;

/**
 * A binding as the add dialog has it: the fields authn's create and
 * candidate routes take, so a database, SSH or connector secret can be
 * created and verified from the desktop. The host forwards them as they are
 * and authn validates them; `kind` and `protocol` are read as strings and
 * `policy`, `tlsPolicy` and each pinned host key as opaque records for that
 * reason. `value` is null for SSH, whose credential is the person's own SSH
 * key.
 */
const secretBindingCandidateFields = {
  kind: lazySchema(() => z.string().min(1).max(32)),
  protocol: lazySchema(() => z.string().min(1).max(32)),
  hosts: lazySchema(() => z.array(z.string().min(1).max(253)).min(1).max(16)),
  /** Null for the protocol's default port. */
  port: lazySchema(() => z.number().int().min(1).max(65_535).nullable()),
  /** The login carried in generated connection strings. */
  identity: lazySchema(() => z.string().min(1).max(256).nullable()),
  /** The database, schema, keyspace or warehouse; null when there is none. */
  database: lazySchema(() => z.string().min(1).max(256).nullable()),
  policy: lazySchema(() => z.record(z.string(), z.unknown()).nullable()),
  tlsPolicy: lazySchema(() => z.record(z.string(), z.unknown()).nullable()),
  pinnedHostKeys: lazySchema(() =>
    z.array(z.record(z.string(), z.unknown())).max(16).nullable(),
  ),
  connectorId: lazySchema(() => z.string().min(1).nullable()),
  confirmedAddresses: lazySchema(() =>
    z.array(z.string().min(2).max(64)).max(16).nullable(),
  ),
  value: lazySchema(() => z.string().min(1).max(65_536).nullable()),
};

/**
 * `environment.secrets.create@1.0`: intake. The value reaches the host over
 * the connection and the host seals it to authn's intake key before it is
 * written anywhere; the answer never carries it back. `plaintextConsent` is
 * the disclosure version shown when the protocol needs the plaintext-at-the-
 * gateway consent (the create route appends its acceptance).
 */
export const environmentSecretsCreateRequestSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1),
    ...secretBindingCandidateFields,
    mode: z.string().min(1).max(32),
    /** The person kept a port that is another protocol's default, on purpose. */
    portOverride: z.boolean(),
    /** HTTP kinds only; others send `["header"]`. Known: header, query, body. */
    swapSites: z.array(z.string().min(1).max(16)).min(1).max(3),
    /** The variables the value is set as, each in its connection dialect. */
    variables: z
      .array(
        z.object({
          name: z.string().min(1).max(256),
          dialect: z.string().min(1).max(32),
        }),
      )
      .max(16),
    /** Known: none, presigned_url, short_lived_credentials. */
    exportPolicy: z.string().min(1).max(32).nullable(),
    /** "Sandboxes get it": granted to every live and future sandbox. */
    sandboxesByDefault: z.boolean(),
    plaintextConsent: z
      .object({ disclosureVersion: z.number().int().nonnegative() })
      .nullable(),
  }),
);
export type EnvironmentSecretsCreateRequest = z.infer<
  typeof environmentSecretsCreateRequestSchema
>;

export const environmentSecretsCreateResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("created"),
      secret: environmentSecretSchema,
    }),
    z.object({ outcome: z.literal("pending"), uploadId: z.string().min(1) }),
    z.object({
      outcome: z.literal("refused"),
      /** Known: team_secrets_are_brokered, protocol_not_brokered. */
      code: z.string().min(1).max(64),
    }),
  ]),
);
export type EnvironmentSecretsCreateResponse = z.infer<
  typeof environmentSecretsCreateResponseSchema
>;

/**
 * `environment.secrets.verify@1.0`: a stored secret by id, or the add dialog's
 * candidate before the secret exists. One probe, one evidence receipt:
 * `probe_accepted`, or `probe_refused` with the closed hop code, or
 * `unreachable` when the probed incarnation is silent. Never the value or the
 * upstream's body.
 */
export const environmentSecretsVerifyRequestSchema = lazySchema(() =>
  z.discriminatedUnion("target", [
    z.object({ target: z.literal("secret"), secretId: z.string().min(1) }),
    z.object({
      target: z.literal("candidate"),
      ...secretBindingCandidateFields,
    }),
  ]),
);
export type EnvironmentSecretsVerifyRequest = z.infer<
  typeof environmentSecretsVerifyRequestSchema
>;

export const secretVerifyHopSchema = lazySchema(() =>
  z.enum(["host", "port", "protocol", "login"]),
);
export type SecretVerifyHop = z.infer<typeof secretVerifyHopSchema>;

export const secretVerifyResultSchema = lazySchema(() =>
  z.discriminatedUnion("evidence", [
    z.object({ evidence: z.literal("probe_accepted") }),
    z.object({
      evidence: z.literal("probe_refused"),
      hop: secretVerifyHopSchema,
    }),
    z.object({ evidence: z.literal("unreachable") }),
  ]),
);
export type SecretVerifyResult = z.infer<typeof secretVerifyResultSchema>;

export const environmentSecretsVerifyResponseSchema = secretVerifyResultSchema;
export type EnvironmentSecretsVerifyResponse = z.infer<
  typeof environmentSecretsVerifyResponseSchema
>;

/** The rotation states. */
export const secretRotationStateSchema = lazySchema(() =>
  z.enum(["accepted", "enforcing", "stalled", "enforced", "failed"]),
);
export type SecretRotationState = z.infer<typeof secretRotationStateSchema>;

/**
 * `environment.secrets.replaceValue@1.0`: a value replacement is a rotation,
 * compare-and-set on the version the editor read. `accepted` means committed
 * and nothing more; a stale intent is refused with the current version and who
 * moved it.
 */
export const environmentSecretsReplaceValueRequestSchema = lazySchema(() =>
  z.object({
    secretId: z.string().min(1),
    value: z.string().min(1),
    expectedVersionId: z.string().min(1),
  }),
);
export type EnvironmentSecretsReplaceValueRequest = z.infer<
  typeof environmentSecretsReplaceValueRequestSchema
>;

export const environmentSecretsReplaceValueResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("accepted"),
      rotationId: z.string().min(1),
      versionId: z.string().min(1),
    }),
    z.object({
      outcome: z.literal("stale"),
      currentVersionId: z.string().min(1),
      changedBy: environmentChangedBySchema,
    }),
    z.object({ outcome: z.literal("pending"), uploadId: z.string().min(1) }),
  ]),
);
export type EnvironmentSecretsReplaceValueResponse = z.infer<
  typeof environmentSecretsReplaceValueResponseSchema
>;

/**
 * `environment.secrets.versions@1.0` (`GET .../secrets/:secretId/versions`):
 * "the versions list with ordinal, created, superseded and destroyed times and
 * the rotation state of each (never a value)". `current` marks the live
 * version; `rotationState` is the state of the rotation that made the version
 * current, `null` for the first version.
 */
export const environmentSecretsVersionsRequestSchema = lazySchema(() =>
  z.object({ secretId: z.string().min(1) }),
);
export type EnvironmentSecretsVersionsRequest = z.infer<
  typeof environmentSecretsVersionsRequestSchema
>;

export const secretVersionSchema = lazySchema(() =>
  z.object({
    versionId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    createdAt: z.number(),
    supersededAt: z.number().nullable(),
    destroyedAt: z.number().nullable(),
    current: z.boolean(),
    rotationState: secretRotationStateSchema.nullable(),
  }),
);
export type SecretVersion = z.infer<typeof secretVersionSchema>;

export const environmentSecretsVersionsResponseSchema = lazySchema(() =>
  z.object({ versions: z.array(secretVersionSchema) }),
);
export type EnvironmentSecretsVersionsResponse = z.infer<
  typeof environmentSecretsVersionsResponseSchema
>;

/**
 * `environment.secrets.undo@1.0` (`POST .../versions/:versionId/undo`): "a
 * rotation back to that version's content under a fresh epoch, refused
 * `version_destroyed` for a tombstone and refused when the secret is revoked
 * unless the caller re-grants in the same action". `regrant` is that
 * same-action re-grant; the revoked refusal's code is `secret_revoked`.
 */
export const environmentSecretsUndoRequestSchema = lazySchema(() =>
  z.object({
    secretId: z.string().min(1),
    versionId: z.string().min(1),
    regrant: z.boolean(),
  }),
);
export type EnvironmentSecretsUndoRequest = z.infer<
  typeof environmentSecretsUndoRequestSchema
>;

export const SECRET_UNDO_REFUSAL_CODES = [
  "version_destroyed",
  "secret_revoked",
  "version_current",
  "secret_version_stale",
] as const;
export const environmentSecretsUndoResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("accepted"),
      rotationId: z.string().min(1),
      versionId: z.string().min(1),
    }),
    z.object({
      outcome: z.literal("refused"),
      code: z.string().min(1).max(64),
    }),
  ]),
);
export type EnvironmentSecretsUndoResponse = z.infer<
  typeof environmentSecretsUndoResponseSchema
>;

/**
 * `environment.secrets.destroy@1.0` (`POST .../versions/:versionId/destroy`):
 * "nulls a superseded version's ciphertext at once and records the event, and
 * is refused `version_current` for the live version until it is replaced or
 * revoked".
 */
export const environmentSecretsDestroyRequestSchema = lazySchema(() =>
  z.object({
    secretId: z.string().min(1),
    versionId: z.string().min(1),
  }),
);
export type EnvironmentSecretsDestroyRequest = z.infer<
  typeof environmentSecretsDestroyRequestSchema
>;

export const SECRET_DESTROY_REFUSAL_CODES = ["version_current"] as const;
export const environmentSecretsDestroyResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("destroyed"),
      destroyedAt: z.number(),
    }),
    z.object({
      outcome: z.literal("refused"),
      code: z.string().min(1).max(64),
    }),
  ]),
);
export type EnvironmentSecretsDestroyResponse = z.infer<
  typeof environmentSecretsDestroyResponseSchema
>;

/**
 * `environment.secrets.destroy@1.1`: `@1.0` plus `revoked`, the answer to a
 * Remove of the current version at its confirmation.
 */
export const environmentSecretsDestroyResponseSchemaV11 = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("destroyed"),
      destroyedAt: z.number(),
    }),
    z.object({
      outcome: z.literal("refused"),
      code: z.string().min(1).max(64),
    }),
    z.object({ outcome: z.literal("revoked") }),
  ]),
);
export type EnvironmentSecretsDestroyResponseV11 = z.infer<
  typeof environmentSecretsDestroyResponseSchemaV11
>;

/**
 * One evidence entry of a `rotation_ack` receipt: `kind` from the closed three,
 * and `count` as given per kind. `session_closed` counts the sessions closed,
 * nullable only for a class that holds no sessions; `cache_cleared` counts the
 * entries dropped, never null, zero allowed; `probe_refused` is null, one probe
 * being one.
 */
export const rotationEvidenceSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("session_closed"),
      count: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      kind: z.literal("cache_cleared"),
      count: z.number().int().nonnegative(),
    }),
    z.object({ kind: z.literal("probe_refused"), count: z.null() }),
  ]),
);
export type RotationEvidence = z.infer<typeof rotationEvidenceSchema>;

/**
 * One producer that owes, or wrote, a `rotation_ack`: "per host and class, the
 * evidence entries of its `rotation_ack` receipt, or 'contained by expiry' for
 * an incarnation that is no longer live". `acknowledged` carries the receipt's
 * evidence; `missing` is what keeps the rotation `enforcing`;
 * `contained_by_expiry` is an incarnation whose authorization provably ceased
 * (it owes none, and supplies no count); a host the gateway did not deliver to
 * owes none and shows `applies_on_resume`.
 */
export const rotationProducerSchema = lazySchema(() =>
  z.discriminatedUnion("producer", [
    z.object({
      producer: z.literal("worker"),
      workerClass: z.string().min(1).max(64),
      incarnation: z.string().min(1),
      status: z.enum(["acknowledged", "missing", "contained_by_expiry"]),
      evidence: z.array(rotationEvidenceSchema).nullable(),
    }),
    z.object({
      producer: z.literal("host"),
      hostId: z.string().min(1),
      incarnation: z.string().min(1).nullable(),
      status: z.enum(["acknowledged", "missing", "applies_on_resume"]),
      evidence: z.array(rotationEvidenceSchema).nullable(),
    }),
  ]),
);
export type RotationProducer = z.infer<typeof rotationProducerSchema>;

/**
 * `environment.secrets.rotation@1.0` (`GET .../secrets/:secretId/rotation`):
 * "the current rotation's state (`accepted`, `enforcing`, `stalled`,
 * `enforced`, `failed`) and, per host and class, the evidence entries of its
 * `rotation_ack` receipt ... and the secret's last Verify result". `rotationId`
 * is `SecretRotation.id`; `issuedAt` is the rotate frame's, `null` before the
 * controller's first send; `stalled` is sixty seconds after it.
 */
export const environmentSecretsRotationRequestSchema = lazySchema(() =>
  z.object({ secretId: z.string().min(1) }),
);
export type EnvironmentSecretsRotationRequest = z.infer<
  typeof environmentSecretsRotationRequestSchema
>;

export const environmentSecretsRotationResponseSchema = lazySchema(() =>
  z.object({
    rotation: z
      .object({
        rotationId: z.string().min(1),
        fromVersionId: z.string().min(1).nullable(),
        toVersionId: z.string().min(1),
        state: secretRotationStateSchema,
        issuedAt: z.number().nullable(),
        producers: z.array(rotationProducerSchema),
      })
      .nullable(),
    lastVerify: z
      .object({ result: secretVerifyResultSchema, at: z.number() })
      .nullable(),
  }),
);
export type EnvironmentSecretsRotationResponse = z.infer<
  typeof environmentSecretsRotationResponseSchema
>;

/**
 * `environment.secrets.consent@1.0` (`POST .../secrets/:secretId/consent`):
 * "appends a `SecretConsentAcceptance` row for the disclosure version shown,
 * the scope and the authenticated actor". The actor is the caller, never a
 * field. `disclosure` is that row's closed enum, open on this wire with
 * `plaintext_gateway` known.
 */
export const SECRET_CONSENT_DISCLOSURES = ["plaintext_gateway"] as const;
export const environmentSecretsConsentRequestSchema = lazySchema(() =>
  z.object({
    secretId: z.string().min(1),
    disclosure: z.string().min(1).max(64),
    disclosureVersion: z.number().int().nonnegative(),
    scope: z.enum(["secret", "environment"]),
  }),
);
export type EnvironmentSecretsConsentRequest = z.infer<
  typeof environmentSecretsConsentRequestSchema
>;

export const environmentSecretsConsentResponseSchema = lazySchema(() =>
  z.object({
    acceptanceId: z.string().min(1),
    acceptedAt: z.number(),
  }),
);
export type EnvironmentSecretsConsentResponse = z.infer<
  typeof environmentSecretsConsentResponseSchema
>;

/**
 * The `@1.1` requests of every `environment.secrets.*` method: `@1.0`'s plus
 * the environment whose secrets they address, so a team's secrets read and
 * write through the same forwarder. Null is the serving host's own
 * environment, which is what every `@1.0` request meant. The responses are
 * `@1.0`'s, but for `versions`, which gains `removal`, and `list`, which gains
 * `removed`.
 */
const secretsEnvironmentIdField = {
  environmentId: lazySchema(() => z.string().min(1).nullable().default(null)),
};

export const environmentSecretsListRequestSchemaV11 = lazySchema(() =>
  z.object(secretsEnvironmentIdField),
);
export type EnvironmentSecretsListRequestV11 = z.infer<
  typeof environmentSecretsListRequestSchemaV11
>;

export const environmentSecretsCreateRequestSchemaV11 = lazySchema(() =>
  environmentSecretsCreateRequestSchema.extend(secretsEnvironmentIdField),
);
export type EnvironmentSecretsCreateRequestV11 = z.infer<
  typeof environmentSecretsCreateRequestSchemaV11
>;

export const environmentSecretsDestroyRequestSchemaV11 = lazySchema(() =>
  environmentSecretsDestroyRequestSchema.extend(secretsEnvironmentIdField),
);
export type EnvironmentSecretsDestroyRequestV11 = z.infer<
  typeof environmentSecretsDestroyRequestSchemaV11
>;

export const environmentSecretsVersionsRequestSchemaV11 = lazySchema(() =>
  environmentSecretsVersionsRequestSchema.extend(secretsEnvironmentIdField),
);
export type EnvironmentSecretsVersionsRequestV11 = z.infer<
  typeof environmentSecretsVersionsRequestSchemaV11
>;

export const environmentSecretsRotationRequestSchemaV11 = lazySchema(() =>
  environmentSecretsRotationRequestSchema.extend(secretsEnvironmentIdField),
);
export type EnvironmentSecretsRotationRequestV11 = z.infer<
  typeof environmentSecretsRotationRequestSchemaV11
>;

export const environmentSecretsVerifyRequestSchemaV11 = lazySchema(() =>
  z.discriminatedUnion("target", [
    z.object({
      target: z.literal("secret"),
      secretId: z.string().min(1),
      ...secretsEnvironmentIdField,
    }),
    z.object({
      target: z.literal("candidate"),
      ...secretBindingCandidateFields,
      ...secretsEnvironmentIdField,
    }),
  ]),
);
export type EnvironmentSecretsVerifyRequestV11 = z.infer<
  typeof environmentSecretsVerifyRequestSchemaV11
>;

export const environmentSecretsReplaceValueRequestSchemaV11 = lazySchema(() =>
  environmentSecretsReplaceValueRequestSchema.extend(secretsEnvironmentIdField),
);
export type EnvironmentSecretsReplaceValueRequestV11 = z.infer<
  typeof environmentSecretsReplaceValueRequestSchemaV11
>;

export const environmentSecretsUndoRequestSchemaV11 = lazySchema(() =>
  environmentSecretsUndoRequestSchema.extend(secretsEnvironmentIdField),
);
export type EnvironmentSecretsUndoRequestV11 = z.infer<
  typeof environmentSecretsUndoRequestSchemaV11
>;

export const environmentSecretsConsentRequestSchemaV11 = lazySchema(() =>
  environmentSecretsConsentRequestSchema.extend(secretsEnvironmentIdField),
);
export type EnvironmentSecretsConsentRequestV11 = z.infer<
  typeof environmentSecretsConsentRequestSchemaV11
>;

/**
 * `versions@1.1`'s answer: `@1.0`'s plus the secret's removal, null while it
 * has none. `outcome` is how far the removal reached; `targets` is each place
 * that held it (a host, the broker's current, old and held copies) and whether
 * its removal there is `requested` or `confirmed`. Never a value.
 */
const environmentSecretRemovalTargetSchema = lazySchema(() =>
  z.object({
    target: z.enum(["host", "broker_current", "broker_old", "broker_held"]),
    hostId: z.string().min(1).nullable(),
    hostName: z.string().nullable(),
    state: z.enum(["requested", "confirmed"]),
    at: z.number(),
  }),
);

export const environmentSecretRemovalSchema = lazySchema(() =>
  z.object({
    outcome: z.enum(["revoked", "cleanup_requested", "destroyed"]),
    revokedAt: z.number(),
    destroyedAt: z.number().nullable(),
    targets: z.array(environmentSecretRemovalTargetSchema),
  }),
);
export type EnvironmentSecretRemoval = z.infer<
  typeof environmentSecretRemovalSchema
>;

/**
 * `list@1.1`'s answer: `@1.0`'s rows unchanged, plus the secrets removed in
 * the last 30 days, kept as metadata: id, name and how far the removal
 * reached. A `@1.0` answer upgrades with none.
 */
export const environmentSecretsListResponseSchemaV11 = lazySchema(() =>
  z.object({
    secrets: z.array(environmentSecretSchema),
    removed: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          removal: environmentSecretRemovalSchema,
        }),
      )
      .default([]),
  }),
);
export type EnvironmentSecretsListResponseV11 = z.infer<
  typeof environmentSecretsListResponseSchemaV11
>;

/**
 * `list@1.2`'s row: `@1.1`'s plus the names a computer running the
 * configuration sets the secret's value under. `variables` are the
 * configuration's variable names (Variables & shells); `providerVariables`
 * are names in one provider's env (a provider's Env tab), by provider id.
 * The desktop shows such a name as the secret's, never as a plain value.
 */
export const environmentSecretSchemaV12 = lazySchema(() =>
  environmentSecretSchema.extend({
    variables: z.array(z.string().min(1)),
    providerVariables: z.array(
      z.object({ providerId: z.string().min(1), name: z.string().min(1) }),
    ),
  }),
);
export type EnvironmentSecretV12 = z.infer<typeof environmentSecretSchemaV12>;

export const environmentSecretsListRequestSchemaV12 =
  environmentSecretsListRequestSchemaV11;
export type EnvironmentSecretsListRequestV12 = z.infer<
  typeof environmentSecretsListRequestSchemaV12
>;

/**
 * `list@1.2`'s removal: `@1.1`'s, each target with `failedAt`, when a host
 * that still holds a copy last said it could not delete it (it tries again
 * by itself), else null. An authn that predates it sends none: null.
 */
export const environmentSecretRemovalSchemaV12 = lazySchema(() =>
  environmentSecretRemovalSchema.extend({
    targets: z.array(
      environmentSecretRemovalTargetSchema.extend({
        failedAt: z.number().nullable().default(null),
      }),
    ),
  }),
);
export type EnvironmentSecretRemovalV12 = z.infer<
  typeof environmentSecretRemovalSchemaV12
>;

/** `list@1.2`'s answer: `@1.1`'s, its rows with their names, its removals with their failures. */
export const environmentSecretsListResponseSchemaV12 = lazySchema(() =>
  environmentSecretsListResponseSchemaV11.extend({
    secrets: z.array(environmentSecretSchemaV12),
    removed: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          removal: environmentSecretRemovalSchemaV12,
        }),
      )
      .default([]),
  }),
);
export type EnvironmentSecretsListResponseV12 = z.infer<
  typeof environmentSecretsListResponseSchemaV12
>;

export const environmentSecretsVersionsResponseSchemaV11 = lazySchema(() =>
  environmentSecretsVersionsResponseSchema.extend({
    removal: environmentSecretRemovalSchema.nullable().default(null),
  }),
);
export type EnvironmentSecretsVersionsResponseV11 = z.infer<
  typeof environmentSecretsVersionsResponseSchemaV11
>;

// ── environment.reachDiagnostics ────────────────────────────────────────────

/**
 * A host's owner as a category only: never an id, never a team's name.
 * `unknown` is a directory row with no owner, or a host the account's
 * directory does not list.
 */
export const reachPrincipalCategorySchema = lazySchema(() =>
  z.enum(["personal", "team", "unknown"]),
);
export type ReachPrincipalCategory = z.infer<
  typeof reachPrincipalCategorySchema
>;

/**
 * One same-principal refusal this host made: the opaque source and target host
 * references, the task, the reason and the two principal categories. Never
 * message text, never a display label. `count` folds the repeats of one
 * (target, task, category pair) inside its window.
 */
export const reachDenialSchema = lazySchema(() =>
  z.object({
    denialId: z.string().min(1).max(64),
    at: z.number().int().nonnegative(),
    sourceHostRef: z.string().min(1).max(256),
    targetHostRef: z.string().min(1).max(256),
    taskRef: z.string().min(1).max(256).nullable(),
    reason: z.literal("principal_mismatch"),
    sourcePrincipal: reachPrincipalCategorySchema,
    targetPrincipal: reachPrincipalCategorySchema,
    count: z.number().int().positive(),
  }),
);
export type ReachDenial = z.infer<typeof reachDenialSchema>;

/**
 * `environment.reachDiagnostics@1.0`, the support bundle's read.
 * `epicId` is the task the person has selected, or `null`.
 */
export const environmentReachDiagnosticsRequestSchema = lazySchema(() =>
  z.object({ epicId: z.string().min(1).nullable() }),
);
export type EnvironmentReachDiagnosticsRequest = z.infer<
  typeof environmentReachDiagnosticsRequestSchema
>;

/** The most denials one answer carries, newest first. */
export const REACH_DIAGNOSTICS_MAX_DENIALS = 20;

/**
 * `denials`: this host's recent refusals, newest first. `servedTask`: the
 * selected task, with the principal categories of the OTHER hosts that carry
 * agents in it (each category once); `null` with no task selected or none
 * this host holds.
 */
export const environmentReachDiagnosticsResponseSchema = lazySchema(() =>
  z.object({
    denials: z.array(reachDenialSchema).max(REACH_DIAGNOSTICS_MAX_DENIALS),
    servedTask: z
      .object({
        taskRef: z.string().min(1).max(256),
        otherHostPrincipals: z.array(reachPrincipalCategorySchema).max(3),
      })
      .nullable(),
  }),
);
export type EnvironmentReachDiagnosticsResponse = z.infer<
  typeof environmentReachDiagnosticsResponseSchema
>;
