import { z } from "zod";
import {
  defineRecordContract,
  defineVersionedRecordRegistry,
  type RecordValue,
} from "@traycer/protocol/framework/index";
import { jsonContentMarkSchema } from "@traycer/protocol/common/schemas";
import {
  attachmentMentionAttrsSchema,
  attachmentMentionNodeSchema,
  epicArtifactKindSchema,
  harnessIdSchema,
  permissionRoleSchema,
  ticketStatusSchema,
} from "@traycer/protocol/common/_internal/schemas";

/**
 * Shared-vocabulary record registry.
 *
 * Each entry wraps a leaf schema that's referenced from multiple
 * higher-level records (persistence epic, auth response envelopes, RPC
 * frame payloads). Versioning the vocabulary independently means a
 * change to `permissionRoleSchema` is one bump, even when 50+ embedders
 * reference it.
 *
 * Non-recursive schemas live in `protocol/common/_internal/schemas.ts`;
 * this file is the only one outside `_internal/` allowed to import
 * them directly. The recursive `jsonContentSchema` and its
 * `JsonContent` type alias are co-located here because `z.lazy()`
 * requires an explicit `z.ZodType<JsonContent>` annotation, and
 * keeping the alias in `_internal/` would force a type leak across
 * the privacy boundary.
 */

// ---- Recursive `json-content` schema (kept here, not in _internal/) -- //

/**
 * The recursive shape of a TipTap / ProseMirror JSON node.
 *
 * Declared here (not in `_internal/schemas.ts`) because `z.lazy()`'s
 * required `z.ZodType<JsonContent>` annotation needs a named alias,
 * and exporting that alias from `_internal/` would force a type leak
 * across the privacy boundary. Co-locating both the type alias and the
 * schema with the registry keeps `_internal/` opaque while still
 * letting the schema validate the recursive shape.
 *
 * This is the only record shape declared as a plain TS type - every
 * other record type is derived from its registered Zod schema via
 * `RecordValue<>` below. The recursive case is unavoidable: TS can't
 * derive a recursive type purely from `z.infer<>` of a `z.lazy()`
 * schema without an explicit annotation.
 */
export type JsonContent = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonContent[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

const jsonContentSchema: z.ZodType<JsonContent> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(jsonContentSchema).optional(),
    marks: z.array(jsonContentMarkSchema).optional(),
    text: z.string().optional(),
  }),
);

export const jsonContentRecordV100 = defineRecordContract({
  name: "json-content",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: jsonContentSchema,
});

export const attachmentMentionAttrsRecordV100 = defineRecordContract({
  name: "attachment-mention-attrs",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: attachmentMentionAttrsSchema,
});

export const attachmentMentionNodeRecordV100 = defineRecordContract({
  name: "attachment-mention-node",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: attachmentMentionNodeSchema,
});

export const permissionRoleRecordV100 = defineRecordContract({
  name: "permission-role",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: permissionRoleSchema,
});

export const ticketStatusRecordV100 = defineRecordContract({
  name: "ticket-status",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: ticketStatusSchema,
});

export const epicArtifactKindRecordV100 = defineRecordContract({
  name: "epic-artifact-kind",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: epicArtifactKindSchema,
});

export const harnessIdRecordV100 = defineRecordContract({
  name: "harness-id",
  schemaVersion: { major: 1, minor: 0 } as const,
  schema: harnessIdSchema,
});

export const commonRecordRegistry = defineVersionedRecordRegistry({
  "json-content": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: jsonContentRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "attachment-mention-attrs": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: attachmentMentionAttrsRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "attachment-mention-node": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: attachmentMentionNodeRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "permission-role": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: permissionRoleRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "ticket-status": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: ticketStatusRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "epic-artifact-kind": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: epicArtifactKindRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "harness-id": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: harnessIdRecordV100,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
});

export type CommonRecordRegistry = typeof commonRecordRegistry;

// Types via `RecordValue<>` so runtime + type stay in lock-step.
// `JsonContent` is declared above (recursive z.lazy() needs a named
// annotation); structurally identical to
// `RecordValue<CommonRecordRegistry, "json-content">`.
export type AttachmentMentionAttrs = RecordValue<
  CommonRecordRegistry,
  "attachment-mention-attrs"
>;
export type AttachmentMentionNode = RecordValue<
  CommonRecordRegistry,
  "attachment-mention-node"
>;
export type PermissionRole = RecordValue<CommonRecordRegistry, "permission-role">;
export type TicketStatus = RecordValue<CommonRecordRegistry, "ticket-status">;
export type EpicArtifactKind = RecordValue<
  CommonRecordRegistry,
  "epic-artifact-kind"
>;
export type HarnessId = RecordValue<CommonRecordRegistry, "harness-id">;
