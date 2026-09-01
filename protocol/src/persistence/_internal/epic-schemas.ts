import { z } from "zod";
import {
  chatSchemaPreImported,
  chatSchemaPreReasonix,
  deletedEpicArtifactSchema,
  epicArtifactSchema,
  roleClaimsSchema,
  tuiAgentSchema,
} from "@traycer/protocol/persistence/epic/schemas";

const epicIdentityFields = {
  id: z.string(),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
};

const epicNonChatFields = {
  artifacts: z.record(z.string(), epicArtifactSchema),
  deletedArtifacts: z.record(z.string(), deletedEpicArtifactSchema),
  tuiAgents: z.record(z.string(), tuiAgentSchema).default({}),
  roleClaims: roleClaimsSchema.default({}),
};

/** Epic 2.0 as shipped before the Reasonix persisted enum/union variants. */
export const epicSchemaPreReasonix = z.object({
  ...epicIdentityFields,
  chats: z.record(z.string(), chatSchemaPreReasonix),
  ...epicNonChatFields,
});

/**
 * Private Zod value for the V200 epic record.
 *
 * The on-disk shape stores artifacts in four parallel maps (specs,
 * tickets, stories, reviews) at V100; this schema collapses them into
 * a single `artifacts` map plus `deletedArtifacts` mirror, mirroring
 * the wire protocol's `epicArtifactLight*` family. The legacy
 * migration chain that terminates at V200 is responsible for producing
 * this unified shape before a record reaches the registry. Legacy V100
 * executions are converted to tickets (with nested spec/review children)
 * during migration, so V200 has no separate execution collection.
 *
 * This schema is the contract authority for the `epic` record's
 * TypeScript shape - `Epic` is derived from it in
 * `protocol/persistence/registry.ts` via `RecordValue<>`. Only that
 * registry imports this module; every other consumer (inside or
 * outside `protocol/`) reaches the schema through
 * `getRecordSchema(persistenceRecordRegistry, "epic")`.
 */
export const epicSchema = z.object({
  ...epicIdentityFields,
  // The live epic record's chats keep the event-type enum pinned to its
  // pre-`chat.imported` vocabulary: adding an enum value to a persisted
  // record is breaking, and the legacy `chats` map never carries an imported
  // chat. See `chatSchemaPreImported`.
  chats: z.record(z.string(), chatSchemaPreImported),
  ...epicNonChatFields,
  // TUI agent sessions live alongside chats in their own map. Records carry
  // resume metadata (harnessId + harnessSessionId + hostId +
  // workspaceFolders); supported transcripts come from host-local provider
  // session history and are not persisted in the epic record.
  // Default `{}` so existing epics without the field still parse.
  // Agent role claims, keyed by claimId. Agents self-designate a role over a
  // Task-local scope so peers can avoid duplicating responsibility; unrelated
  // to the collaborator ACL that `epic.batchUpdateRoles` manages.
  // Default `{}` so existing epics without the field still parse.
});
