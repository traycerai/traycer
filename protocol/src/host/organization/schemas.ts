import {
  taskFiltersSchema,
  listTasksRequestSchema,
  listTasksResponseSchema,
  listTaskLightSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { z } from "zod";

// Decimal strings preserve all signed BIGINT values through JSON.
export const organizationVersionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) => BigInt(value) <= BigInt("9223372036854775807"),
    "Version is too large",
  );
const id = z.string().min(1).max(36);
export const labelNameSchema = z.string().trim().min(1).max(80);
export const organizationColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const SYSTEM_LABEL_OWNER = "__system_labels__";
export const systemLabelKeySchema = z.enum(["imported", "automation"]);
export const labelDefinitionSchema = z.object({
  ownerId: id,
  labelId: id,
  kind: z.enum(["custom", "system"]),
  systemKey: systemLabelKeySchema.nullable(),
  name: labelNameSchema,
  color: organizationColorSchema.nullable(),
  version: organizationVersionSchema,
});
export type LabelDefinition = z.infer<typeof labelDefinitionSchema>;
export const taskLabelSchema = labelDefinitionSchema.extend({
  assignmentId: id,
});
export type TaskLabel = z.infer<typeof taskLabelSchema>;
export const labelCatalogCommandSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    labelId: id,
    name: labelNameSchema,
    color: organizationColorSchema,
  }),
  z.object({
    operation: z.literal("update"),
    labelId: id,
    operationId: id,
    expectedVersion: organizationVersionSchema,
    name: labelNameSchema,
    color: organizationColorSchema,
  }),
  z.object({
    operation: z.literal("delete"),
    labelId: id,
    operationId: id,
    expectedVersion: organizationVersionSchema,
  }),
  z.object({
    operation: z.literal("copy"),
    taskId: id,
    sourceOwnerId: id,
    sourceLabelId: id,
    choice: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("create"),
        labelId: id,
        name: labelNameSchema,
      }),
      z.object({ kind: z.literal("reuse"), labelId: id }),
    ]),
  }),
]);
export type LabelCatalogCommand = z.infer<typeof labelCatalogCommandSchema>;
export const taskLabelOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("attach"),
    labelId: id,
    assignmentId: id,
    // null means never assigned; otherwise the exact removed lifetime observed.
    priorAssignmentId: id.nullable(),
  }),
  z.object({
    operation: z.literal("remove"),
    ownerId: id,
    labelId: id,
    assignmentId: id,
  }),
]);
/** One edit per assignment key keeps immutable batch retries safe without receipts. */
export function hasRepeatedTaskLabelAssignments(
  ownerId: string,
  operations: readonly (
    | { operation: "attach"; labelId: string }
    | { operation: "remove"; ownerId: string; labelId: string }
  )[],
): boolean {
  const keys = new Set<string>();
  return operations.some((operation) => {
    const key = JSON.stringify([
      operation.operation === "attach" ? ownerId : operation.ownerId,
      operation.labelId,
    ]);
    if (keys.has(key)) return true;
    keys.add(key);
    return false;
  });
}
export const applyTaskLabelsRequestSchema = z.object({
  taskId: id,
  operations: z.array(taskLabelOperationSchema).min(1).max(100),
});
export type ApplyTaskLabelsRequest = z.infer<
  typeof applyTaskLabelsRequestSchema
>;
const position = z.number().int().min(0).max(2147483647);
export const groupOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    groupId: id,
    name: labelNameSchema,
    color: organizationColorSchema,
    position,
  }),
  z.object({
    operation: z.literal("update"),
    groupId: id,
    name: labelNameSchema,
    color: organizationColorSchema,
  }),
  z.object({ operation: z.literal("delete"), groupId: id }),
  z.object({
    operation: z.literal("moveTask"),
    taskId: id,
    groupId: id,
    position,
  }),
  z.object({ operation: z.literal("removeTask"), taskId: id }),
  z.object({
    operation: z.literal("reorderGroups"),
    groupIds: z.array(id).max(1000),
  }),
  z.object({
    operation: z.literal("reorderMembers"),
    groupId: id,
    taskIds: z.array(id).max(1000),
  }),
]);
export const applyGroupOperationsRequestSchema = z.object({
  operationId: id,
  expectedVersion: organizationVersionSchema,
  operations: z.array(groupOperationSchema).min(1).max(100),
});
export type ApplyGroupOperationsRequest = z.infer<
  typeof applyGroupOperationsRequestSchema
