/** Mirrors authn packages/common/src/notifications/account-settings.ts. */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { hostNotificationSeveritySchema } from "@traycer/protocol/host/notifications/contracts";
import { ITEM_OS_VALUES } from "./authn-environment-schemas";

/**
 * The account's notification settings: one row per account in authn, behind
 * `GET` / `PUT /api/v3/user/notification-settings`. A person's sign-in reads and
 * writes this row with no computer online. Every host of the account reads it
 * (on its device credential) for the renderer column of its matrix and its
 * hooks, in place of that part of its own `config/notification-configs.json`
 * and `notification-hooks.json`.
 *
 * The email channel is not here: its SMTP settings, its password and its matrix
 * column stay on each host, never uploaded and never overwritten by this row.
 *
 * New writes contain only literal HTTP hooks. Command actions and the held
 * field remain readable for legacy rows; writers remove those entries rather
 * than uploading them again.
 */

/** Per severity: whether that severity notifies on the renderer channel. */
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
    /** Legacy rows may contain header templates; new writes reject them. */
    headers: z.record(z.string().min(1).max(256), z.string().max(4096)),
  }),
);

const hookCommandActionSchema = lazySchema(() =>
  z.strictObject({
    type: z.literal("command"),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64),
    /** The OS the command exists on; a host of another OS does not run it. */
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
    /**
     * Retained for legacy rows. New account-row writes require false.
     */
    held: z.boolean(),
  }),
);
export type AccountNotificationHook = z.infer<
  typeof accountNotificationHookSchema
>;

/**
 * What the form check refuses in a hook list: two hooks sharing one id, a
 * command or an HTTP header value that interpolates a host's environment, and
 * `held` true.
 */
export const NOTIFICATION_HOOK_REFUSAL_CODES = [
  "hook_id_duplicate",
  "hook_local_only",
  "hook_held_invalid",
] as const;
export type NotificationHookRefusalCode =
  (typeof NOTIFICATION_HOOK_REFUSAL_CODES)[number];

/**
 * The 400 of the form check, on the account route and on a team's
 * `notification_hooks` item put. `index` is the refused entry's zero-based
 * position in the list sent; for a duplicate id, the later entry. The body
 * carries no hook id or URL.
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

/**
 * `GET /api/v3/user/notification-settings`, 200: the row, or null settings
 * before anything has written one (the reader then keeps its own defaults).
 * `revision` is the row's compare-and-set token.
 */
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
 * `PUT /api/v3/user/notification-settings` on a person's sign-in. The list
 * replaces the stored hooks whole (at most 64): a stored hook the list leaves
 * out is gone. `assertHooksWellFormed` judges the list sent and never the
 * stored row. The matrix is not read, checked or written. No row: created
 * with the default matrix and this list. `revision` is the row's, null to
 * create.
 *
 * 200: `accountNotificationSettingsResponseSchema` (the row after the write).
 * 409: `accountNotificationSettingsConflictSchema`, code `revision_conflict`,
 * when `revision` is not the row's.
 * 400 `hook_id_duplicate`: two hooks share one id.
 * 400 `hook_local_only`: a command, or an HTTP header value that interpolates
 * a host's environment.
 * 400 `hook_held_invalid`: `held` is true.
 * 400, no `code`: the body is malformed. The message is
 * `notification settings body is invalid: malformed`.
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
