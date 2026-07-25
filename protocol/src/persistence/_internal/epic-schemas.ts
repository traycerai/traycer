import { z } from "zod";
import {
  chatSchema,
  deletedEpicArtifactSchema,
  epicArtifactSchema,
  tuiAgentSchema,
} from "@traycer/protocol/persistence/epic/schemas";

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
  id: z.string(),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  chats: z.record(z.string(), chatSchema),
  artifacts: z.record(z.string(), epicArtifactSchema),
  deletedArtifacts: z.record(z.string(), deletedEpicArtifactSchema),
  // TUI agent sessions live alongside chats in their own map. Records carry
  // resume metadata (harnessId + harnessSessionId + hostId +
  // workspaceFolders); supported transcripts come from host-local provider
  // session history and are not persisted in the epic record.
  // Default `{}` so existing epics without the field still parse.
  tuiAgents: z.record(z.string(), tuiAgentSchema).default({}),
});
