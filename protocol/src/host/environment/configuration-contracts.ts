/**
 * A configuration's settings read and written through the server pool, for a
 * team configuration as for Personal: the caller names the environment, and
 * the host forwards to that environment's authn routes on the caller's
 * session.
 *
 * `environment.configuration.items` / `.items.put` / `.items.delete` - the
 * item rows, compare-and-set per address on each row's own revision.
 * `environment.configuration.mcpServers.put` - an MCP server with its
 * credential. `environment.configuration.skills.upload` - a skill folder.
 * `environment.configuration.policy.put` - the approval policy.
 * `environment.history` - what happened to a configuration, or to one thing
 * in it.
 *
 * Every answer is value-free of secrets: the item routes serve no `secret`
 * row, a credential travels only in a request, and no answer carries one
 * back. Optional capabilities with `degrade: { kind: "unsupported" }`.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  environmentItemKindSchema,
  environmentOsSchema,
} from "@traycer/protocol/host/environment-schemas";

const environmentIdSchema = lazySchema(() => z.string().min(1));
const itemKeySchema = lazySchema(() => z.string().min(1).max(3072));
const itemRevisionSchema = lazySchema(() => z.number().int().nonnegative());

// ── environment.configuration.items ─────────────────────────────────────────

export const environmentConfigurationItemsRequestSchema = lazySchema(() =>
  z.object({ environmentId: environmentIdSchema }),
);
export type EnvironmentConfigurationItemsRequest = z.infer<
  typeof environmentConfigurationItemsRequestSchema
>;

/** Known `writtenBy.source` values: live, offline, migration, undo. */
export const ENVIRONMENT_ITEM_WRITTEN_BY_SOURCES = [
  "live",
  "offline",
  "migration",
  "undo",
] as const;

/**
 * One item row as authn's items route answers it. `os` is null for a kind
 * with no per-OS rows; `revision` is the row's own, the one a write quotes;
 * `writtenBy` is who wrote it last (`live` with no host is the dashboard).
 */
export const environmentConfigurationItemSchema = lazySchema(() =>
  z.object({
    kind: environmentItemKindSchema,
    key: itemKeySchema,
    os: environmentOsSchema.nullable(),
    value: z.json(),
    revision: itemRevisionSchema,
    updatedAt: z.number().int().nonnegative(),
    writtenBy: z.object({
      source: z.string().min(1).max(32),
      hostId: z.string().min(1).nullable(),
      hostName: z.string().max(256).nullable(),
    }),
  }),
);
export type EnvironmentConfigurationItem = z.infer<
  typeof environmentConfigurationItemSchema
>;

export const environmentConfigurationItemsResponseSchema = lazySchema(() =>
  z.object({ items: z.array(environmentConfigurationItemSchema) }),
);
export type EnvironmentConfigurationItemsResponse = z.infer<
  typeof environmentConfigurationItemsResponseSchema
>;

export const environmentConfigurationItemsV10 = defineRpcContract({
  method: "environment.configuration.items",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationItemsRequestSchema,
  responseSchema: environmentConfigurationItemsResponseSchema,
});

/**
 * `environment.configuration.items.put@1.0`: one row, against the revision
 * the editor read; `revision` null creates.
 */
export const environmentConfigurationItemPutRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    kind: environmentItemKindSchema,
    key: itemKeySchema,
    os: environmentOsSchema.nullable(),
    value: z.json(),
    revision: itemRevisionSchema.nullable(),
  }),
);
export type EnvironmentConfigurationItemPutRequest = z.infer<
  typeof environmentConfigurationItemPutRequestSchema
>;

/** `environment.configuration.items.delete@1.0`: the same address and revision. */
export const environmentConfigurationItemDeleteRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    kind: environmentItemKindSchema,
    key: itemKeySchema,
    os: environmentOsSchema.nullable(),
    revision: itemRevisionSchema.nullable(),
  }),
);
export type EnvironmentConfigurationItemDeleteRequest = z.infer<
  typeof environmentConfigurationItemDeleteRequestSchema
>;

