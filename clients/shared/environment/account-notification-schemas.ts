/** Mirrors authn packages/common/src/notifications/account-settings.ts. */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { hostNotificationSeveritySchema } from "@traycer/protocol/host/notifications/contracts";
import { ITEM_OS_VALUES } from "./authn-environment-schemas";

/**
 * The account's notification settings (environments plan, migration page): one
 * row per account in authn, behind `GET` / `PUT
 * /api/v3/user/notification-settings`. A person's sign-in reads and writes
 * this row with no computer online. Every host of the account reads it (on
 * its device credential, as it reads the environment) for the renderer
 * column of its matrix and its hooks, in place of that part of its own
 * `config/notification-configs.json` and `notification-hooks.json`.
 *
 * The email channel is not here: its SMTP settings, its password and its
 * matrix column stay on each host, never uploaded and never overwritten by
 * this row.
 *
 * New writes contain only literal HTTP hooks. Command actions and the held
 * field remain readable for legacy rows; writers remove those entries
 * rather than uploading them again.
 */

/** Per severity: whether that severity notifies on the renderer channel. */
export const accountNotificationMatrixSchema = lazySchema(() =>
  z.record(
    hostNotificationSeveritySchema,
    z.strictObject({ renderer: z.boolean() }),
  ),
);
export type AccountNotificationMatrix = z.infer<
  typeof accountNotificationMatrixSchema
>;

/**
 * The matrix of a person who never chose: every severity notifies but
 * `info`. The one copy the host and the server both read.
 */
export const DEFAULT_ACCOUNT_NOTIFICATION_MATRIX: Readonly<AccountNotificationMatrix> =
  {
    info: { renderer: false },
    needs_action: { renderer: true },
    failure: { renderer: true },
    done: { renderer: true },
  };

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
 * `PUT /api/v3/user/notification-settings` on a person's sign-in. One of the
 * two strict bodies: this one names the matrix and no hooks key. The write
 * does not read, check or write the stored hooks. No row: created with this
 * matrix and no hooks. `revision` is the row's, null to create.
 *
 * 200: `accountNotificationSettingsResponseSchema` (the row after the write).
 * 409: `accountNotificationSettingsConflictSchema`, code `revision_conflict`,
 * when `revision` is not the row's.
 * 400, no `code`: the body is neither this shape nor
 * `accountNotificationHooksPutRequestSchema`. The message is
 * `notification settings body is invalid: malformed`.
 * This shape never answers `hook_id_duplicate`, `hook_local_only` or
 * `hook_held_invalid`.
 */
export const accountNotificationMatrixPutRequestSchema = lazySchema(() =>
  z.strictObject({
    matrix: accountNotificationMatrixSchema,
    revision: z.number().int().nonnegative().nullable(),
  }),
);
export type AccountNotificationMatrixPutRequest = z.infer<
  typeof accountNotificationMatrixPutRequestSchema
>;

/**
 * The other sign-in body on the same route. The list replaces the stored
 * hooks whole (at most 64): a stored hook the list leaves out is gone.
 * `assertHooksWellFormed` judges the list sent and never the stored row.
 * The matrix is not read, checked or written. No row: created with
 * `DEFAULT_ACCOUNT_NOTIFICATION_MATRIX` and this list.
 *
 * 200: `accountNotificationSettingsResponseSchema`.
 * 409: `accountNotificationSettingsConflictSchema`, code `revision_conflict`.
 * 400 `hook_id_duplicate`: two hooks share one id.
 * 400 `hook_local_only`: a command, or an HTTP header value that interpolates
 * a host's environment.
 * 400 `hook_held_invalid`: `held` is true.
 * 400, no `code`: the body is neither strict sign-in shape. The message is
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
