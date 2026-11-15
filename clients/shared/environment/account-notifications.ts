import { NotificationHookRefusalError } from "./notification-hook-refusal";
import {
  accountNotificationSettingsResponseSchema,
  notificationHookRefusalSchema,
  accountNotificationSettingsConflictSchema,
  accountNotificationMatrixPutRequestSchema,
  type AccountNotificationMatrixPutRequest,
  type AccountNotificationHooksPutRequest,
  type AccountNotificationSettingsResponse,
} from "./account-notification-schemas";
import {
  EnvironmentCloudError,
  errorBodyCode,
  parseSettings,
  sendSettings,
  settingsRefusal,
  type EnvironmentCloud,
} from "./environment-cloud";

export const ACCOUNT_NOTIFICATION_SETTINGS_ROUTE =
  "api/v3/user/notification-settings";

/** Only a refusal code crosses this seam, never authn's body or a hook's value. */
export class NotificationHooksLocalOnlyError extends NotificationHookRefusalError {
  constructor(index: number | null) {
    super("hook_local_only", index);
    this.name = "NotificationHooksLocalOnlyError";
  }
}

export function readAccountNotificationSettings(
  cloud: EnvironmentCloud,
): Promise<AccountNotificationSettingsResponse> {
  return sendSettings(
    cloud,
    "GET",
    ACCOUNT_NOTIFICATION_SETTINGS_ROUTE,
    null,
  ).then((answer) =>
    parseSettings(answer, accountNotificationSettingsResponseSchema),
  );
}

export function saveAccountNotificationMatrix(
  cloud: EnvironmentCloud,
  request: AccountNotificationMatrixPutRequest,
): Promise<AccountNotificationSettingsResponse> {
  const parsed = accountNotificationMatrixPutRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new EnvironmentCloudError(
      "invalid",
      "The settings request was refused.",
    );
  return writeAccountNotificationSettings(cloud, parsed.data);
}

export function saveAccountNotificationHooks(
  cloud: EnvironmentCloud,
  request: AccountNotificationHooksPutRequest,
): Promise<AccountNotificationSettingsResponse> {
  // The host's contribution is sent as answered. Authn, not this client,
  // judges its bounds; a 400 fails the same save without altering the list.
  return writeAccountNotificationSettings(cloud, request);
}

/** Each arm replaces only its own column. A stale row gets one fresh read and one retry. */
async function writeAccountNotificationSettings(
  cloud: EnvironmentCloud,
  request:
    | AccountNotificationMatrixPutRequest
    | AccountNotificationHooksPutRequest,
): Promise<AccountNotificationSettingsResponse> {
  let answer = await sendSettings(
    cloud,
    "PUT",
    ACCOUNT_NOTIFICATION_SETTINGS_ROUTE,
    request,
  );
  if (
    answer.status === 409 &&
    accountNotificationSettingsConflictSchema.safeParse(answer.body).success
  ) {
    const current = await readAccountNotificationSettings(cloud);
    answer = await sendSettings(
      cloud,
      "PUT",
      ACCOUNT_NOTIFICATION_SETTINGS_ROUTE,
      { ...request, revision: current.revision },
    );
  }
  if (answer.status === 400) {
    const refusal = notificationHookRefusalSchema.safeParse(answer.body);
    if (refusal.success) {
      if (refusal.data.code === "hook_local_only")
        throw new NotificationHooksLocalOnlyError(refusal.data.index);
      throw new NotificationHookRefusalError(
        refusal.data.code,
        refusal.data.index,
      );
    }
    if (errorBodyCode(answer.body) === "hook_local_only")
      throw new NotificationHooksLocalOnlyError(null);
  }
  if (answer.status === 409) throw settingsRefusal(answer);
  return parseSettings(answer, accountNotificationSettingsResponseSchema);
}
