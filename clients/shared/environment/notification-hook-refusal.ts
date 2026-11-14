import type { NotificationHookRefusalCode } from "./account-notification-schemas";
import { EnvironmentCloudError } from "./environment-cloud";

/** Safe form-check fields only; authn's free-text error never reaches the UI or logs. */
export class NotificationHookRefusalError extends EnvironmentCloudError {
  readonly code: NotificationHookRefusalCode;
  readonly index: number | null;

  constructor(code: NotificationHookRefusalCode, index: number | null) {
    super("invalid", "The settings request was refused.");
    this.name = "NotificationHookRefusalError";
    this.code = code;
    this.index = index;
  }
}
