// Mirrors the fields the app reads from authn's environment routes. Non-strict,
// so a field a newer authn adds still parses.
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  credentialVersionSchema,
  spendScopeKeySchema,
} from "@traycer/protocol/host/provider-credential-home-schemas";

export const ITEM_OS_VALUES = ["any", "linux", "macos", "windows"] as const;

/** `secret` and `member` are never read here; `auto_policy` is written only through the policy route. */
export const ITEM_ROUTE_KINDS = [
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
  "agent_memory",
  "agent_selection_guide",
  "auto_policy",
  "sandbox_defaults",
  "storage_policy",
  "snapshot_policy",
] as const;
const revisionSchema = lazySchema(() => z.number().int().nonnegative());
const epochMsSchema = lazySchema(() => z.number().int().nonnegative());
const nullableOsSchema = lazySchema(() => z.enum(ITEM_OS_VALUES).nullable());

const authnItemRowSchema = lazySchema(() =>
  z.object({
    kind: z.string().min(1).max(64),
    key: z.string().min(1).max(3072),
    os: nullableOsSchema,
    value: z.json(),
    revision: revisionSchema,
    updatedAt: epochMsSchema,
    writtenBy: z.object({
      source: z.string().min(1).max(32),
      hostId: z.string().nullable(),
      hostName: z.string().max(256).nullable(),
    }),
  }),
);
export type AuthnItemRow = z.infer<typeof authnItemRowSchema>;

export const authnItemsResponseSchema = lazySchema(() =>
  z.object({ items: z.array(authnItemRowSchema) }),
);

export const authnItemWriteResponseSchema = lazySchema(() =>
  z.object({
    item: authnItemRowSchema.nullable(),
    replayed: z.boolean(),
    revision: revisionSchema,
  }),
);
/** `current` is null when the row is gone. */
export const authnItemConflictSchema = lazySchema(() =>
  z.object({
    code: z.literal("revision_conflict"),
    current: authnItemRowSchema.nullable(),
  }),
);

export const authnMcpServerItemValueSchema = lazySchema(() =>
  z.object({
    mcpServerId: z.string().min(1),
    toolToggles: z.record(z.string(), z.record(z.string(), z.boolean())),
    offFor: z.array(z.string()).optional(),
  }),
);

const authnMcpCredentialSchema = lazySchema(() =>
  z.object({ present: z.boolean(), secretId: z.string().nullable() }),
);

const authnMcpServerSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(128),
    transport: z.enum(["http", "stdio"]),
    url: z.string().nullable(),
    command: z.string().nullable(),
    args: z.array(z.string()),
    env: z.array(z.string()),
    toolToggles: z.record(z.string(), z.record(z.string(), z.boolean())),
    credentials: z.object({
      pat: authnMcpCredentialSchema,
      customHeaders: authnMcpCredentialSchema,
      oauth: z.object({ present: z.boolean() }),
    }),
  }),
);
export type AuthnMcpServer = z.infer<typeof authnMcpServerSchema>;

export const authnMcpServersResponseSchema = lazySchema(() =>
  z.object({ servers: z.array(authnMcpServerSchema) }),
);
export const authnMcpServerResponseSchema = lazySchema(() =>
  z.object({ server: authnMcpServerSchema }),
);
export const authnMcpServerDeleteResponseSchema = lazySchema(() =>
  z.object({ deleted: z.boolean() }),
);

/** `variables` is absent from an authn that predates it. */
export const authnSecretRowSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.string().min(1),
    protocol: z.string().min(1),
    hosts: z.array(z.string()),
    currentVersionId: z.string().min(1),
    updatedAt: z.number(),
    variables: z.array(z.object({ name: z.string().min(1) })).default([]),
  }),
);
export type AuthnSecretRow = z.infer<typeof authnSecretRowSchema>;

export const authnSecretsListSchema = lazySchema(() =>
  z.object({
    secrets: z.array(authnSecretRowSchema),
    removed: z.array(z.unknown()).default([]),
  }),
);

export const SECRETS_LIST_INCLUDES = ["cleanup_failure"] as const;

const authnHarnessConnectionSchema = lazySchema(() =>
  z.object({
    profileId: z.string().min(1),
    harnessId: z.string().min(1),
    bindingVersion: z.number().int().positive().nullable().optional(),
    kind: z.string().min(1),
    status: z.enum([
      "absent",
      "pending",
      "staged",
      "connected",
      "expired",
      "failed",
    ]),
    linkedBy: z
      .object({ displayName: z.string(), you: z.boolean() })
      .nullable(),
  }),
);
export type AuthnHarnessConnection = z.infer<
  typeof authnHarnessConnectionSchema
>;