>;
export const personalGroupsSchema = z.object({
  version: organizationVersionSchema,
  groups: z.array(
    z.object({
      groupId: id,
      name: labelNameSchema,
      color: organizationColorSchema,
      position,
    }),
  ),
  memberships: z.array(z.object({ taskId: id, groupId: id, position })),
});
export type PersonalGroups = z.infer<typeof personalGroupsSchema>;
export const personalAppearanceSchema = z.object({
  taskId: id,
  version: organizationVersionSchema,
  color: organizationColorSchema.nullable(),
  icon: z.string().max(32).nullable(),
});
export type PersonalAppearance = z.infer<typeof personalAppearanceSchema>;
export const patchPersonalAppearanceRequestSchema = z
  .object({
    taskId: id,
    operationId: id,
    expectedVersion: organizationVersionSchema,
    color: organizationColorSchema.nullable().optional(),
    icon: z.string().max(32).nullable().optional(),
  })
  .refine(
    (value) => value.color !== undefined || value.icon !== undefined,
    "Empty appearance patch",
  );
export type PatchPersonalAppearanceRequest = z.infer<
  typeof patchPersonalAppearanceRequestSchema
>;
export const readOrganizationTasksRequestSchema = z.object({
  taskIds: z.array(id).max(100),
});
// Permission revocation may advance the source version while forcing false.
// A stale response supplies that floor: persist a higher counter and recompute
// the current shell state before publishing again. No offline expiration.
export const publishAutomationRequestSchema = z.object({
  taskId: id,
  version: organizationVersionSchema,
  hasAutomation: z.boolean(),
});
export type PublishAutomationRequest = z.infer<
  typeof publishAutomationRequestSchema
>;
export const publishAutomationResponseSchema = z.object({
  version: organizationVersionSchema,
  disposition: z.enum(["applied", "acknowledged", "stale"]),
});
export type PublishAutomationResponse = z.infer<
  typeof publishAutomationResponseSchema
>;
// Versioned writes return the accepted head. Receipts live only at that head.
export const organizationMutationResultSchema = z.object({
  disposition: z.enum(["applied", "acknowledged", "conflict"]),
  version: organizationVersionSchema.optional(),
});
export type OrganizationMutationResult = z.infer<
  typeof organizationMutationResultSchema
>;

// Active labels plus the caller's removed lifetimes for safe reattachment.
export const taskLabelStateSchema = z.object({
  labels: z.array(taskLabelSchema),
  removed: z.array(z.object({ ownerId: id, labelId: id, assignmentId: id })),
});
export type TaskLabelState = z.infer<typeof taskLabelStateSchema>;

export const cloudTaskFiltersSchema = taskFiltersSchema.extend({
  labelNames: z.array(labelNameSchema).max(50).optional(),
  labelMatchMode: z.enum(["any", "all"]).optional(),
  groupIds: z.array(id).max(100).optional(),
  includeUngrouped: z.boolean().optional(),
});
export type CloudTaskFilters = z.infer<typeof cloudTaskFiltersSchema>;
export const cloudListTasksRequestSchema = listTasksRequestSchema.extend({
  filters: cloudTaskFiltersSchema.nullable(),
});
export type CloudListTasksRequest = z.infer<typeof cloudListTasksRequestSchema>;
export const taskOrganizationSchema = z.object({
  labels: z.array(taskLabelSchema),
  appearance: personalAppearanceSchema,
  group: z
    .object({
      groupId: id,
      name: labelNameSchema,
      color: organizationColorSchema,
    })
    .nullable(),
});
export type TaskOrganization = z.infer<typeof taskOrganizationSchema>;
// Cloud additive fields do not reshape released host RPC minors.
export const cloudListTaskLightSchema = listTaskLightSchema.extend({
  organization: taskOrganizationSchema.optional(),
});
export const cloudListTasksResponseSchema = listTasksResponseSchema.extend({
  tasks: z.array(cloudListTaskLightSchema),
  organizationFacets: z
    .object({ labelNames: z.array(labelNameSchema) })
    .optional(),
});
export type CloudListTasksResponse = z.infer<
  typeof cloudListTasksResponseSchema
>;
