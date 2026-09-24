import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { defineStreamRpcContract } from "../../framework/versioned-stream-rpc";
import { z } from "zod";
import { defineRpcContract } from "../../framework/index";
import {
  labelCatalogCommandSchema,
  groupOperationSchema,
  organizationColorSchema,
  labelDefinitionSchema,
  personalGroupsSchema,
  personalAppearanceSchema,
  taskLabelStateSchema,
  cloudListTasksRequestSchema,
  cloudListTasksResponseSchema,
} from "./schemas";

const id = lazySchema(() => z.string().min(1).max(36));
const catalogAction = lazySchema(() =>
  z.discriminatedUnion("operation", [
    labelCatalogCommandSchema.options[0],
    labelCatalogCommandSchema.options[1].omit({
      expectedVersion: true,
      operationId: true,
    }),
    labelCatalogCommandSchema.options[2].omit({
      expectedVersion: true,
      operationId: true,
    }),
    labelCatalogCommandSchema.options[3],
  ]),
);
export const organizationActionSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("catalog"), command: catalogAction }),
    z.object({
      kind: z.literal("groups"),
      operations: z.array(groupOperationSchema).min(1).max(100),
    }),
    z.object({
      kind: z.literal("appearance"),
      taskId: id,
      color: organizationColorSchema.nullable().optional(),
      icon: z.string().max(32).nullable().optional(),
    }),
    z.object({
      kind: z.literal("labels"),
      taskId: id,
      operations: z
        .array(
          z.discriminatedUnion("operation", [
            z.object({ operation: z.literal("attach"), labelId: id }),
            z.object({
              operation: z.literal("remove"),
              ownerId: id,
              labelId: id,
            }),
          ]),
        )
        .min(1)
        .max(100),
    }),
  ]),
);
export type OrganizationAction = z.infer<typeof organizationActionSchema>;
// Stable across transport retries for 30 days; do not retry an older command.
// Reusing a retained command id with different data is invalid.
export const organizationCommandSchema = lazySchema(() =>
  z.object({
    commandId: id,
    action: organizationActionSchema,
  }),
);
export type OrganizationCommand = z.infer<typeof organizationCommandSchema>;
export const organizationReadSchema = lazySchema(() =>
  z.object({
    taskIds: z.array(id).max(100),
  }),
);
export const organizationViewSchema = lazySchema(() =>
  z.object({
    catalog: z.array(labelDefinitionSchema),
    groups: personalGroupsSchema,
    appearances: z.array(personalAppearanceSchema),
    taskLabels: z.record(z.string(), taskLabelStateSchema),
    ready: z.boolean(),
    authenticationRequired: z.boolean(),
    pending: z.array(
      z.object({
        commandIds: z.array(id),
        scope: z.string(),
        status: z.enum([
          "queued",
          "delivering",
          "retrying",
          "authentication-required",
        ]),
      }),
    ),
    failures: z.array(
      z.object({
        commandIds: z.array(id),
        scope: z.string(),
        reason: z.enum([
          "conflict",
          "forbidden",
          "deleted",
          "invalid",
          "dependency-failed",
        ]),
        message: z.string(),
      }),
    ),
  }),
);
export type OrganizationView = z.infer<typeof organizationViewSchema>;
export const organizationReadV10 = defineRpcContract({
  method: "organization.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: organizationReadSchema,
  responseSchema: organizationViewSchema,
});
export const organizationRefreshV10 = defineRpcContract({
  method: "organization.refresh",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: organizationReadSchema,
  responseSchema: organizationViewSchema,
});
export const organizationCommandV10 = defineRpcContract({
  method: "organization.command",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: organizationCommandSchema,
  responseSchema: lazySchema(() =>
    z.object({
      commandId: id,
      disposition: z.literal("durably-accepted"),
    }),
  ),
});
// Cloud filtering only sees confirmed state. Organization reads overlay local pending work.
export const organizationHistoryV10 = defineRpcContract({
  method: "organization.history",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: cloudListTasksRequestSchema,
  responseSchema: cloudListTasksResponseSchema,
});
export const organizationSubscribeV10 = defineStreamRpcContract({
  method: "organization.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: organizationReadSchema,
  serverFrameSchema: lazySchema(() =>
    z.object({
      kind: z.literal("snapshot"),
      hasBinaryPayload: z.literal(false),
      view: organizationViewSchema,
    }),
  ),
  clientFrameSchema: lazySchema(() =>
    z.object({
      kind: z.literal("refresh"),
      hasBinaryPayload: z.literal(false),
    }),
  ),
});
