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

/** Private Zod value for the V200 epic record. */
export const epicSchema = z.object({
  ...epicIdentityFields,
  // The live epic record's chats keep the event-type enum pinned to its pre-`chat.imported` vocabulary: adding an enum value to a persisted record is breaking, and the legacy `chats` map never carries an imported chat.
  chats: z.record(z.string(), chatSchemaPreImported),
  ...epicNonChatFields,
  // TUI agent sessions live alongside chats in their own map.
});
