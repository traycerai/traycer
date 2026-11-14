/**
 * authn's environment routes as the app reads them. The routes' own schemas
 * live in the internal repository (`packages/common/src/environments/`), which
 * this tree cannot import; these mirror the fields the app reads, field for
 * field. Reads parse non-strictly, so an authn that adds a field still reads;
 * request bodies are built from the protocol's request types by the callers.
 */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const ITEM_OS_VALUES = ["any", "linux", "macos", "windows"] as const;

/**
 * Every kind the items route serves to a person: authn's kinds less the two it
 * never reads through this route (`secret`, `member`). `auto_policy` is read
 * here and written only through the policy route.
 */
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
] as const;

const revisionSchema = lazySchema(() => z.number().int().nonnegative());
const epochMsSchema = lazySchema(() => z.number().int().nonnegative());
const nullableOsSchema = lazySchema(() => z.enum(ITEM_OS_VALUES).nullable());

// ── items ───────────────────────────────────────────────────────────────────

/** One row of `GET …/items?kind=`: who wrote it last beside its value and revision. */
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

/** 200 to a `PUT` or `DELETE` on `…/items/:kind`: the row as it stands, null after a delete. */
export const authnItemWriteResponseSchema = lazySchema(() =>
  z.object({
    item: authnItemRowSchema.nullable(),
    replayed: z.boolean(),
    revision: revisionSchema,
  }),
);
/** 409: the row moved since the revision sent; `current` null when it is gone. */
export const authnItemConflictSchema = lazySchema(() =>
  z.object({
    code: z.literal("revision_conflict"),
    current: authnItemRowSchema.nullable(),
  }),
);

/** The `mcp_server` item's value: which server row it installs, and for whom not. */
export const authnMcpServerItemValueSchema = lazySchema(() =>
  z.object({
    mcpServerId: z.string().min(1),
    toolToggles: z.record(z.string(), z.record(z.string(), z.boolean())),
    offFor: z.array(z.string()).optional(),
  }),
);

// ── MCP servers ─────────────────────────────────────────────────────────────

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

// ── secrets ─────────────────────────────────────────────────────────────────

/**
 * One row of `GET …/secrets` (and of a create's answer): the fields the
 * protocol row carries. `variables` is absent from an authn that predates it.
 */
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

/** What a list caller asks for beyond the shape every host parses. */
export const SECRETS_LIST_INCLUDES = ["cleanup_failure"] as const;

// ── plans (harness connections) ─────────────────────────────────────────────

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

// ── review, notices, undo ───────────────────────────────────────────────────

/**
 * The `include` value of `GET …/review?include=operation`: the view whose
 * holds carry put or delete. Without it a held delete is left out.
 */
export const REVIEW_INCLUDE_OPERATION = "operation";

/** The fields a held put and a held delete share. */
function heldChangeFields() {
  return {
    type: z.literal("held"),
    heldId: z.string().min(1),
    /** The hold's version; Apply names exactly this one. */
    revision: revisionSchema,
    kind: z.string().min(1).max(64),
    key: z.string().min(1).max(3072),
    os: nullableOsSchema,
    /** The host that proposed it. */
    hostId: z.string().min(1),
    /** That host's ownership generation when it proposed; null for a hold stored before it was recorded. */
    sharingGeneration: z.number().int().nonnegative().nullable(),
    hostName: z.string().max(256),
    heldAt: epochMsSchema,
    /** The item at this address now; null when it does not exist. */
    live: z.object({ revision: revisionSchema, value: z.json() }).nullable(),
  };
}

/** A held change as the operation view carries it: a put with its value, or a delete. */
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
/** 409 to an apply with both revisions. */
export const authnHeldApplyConflictSchema = lazySchema(() =>
  z.discriminatedUnion("code", [
    z.object({ code: z.literal("superseded") }),
    z.object({
      code: z.literal("revision_conflict"),
      current: authnItemRowSchema.nullable(),
    }),
  ]),
);

/** One row of `GET …/notices`: a change that displaced a value Undo can restore. */
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