export const authnHarnessConnectionsResponseSchema = lazySchema(() =>
  z.object({ connections: z.array(authnHarnessConnectionSchema) }),
);
export const authnHarnessDisconnectResponseSchema = lazySchema(() =>
  z.object({ disconnected: z.boolean() }),
);

/**
 * The capability a `managed_profile` item read names to carry the item's
 * binding fields: `MANAGED_PROFILE_IDENTITY_CAPABILITY` in the internal
 * repository's `packages/common/src/environments/managed-profile-projection.ts`.
 */
export const MANAGED_PROFILE_IDENTITY_CAPABILITY = "managed_profile_identity";

/** The binding fields of a `managed_profile` item read with that capability. */
export const authnManagedProfileBindingSchema = lazySchema(() =>
  z.object({
    bindingVersion: credentialVersionSchema.optional(),
    spendScopeKey: spendScopeKeySchema.optional(),
    custodianSignOutCause: z.literal("signed-out-by-person").optional(),
    mergedInto: z.string().optional(),
  }),
);

// ── review, notices, undo ───────────────────────────────────────────────────

/**
 * The `include` value of `GET …/review?include=operation`: the view whose
 * holds carry put or delete. Without it a held delete is left out.
 */
export const REVIEW_INCLUDE_OPERATION = "operation";

function heldChangeFields() {
  return {
    type: z.literal("held"),
    heldId: z.string().min(1),
    revision: revisionSchema,
    kind: z.string().min(1).max(64),
    key: z.string().min(1).max(3072),
    os: nullableOsSchema,
    hostId: z.string().min(1),
    /** Null for a hold stored before it was recorded. */
    sharingGeneration: z.number().int().nonnegative().nullable(),
    hostName: z.string().max(256),
    heldAt: epochMsSchema,
    live: z.object({ revision: revisionSchema, value: z.json() }).nullable(),
  };
}

const authnReviewHeldChangeSchema = lazySchema(() =>
  z.discriminatedUnion("op", [
    z.object({ ...heldChangeFields(), op: z.literal("put"), value: z.json() }),
    z.object({
      ...heldChangeFields(),
      op: z.literal("delete"),
      value: z.null(),
    }),
  ]),
);
/** A migrated account whose sign-in did not move. */
const authnReviewNeedsLinkSchema = lazySchema(() =>
  z.object({
    type: z.literal("needs_link"),
    key: z.string().min(1),
    harnessId: z.string().min(1),
    name: z.string().min(1),
    hostId: z.string().nullable(),
    hostName: z.string().max(256),
  }),
);

export const authnOperationReviewResponseSchema = lazySchema(() =>
  z.object({
    review: z
      .object({
        hosts: z.array(
          z.object({
            hostId: z.string(),
            hostName: z.string().max(256),
            migratedAt: epochMsSchema,
          }),
        ),
        needsYou: z.array(
          z.union([authnReviewHeldChangeSchema, authnReviewNeedsLinkSchema]),
        ),
      })
      .nullable(),
  }),
);
export const authnHeldApplyConflictSchema = lazySchema(() =>
  z.discriminatedUnion("code", [
    z.object({ code: z.literal("superseded") }),
    z.object({
      code: z.literal("revision_conflict"),
      current: authnItemRowSchema.nullable(),
    }),
  ]),
);

const authnNoticeRowSchema = lazySchema(() =>
  z.object({
    kind: z.string().min(1).max(64),
    key: z.string().min(1).max(3072),
    os: nullableOsSchema,
    revision: revisionSchema,
    writtenAt: epochMsSchema,
    source: z.string().min(1).max(32),
    hostId: z.string().nullable(),
    hostName: z.string().max(256).nullable(),
    displaced: z.json(),
  }),
);
export type AuthnNoticeRow = z.infer<typeof authnNoticeRowSchema>;

export const authnNoticesResponseSchema = lazySchema(() =>
  z.object({ notices: z.array(authnNoticeRowSchema) }),
);

const UNDO_REFUSAL_CODES = [
  "superseded",
  "nothing_displaced",
  "change_not_found",
] as const;

export const authnUndoResponseSchema = lazySchema(() =>
  z.object({ item: authnItemRowSchema }),
);
export const authnUndoConflictSchema = lazySchema(() =>
  z.object({
    code: z.enum(UNDO_REFUSAL_CODES),
    current: authnItemRowSchema.nullable(),
  }),
);

/** A seat stored on the retired Viewer role answers `null`, which reads as `viewer`. */
export const authnMemberRoleSchema = lazySchema(() =>
  z
    .enum(["admin", "editor", "viewer"])
    .nullable()
    .transform((role) => role ?? "viewer"),
);
