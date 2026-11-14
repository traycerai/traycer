/**
 * A save made in a host's settings, and the proposal it produces.
 *
 * No host commits a setting. A save made in a host's settings is written on
 * that host at once and takes effect there; the host then proposes the item
 * to authn on its own token, where it is always held, and the app that made
 * the edit applies that hold. This module is the wire between the host and
 * that app:
 *
 * - {@link settingsSaveAnswerSchema}: what every save answers. The save is
 *   durable on this host; `proposal` is the receipt of what the host will
 *   send, or null when the save proposes nothing (a value kept on this host
 *   only, or a host that serves no environment).
 * - {@link settingsProposalReceiptSchema}: the receipt. It carries what the
 *   app needs to find its own hold among authn's held changes and nothing
 *   else: never a hold id and never a value. The app recognises its hold by
 *   what it sent itself (`settings-save-mapping.ts`), never by anything a
 *   host returned.
 * - `environment.proposals` ({@link environmentProposalsV10}): this host's
 *   proposals and whether each still stands over the delivered setting on
 *   this host. Value-free, so it never carries a secret.
 *
 * Distinct from `environment.localOverrides`, which lists the values a
 * person chose to keep on this computer for good; a proposal lasts only
 * until its item is decided.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  environmentItemKindSchema,
  environmentOsSchema,
} from "@traycer/protocol/host/environment-schemas";

/** An item value as an item route carries it. */
export const settingValueSchema = lazySchema(() => z.json());
export type SettingValue = z.infer<typeof settingValueSchema>;

/** What a proposal asks for: the item written, or the item removed. */
export const SETTINGS_PROPOSAL_OPERATIONS = ["put", "delete"] as const;
export const settingsProposalOperationSchema = lazySchema(() =>
  z.enum(SETTINGS_PROPOSAL_OPERATIONS),
);
export type SettingsProposalOperation = z.infer<
  typeof settingsProposalOperationSchema
>;

/**
 * Where a proposal stands on the host that made it.
 *
 * - `queued`: kept on this host, durably, and not yet answered by authn
 *   (offline, or behind earlier proposals for the same environment).
 * - `proposed`: authn answered that it holds the change.
 * - `refused`: authn will not hold it; `reason` says why. The save itself
 *   stood: its answer was `saved`, and the value is in force on this
 *   computer only. `environment.proposals` keeps listing the item as a local
 *   override with this refused receipt. The app remembers nothing for it: no
 *   hold will ever match.
 */
export const SETTINGS_PROPOSAL_STATES = [
  "queued",
  "proposed",
  "refused",
] as const;

/**
 * Why authn would not hold a proposal, as far as this protocol knows.
 *
 * - `not_bound`: this computer is no longer in that environment, or stopped
 *   sharing with it.
 * - `too_large`: the value is over the size an environment takes.
 * - `invalid`: the environment does not take this value for this setting.
 * - `not_allowed`: this computer may not propose changes to that
 *   environment.
 *
 * A newer host may name a reason outside this list; it still parses, and
 * {@link readSettingsProposalRefusalReason} reads it as `unrecognised`.
 */
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
  /**
   * The operation id the host sends to authn's propose form, chosen by the
   * host when it queues the edit. The same id for every retry of this
   * proposal, so authn answers a replay with the same hold.
   */
  proposalId: lazySchema(() => z.uuid()),
  /** The environment the proposal is for, named when the save was made. */
  environmentId: lazySchema(() => z.string().min(1)),
  /** The host that made the save and sends the proposal. */
  hostId: lazySchema(() => z.string().min(1)),
  /**
   * The host's ownership generation (its `sharing_generation`) when the save
   * was made. A hold proposed under an earlier generation is not this
   * owner's.
   */
  sharingGeneration: lazySchema(() => z.number().int().nonnegative()),
  kind: environmentItemKindSchema,
  key: lazySchema(() => z.string().min(1).max(3072)),
  /** Null for a kind with no per-OS rows, as authn's item routes write it. */
  os: lazySchema(() => environmentOsSchema.nullable()),
  operation: settingsProposalOperationSchema,
} as const;

/**
 * The receipt of one proposal. Every field but `state` is fixed when the
 * save is made and never changes.
 */
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
 * The answer to every save made in a host's settings. `saved` means the
 * change is written on this host and in force here, whatever authn later
 * says; `proposal` is null when the save proposes nothing.
 */
export const settingsSaveAnswerSchema = lazySchema(() =>
  z.object({
    outcome: z.literal("saved"),
    proposal: settingsProposalReceiptSchema.nullable(),
  }),
);
export type SettingsSaveAnswer = z.infer<typeof settingsSaveAnswerSchema>;

// ── environment.proposals ───────────────────────────────────────────────────

/**
 * One item this host has proposed a change to, with its latest proposal.
 *
 * `localOverride` is whether this host's own edit still stands over what the
 * environment delivered.
 *
 * `deliveredRevision` is the revision of the delivered item this host's edit
 * sits on, fixed when the edit was made: not the latest revision delivered
 * since. Null when the item did not exist on this host then. It is this
 * host's own bookkeeping, shown for display. An app applying its own hold
 * expects the revision it read itself when the person made the edit, never
 * this one: this host may have received a later write before the save.
 */
export const environmentProposalSchema = lazySchema(() =>
  z.object({
    proposal: settingsProposalReceiptSchema,
    localOverride: z.boolean(),
    deliveredRevision: z.number().int().nonnegative().nullable(),
  }),
);
export type EnvironmentProposal = z.infer<typeof environmentProposalSchema>;

export const environmentProposalsRequestSchema = lazySchema(() => z.object({}));
export type EnvironmentProposalsRequest = z.infer<
  typeof environmentProposalsRequestSchema
>;

export const environmentProposalsResponseSchema = lazySchema(() =>
  z.object({ proposals: z.array(environmentProposalSchema) }),
);
export type EnvironmentProposalsResponse = z.infer<
  typeof environmentProposalsResponseSchema
>;

export const environmentProposalsV10 = defineRpcContract({
  method: "environment.proposals",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentProposalsRequestSchema,
  responseSchema: environmentProposalsResponseSchema,
});
