import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { defineStreamRpcContract } from "../../framework/versioned-stream-rpc";
import { z } from "zod";
import { defineRpcContract, defineUpgradePath } from "../../framework/index";
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
export const organizationViewSchemaV10 = lazySchema(() =>
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
// Opaque cache invalidation token, not a cloud data version. Older hosts omit it.
export const organizationViewSchema = lazySchema(() =>
  organizationViewSchemaV10.extend({
    historyInvalidation: z.string().optional(),
  }),
);
export type OrganizationView = z.infer<typeof organizationViewSchema>;
export const organizationReadV10 = defineRpcContract({
  method: "organization.read",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: organizationReadSchema,
  responseSchema: organizationViewSchemaV10,
});
export const organizationRefreshV10 = defineRpcContract({
  method: "organization.refresh",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: organizationReadSchema,
  responseSchema: organizationViewSchemaV10,
});
export const organizationReadV11 = defineRpcContract({
  method: "organization.read",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: organizationReadSchema,
  responseSchema: organizationViewSchema,
});
export const organizationReadUpgradeV10ToV11 = defineUpgradePath<
  typeof organizationReadV10,
  typeof organizationReadV11
>({
  from: organizationReadV10.schemaVersion,
  to: organizationReadV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => organizationViewSchema.parse(response),
});
export const organizationRefreshV11 = defineRpcContract({
  method: "organization.refresh",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: organizationReadSchema,
  responseSchema: organizationViewSchema,
});
export const organizationRefreshUpgradeV10ToV11 = defineUpgradePath<
  typeof organizationRefreshV10,
  typeof organizationRefreshV11
>({
  from: organizationRefreshV10.schemaVersion,
  to: organizationRefreshV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => organizationViewSchema.parse(response),
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
      view: organizationViewSchemaV10,
    }),
  ),
  clientFrameSchema: lazySchema(() =>
    z.object({
      kind: z.literal("refresh"),
      hasBinaryPayload: z.literal(false),
    }),
  ),
});

export const organizationSubscribeV11 = defineStreamRpcContract({
  method: "organization.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: organizationReadSchema,
  serverFrameSchema: lazySchema(() =>
    organizationSubscribeV10.serverFrameSchema.extend({
      view: organizationViewSchema,
    }),
  ),
  clientFrameSchema: organizationSubscribeV10.clientFrameSchema,
});
