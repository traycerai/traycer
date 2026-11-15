import type { NotificationHookRefusalCode } from "./account-notification-schemas";
import { EnvironmentCloudError } from "./environment-cloud";

const PROVISIONAL_REFUSAL_COPY = {
  // provisional: no board sentence; asked of the head
  hook_id_duplicate: "The settings request was refused.",
  // provisional: no board sentence; asked of the head
  hook_held_invalid: "The settings request was refused.",
} as const;

/** Safe form-check fields only; authn's free-text error never reaches the UI or logs. */
export class NotificationHookRefusalError extends EnvironmentCloudError {
  readonly code: NotificationHookRefusalCode;
  readonly index: number | null;

  constructor(code: NotificationHookRefusalCode, index: number | null) {
    super(
      "invalid",
      code === "hook_local_only"
        ? "The settings request was refused."
        : PROVISIONAL_REFUSAL_COPY[code],
    );
    this.name = "NotificationHookRefusalError";
    this.code = code;
    this.index = index;
  }
}
