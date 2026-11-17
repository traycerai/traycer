// Mirrors authn's account notification settings schema.
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { hostNotificationSeveritySchema } from "@traycer/protocol/host/notifications/contracts";
import { ITEM_OS_VALUES } from "./authn-environment-schemas";

// One row per account in authn, read by every host for its renderer column and hooks.
// The email channel stays on each host, never uploaded. New writes hold only literal
// HTTP hooks.

const accountNotificationMatrixSchema = lazySchema(() =>
  z.record(
    hostNotificationSeveritySchema,
    z.strictObject({ renderer: z.boolean() }),
  ),
);

const hookHttpActionSchema = lazySchema(() =>
  z.strictObject({
    type: z.literal("http"),
    url: z.string().min(1).max(2048),
    /** Legacy rows may hold header templates; new writes reject them. */
    headers: z.record(z.string().min(1).max(256), z.string().max(4096)),
  }),
);

const hookCommandActionSchema = lazySchema(() =>
  z.strictObject({
    type: z.literal("command"),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64),
    /** A host of another OS does not run the command. */
    os: z.enum(ITEM_OS_VALUES),
  }),
);

export const accountNotificationHookSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256).nullable(),
    enabled: z.boolean(),
    /** Null: every severity. */
    severities: z.array(hostNotificationSeveritySchema).min(1).nullable(),
    action: z.discriminatedUnion("type", [
      hookHttpActionSchema,
      hookCommandActionSchema,
    ]),
    /** Retained for legacy rows; new account-row writes require false. */
    held: z.boolean(),
  }),
);
export type AccountNotificationHook = z.infer<
  typeof accountNotificationHookSchema
>;

export const NOTIFICATION_HOOK_REFUSAL_CODES = [
  "hook_id_duplicate",
  "hook_local_only",
  "hook_held_invalid",
] as const;
export type NotificationHookRefusalCode =
  (typeof NOTIFICATION_HOOK_REFUSAL_CODES)[number];

/**
 * `index` is the refused entry's zero-based position in the list sent (for a
 * duplicate id, the later entry). The body carries no hook id or URL.
 */
export const notificationHookRefusalSchema = lazySchema(() =>
  z.strictObject({
    statusCode: z.literal(400),
    error: z.string(),
    code: z.enum(NOTIFICATION_HOOK_REFUSAL_CODES),
    index: z.number().int().nonnegative(),
  }),
);
export type NotificationHookRefusal = z.infer<
  typeof notificationHookRefusalSchema
>;

export const accountNotificationSettingsSchema = lazySchema(() =>
  z.strictObject({
    matrix: accountNotificationMatrixSchema,
    hooks: z.array(accountNotificationHookSchema).max(64),
  }),
);
export type AccountNotificationSettings = z.infer<
  typeof accountNotificationSettingsSchema
>;

/** Null settings before anything has written the row; `revision` is its compare-and-set token. */
export const accountNotificationSettingsResponseSchema = lazySchema(() =>
  z.strictObject({
    settings: accountNotificationSettingsSchema.nullable(),
    revision: z.number().int().nonnegative().nullable(),
  }),
);
export type AccountNotificationSettingsResponse = z.infer<
  typeof accountNotificationSettingsResponseSchema
>;

/**
 * The list replaces the stored hooks whole (at most 64); the matrix is not read
 * or written. `revision` null creates the row; a stale one is 409 `revision_conflict`.
 */
export const accountNotificationHooksPutRequestSchema = lazySchema(() =>
  z.strictObject({
    hooks: z.array(accountNotificationHookSchema).max(64),
    revision: z.number().int().nonnegative().nullable(),
  }),
);
export type AccountNotificationHooksPutRequest = z.infer<
  typeof accountNotificationHooksPutRequestSchema
>;

export const accountNotificationSettingsConflictSchema = lazySchema(() =>
  z.strictObject({
    code: z.literal("revision_conflict"),
    current: accountNotificationSettingsResponseSchema,
  }),
);
export type AccountNotificationSettingsConflict = z.infer<
  typeof accountNotificationSettingsConflictSchema
>;