/**
 * The answer to a put or a delete. `saved` with the address's new revision,
 * null for a delete authn answers with no revision; `conflict` when the row moved since the revision the editor read, with the
 * row as it stands and who changed it (`changedBy` a person's or a host's
 * name, null when there is none to show), or `current: null` when the row is
 * gone; `forbidden` for a reader who may not write this configuration.
 */
export const environmentConfigurationItemWriteResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("saved"),
      revision: itemRevisionSchema.nullable(),
    }),
    z.object({
      outcome: z.literal("conflict"),
      current: z
        .object({
          revision: itemRevisionSchema,
          changedBy: z.string().nullable(),
          changedAt: z.number().int().nonnegative(),
        })
        .nullable(),
    }),
    z.object({ outcome: z.literal("forbidden") }),
  ]),
);
export type EnvironmentConfigurationItemWriteResponse = z.infer<
  typeof environmentConfigurationItemWriteResponseSchema
>;

export const environmentConfigurationItemsPutV10 = defineRpcContract({
  method: "environment.configuration.items.put",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationItemPutRequestSchema,
  responseSchema: environmentConfigurationItemWriteResponseSchema,
});

export const environmentConfigurationItemsDeleteV10 = defineRpcContract({
  method: "environment.configuration.items.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationItemDeleteRequestSchema,
  responseSchema: environmentConfigurationItemWriteResponseSchema,
});

// ── mcpServers.put / skills.upload / policy.put ─────────────────────────────

/**
 * The answer to an MCP server, skill or policy write: `saved`, `forbidden`
 * for a reader who may not write it, or `refused` by authn with its code in
 * `reason` (a stale policy version, a team-only policy, an invalid body).
 * `reason` is null unless `refused`.
 */
export const environmentConfigurationWriteResponseSchema = lazySchema(() =>
  z.object({
    outcome: z.enum(["saved", "forbidden", "refused"]),
    reason: z.string().min(1).max(64).nullable(),
  }),
);
export type EnvironmentConfigurationWriteResponse = z.infer<
  typeof environmentConfigurationWriteResponseSchema
>;

/**
 * An MCP server's credential on a write: `unchanged` keeps what the server
 * holds (a read never returns it), `none` removes it, `pat` and `headers` set
 * it; authn stores it as a broker secret. A `stdio` server carries `none` or
 * `unchanged`.
 */
export const environmentMcpServerCredentialSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unchanged") }),
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("pat"), pat: z.string().min(1).max(4096) }),
    z.object({
      kind: z.literal("headers"),
      headers: z.record(z.string().min(1).max(256), z.string().max(8192)),
    }),
  ]),
);
export type EnvironmentMcpServerCredential = z.infer<
  typeof environmentMcpServerCredentialSchema
>;

/**
 * `environment.configuration.mcpServers.put@1.0`: authn's `mcp-servers`
 * route body, the declaration plus its credential. `serverId` null creates;
 * otherwise the declaration replaces the named server's. An `http` server
 * names its `url`, a `stdio` server its `command`; `env` names the variables
 * it reads, never their values; `toolToggles` is per harness id, each tool's
 * on or off.
 */
export const environmentConfigurationMcpServerPutRequestSchema = lazySchema(
  () =>
    z.object({
      environmentId: environmentIdSchema,
      serverId: z.string().min(1).nullable(),
      name: z.string().min(1).max(128),
      transport: z.enum(["http", "stdio"]),
      url: z.string().min(1).max(2048).nullable(),
      command: z.string().min(1).max(1024).nullable(),
      args: z.array(z.string().max(4096)).max(64),
      env: z.array(z.string().min(1).max(128)).max(64),
      toolToggles: z.record(
        z.string().min(1).max(64),
        z.record(z.string().min(1).max(256), z.boolean()),
      ),
      credential: environmentMcpServerCredentialSchema,
    }),
);
export type EnvironmentConfigurationMcpServerPutRequest = z.infer<
  typeof environmentConfigurationMcpServerPutRequestSchema
>;

export const environmentConfigurationMcpServersPutV10 = defineRpcContract({
  method: "environment.configuration.mcpServers.put",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationMcpServerPutRequestSchema,
  responseSchema: environmentConfigurationWriteResponseSchema,
});

