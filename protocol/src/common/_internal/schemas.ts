import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Private Zod values for the non-recursive common-vocabulary records.
 *
 * These schemas are the contract authority for their record types.
 * Consumers obtain the runtime schema through
 * `getRecordSchema(commonRecordRegistry, "<record-name>", "latest")`
 * and the inferred TypeScript type through
 * `RecordValue<typeof commonRecordRegistry, "<record-name>">`. There
 * are no public TS type aliases for record shapes - the Zod schema is
 * the single source of truth.
 *
 * The recursive `json-content` record lives in
 * `protocol/common/registry.ts` next to the registry: `z.lazy()`
 * requires an explicit `z.ZodType<JsonContent>` annotation, and the
 * `JsonContent` type alias has to live wherever it can be named
 * without leaking out of `_internal/`. Co-locating both with the
 * registry keeps `_internal/` free of any type that crosses the
 * privacy boundary.
 */

export const attachmentMentionAttrsSchema = lazySchema(() =>
  z.object({
    contextType: z.literal("attachment"),
    fileName: z.string(),
    b64content: z.string().optional(),
    url: z.string().optional(),
    altText: z.string().optional(),
  }),
);

export const attachmentMentionNodeSchema = lazySchema(() =>
  z.object({
    type: z.literal("mention"),
    attrs: attachmentMentionAttrsSchema,
  }),
);

/**
 * Every role value a wire payload or a persisted room may still DECODE,
 * `viewer` among them.
 *
 * `viewer` is retired: no grant names it, no writer stores it, and every
 * reader resolves it to no access through `grantedRole`
 * (`protocol/common/permission-role`). It stays in the vocabulary because
 * removing it would break decoding in three places at once, and a role that
 * cannot be decoded is not a role that is refused - it is a payload that
 * fails to parse:
 *
 * 1. `collaboratorRolesSchema` is a `z.record` over this schema, so a legacy
 *    room whose map still holds `viewer` would fail the whole
 *    `room-metadata` record and take the room down for everyone in it.
 * 2. Released peers down to the support floor send `viewer` on the grant and
 *    role-change requests. Parsing it is what lets the host refuse it BY NAME,
 *    with a message naming the role to choose instead, rather than failing the
 *    frame.
 * 3. A current client still opens tasks on hosts that predate the retirement,
 *    and those hosts legitimately answer `viewer` rows.
 *
 * The roles a grant may name are {@link grantedPermissionRoleSchema}. That
 * narrower type - not this one - is what the rest of the tree means by a
 * role, so the compiler shows every place a decoded value crosses into one.
 */
export const permissionRoleSchema = lazySchema(() =>
  z.enum(["owner", "editor", "viewer"]),
);

export const ticketStatusSchema = lazySchema(() =>
  z.union([z.literal(0), z.literal(1), z.literal(2)]),
);

export const markdownArtifactKindSchema = lazySchema(() =>
  z.enum(["spec", "ticket", "story", "review"]),
);

export const epicArtifactKindSchema = lazySchema(() =>
  z.enum([...markdownArtifactKindSchema.options, "html", "canvas", "file"]),
);

export const harnessIdSchemaPreReasonix = lazySchema(() =>
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

export const harnessIdSchema = lazySchema(() =>
  z.enum([
    ...harnessIdSchemaPreReasonix.options,
    "reasonix",
    "antigravity",
    "commandcode",
  ]),
);
