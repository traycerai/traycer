// No host commits a setting: a host saves at once and proposes the item to authn
// on its own token, where it is held, and the app that made the edit applies the
// hold. Proposal receipts carry neither its hold id nor its value.
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  environmentItemKindSchema,
  environmentOsSchema,
} from "@traycer/protocol/host/environment-schemas";

export type SettingValue =
  | string
  | number
  | boolean
  | null
  | SettingValue[]
  | { [key: string]: SettingValue };

// `z.json()` spelled out member for member: its cycle runs through a const a
// `lazySchema` stand-in cannot carry.
export const settingValueSchema: z.ZodType<SettingValue, SettingValue> =
  lazySchema(() =>
    z.lazy(() =>
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(settingValueSchema),
        z.record(z.string(), settingValueSchema),
      ]),
    ),
  );

export const SETTINGS_PROPOSAL_OPERATIONS = ["put", "delete"] as const;
export const settingsProposalOperationSchema = lazySchema(() =>
  z.enum(SETTINGS_PROPOSAL_OPERATIONS),
);
export type SettingsProposalOperation = z.infer<
  typeof settingsProposalOperationSchema
>;

/** `refused`: the save itself stood and is in force on this computer only; no hold will match. */
export const SETTINGS_PROPOSAL_STATES = [
  "queued",
  "proposed",
  "refused",
] as const;

/** A newer host may name a reason outside this list; it reads as `unrecognised`. */
export const SETTINGS_PROPOSAL_REFUSAL_REASONS = [
  "not_bound",
  "too_large",
  "invalid",
  "not_allowed",
] as const;
export type SettingsProposalRefusalReason =
  (typeof SETTINGS_PROPOSAL_REFUSAL_REASONS)[number];

const knownRefusalReasonSchema = lazySchema(() =>
  z.enum(SETTINGS_PROPOSAL_REFUSAL_REASONS),
);

/** The wire field: any non-empty string, so a newer reason never fails a parse. */
export const settingsProposalRefusalReasonSchema = lazySchema(() =>
  z.string().min(1),
);

/** A refusal reason as this client reads it; `unrecognised` comes from a newer host. */
export function readSettingsProposalRefusalReason(
  reason: string,
): SettingsProposalRefusalReason | "unrecognised" {
  const parsed = knownRefusalReasonSchema.safeParse(reason);
  return parsed.success ? parsed.data : "unrecognised";
}

const receiptFields = {
  /** The same id for every retry, so authn answers a replay with the same hold. */
  proposalId: lazySchema(() => z.uuid()),
  environmentId: lazySchema(() => z.string().min(1)),
  hostId: lazySchema(() => z.string().min(1)),
  /** A hold proposed under an earlier generation is not this owner's. */
  sharingGeneration: lazySchema(() => z.number().int().nonnegative()),
  kind: environmentItemKindSchema,
  key: lazySchema(() => z.string().min(1).max(3072)),
  /** Null for a kind with no per-OS rows, as authn's item routes write it. */
  os: lazySchema(() => environmentOsSchema.nullable()),
  operation: settingsProposalOperationSchema,
} as const;

/** Every field but `state` is fixed when the save is made. */
export const settingsProposalReceiptSchema = lazySchema(() =>
  z.discriminatedUnion("state", [
    z.object({ ...receiptFields, state: z.literal("queued") }),
    z.object({ ...receiptFields, state: z.literal("proposed") }),
    z.object({
      ...receiptFields,
      state: z.literal("refused"),
      reason: settingsProposalRefusalReasonSchema,
    }),
  ]),
);
export type SettingsProposalReceipt = z.infer<
  typeof settingsProposalReceiptSchema
>;

/**
 * `deliveredRevision` is fixed when the edit was made, for display only: an app
 * applying its hold expects the revision it read itself.
 */
export const environmentProposalSchema = lazySchema(() =>
  z.object({
    proposal: settingsProposalReceiptSchema,
    localOverride: z.boolean(),
    deliveredRevision: z.number().int().nonnegative().nullable(),
  }),
);
const environmentPromotionSchema = lazySchema(() =>
  z.object({
    saveId: z.uuid(),
    /** Authn's exact hold revision, once the promoted proposal is accepted. */
    heldRevision: z.number().int().nonnegative().nullable(),
  }),
);

const environmentProposalSchemaV11 = lazySchema(() =>
  environmentProposalSchema.extend({
    promotion: environmentPromotionSchema.optional(),
  }),
);
const environmentPromotionSchemaV12 = lazySchema(() =>
  environmentPromotionSchema.extend({
    /** Absent without verified support. Null when the Move wrote no exact row. */
    moveWrittenRevision: z.number().int().nonnegative().nullable().optional(),
    /** The consumed acceptance when the Move wrote this exact address. */
    moveAcceptanceId: z.uuid().optional(),
  }),
);
const environmentProposalSchemaV12 = lazySchema(() =>
  environmentProposalSchema.extend({
    promotion: environmentPromotionSchemaV12.optional(),
  }),
);
export type EnvironmentProposal = z.infer<typeof environmentProposalSchemaV12>;

export const environmentProposalsRequestSchema = lazySchema(() => z.object({}));
const environmentProposalsRequestSchemaV11 = lazySchema(() =>
  z.object({ profileNameSaveIds: z.array(z.uuid()).optional() }),
);
export type EnvironmentProposalsRequest = z.infer<
  typeof environmentProposalsRequestSchemaV11
>;

const pendingProfileNameSchema = lazySchema(() =>
  z.object({
    saveId: z.uuid(),
    environmentId: z.string().min(1),
    providerId: z.string().min(1),
    profileId: z.string().min(1),
    name: z.string().min(1).max(64),
    baseName: z.string().min(1).max(64),
  }),
);
export type PendingProfileName = z.infer<typeof pendingProfileNameSchema>;

export const environmentProposalsResponseSchema = lazySchema(() =>
  z.object({ proposals: z.array(environmentProposalSchema) }),
);
const environmentProposalsResponseSchemaV11 = lazySchema(() =>
  z.object({
    proposals: z.array(environmentProposalSchemaV11),
    /** Client saves recorded locally and still awaiting promotion. */
    localSaveIds: z.array(z.uuid()).optional(),
    /** Only the pending record names the caller asked for by exact save id. */
    pendingProfileNames: z.array(pendingProfileNameSchema).optional(),
  }),
);
const environmentProposalsResponseSchemaV12 = lazySchema(() =>
  environmentProposalsResponseSchemaV11.extend({
    proposals: z.array(environmentProposalSchemaV12),
  }),
);
export type EnvironmentProposalsResponse = z.infer<
  typeof environmentProposalsResponseSchemaV12
>;

export const environmentProposalsV10 = defineRpcContract({
  method: "environment.proposals",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentProposalsRequestSchema,
  responseSchema: environmentProposalsResponseSchema,
});

export const environmentProposalsV11 = defineRpcContract({
  method: "environment.proposals",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentProposalsRequestSchemaV11,
  responseSchema: environmentProposalsResponseSchemaV11,
});

export const environmentProposalsV12 = defineRpcContract({
  method: "environment.proposals",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: environmentProposalsRequestSchemaV11,
  responseSchema: environmentProposalsResponseSchemaV12,
});

export const environmentProposalsUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentProposalsV10,
  typeof environmentProposalsV11
>({
  from: environmentProposalsV10.schemaVersion,
  to: environmentProposalsV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const environmentProposalsUpgradeV11ToV12 = defineUpgradePath<
  typeof environmentProposalsV11,
  typeof environmentProposalsV12
>({
  from: environmentProposalsV11.schemaVersion,
  to: environmentProposalsV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});