/** authn's cap on one skill folder's archive, in bytes. */
export const ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * `environment.configuration.skills.upload@1.0`: authn's `skill-content`
 * route body, a skill folder as a gzipped tar in standard base64, and the
 * skill's name. The host uploads the archive and writes the `skill` item that
 * names it.
 */
export const environmentConfigurationSkillUploadRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    name: z.string().min(1).max(128),
    archive: z
      .base64()
      .max(Math.ceil(ENVIRONMENT_SKILL_ARCHIVE_MAX_BYTES / 3) * 4),
  }),
);
export type EnvironmentConfigurationSkillUploadRequest = z.infer<
  typeof environmentConfigurationSkillUploadRequestSchema
>;

export const environmentConfigurationSkillsUploadV10 = defineRpcContract({
  method: "environment.configuration.skills.upload",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationSkillUploadRequestSchema,
  responseSchema: environmentConfigurationWriteResponseSchema,
});

/** authn's cap on a team policy document, in bytes. */
export const ENVIRONMENT_POLICY_MAX_BYTES = 64 * 1024;

/**
 * `environment.configuration.policy.put@1.0`: authn's `policy` route body, the
 * policy document against the version the editor read (a decimal revision),
 * null to write the first one.
 */
export const environmentConfigurationPolicyPutRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    body: z.string().max(ENVIRONMENT_POLICY_MAX_BYTES),
    policyVersion: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,18})$/)
      .nullable(),
  }),
);
export type EnvironmentConfigurationPolicyPutRequest = z.infer<
  typeof environmentConfigurationPolicyPutRequestSchema
>;

export const environmentConfigurationPolicyPutV10 = defineRpcContract({
  method: "environment.configuration.policy.put",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentConfigurationPolicyPutRequestSchema,
  responseSchema: environmentConfigurationWriteResponseSchema,
});

// ── environment.history ─────────────────────────────────────────────────────

/**
 * What a history reads about, beyond the item kinds: a secret, a member, the
 * team's plan, the move, and a host's settings. Open, like the item kinds.
 */
export const ENVIRONMENT_HISTORY_SUBJECT_EXTRA_KINDS = [
  "secret",
  "member",
  "plan",
  "move",
  "host_settings",
] as const;

/** The whole configuration's history when `subject` is null. */
export const environmentHistoryRequestSchema = lazySchema(() =>
  z.object({
    environmentId: environmentIdSchema,
    subject: z
      .object({ kind: environmentItemKindSchema, key: z.string().min(1) })
      .nullable(),
  }),
);
export type EnvironmentHistoryRequest = z.infer<
  typeof environmentHistoryRequestSchema
>;

/**
 * One event. `actor` is who did it, `tombstoned` once that person's account
 * is gone (the label is then what remains of them), null for the system;
 * `operation` and `outcome` are open codes; `hostStates` is how each host of
 * the configuration took it, `state` an open code with its `reason`.
 */
export const environmentHistoryEntrySchema = lazySchema(() =>
  z.object({
    at: z.number().int().nonnegative(),
    actor: z.object({ label: z.string(), tombstoned: z.boolean() }).nullable(),
    operation: z.string().min(1).max(64),
    outcome: z.string().min(1).max(64),
    hostStates: z.array(
      z.object({
        hostId: z.string().min(1),
        name: z.string(),
        state: z.string().min(1).max(32),
        reason: z.string().min(1).max(64).nullable(),
        at: z.number().int().nonnegative(),
      }),
    ),
  }),
);
export type EnvironmentHistoryEntry = z.infer<
  typeof environmentHistoryEntrySchema
>;

/**
 * Newest first. `readerScope` is how much of it this reader may see: `full`,
 * `own` (only the reader's own events), or `status_only` (no entries; the
 * client draws no history).
 */
export const environmentHistoryResponseSchema = lazySchema(() =>
  z.object({
    entries: z.array(environmentHistoryEntrySchema),
    readerScope: z.enum(["full", "own", "status_only"]),
  }),
);
export type EnvironmentHistoryResponse = z.infer<
  typeof environmentHistoryResponseSchema
>;

export const environmentHistoryV10 = defineRpcContract({
  method: "environment.history",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentHistoryRequestSchema,
  responseSchema: environmentHistoryResponseSchema,
});
