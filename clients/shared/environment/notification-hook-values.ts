import type { NotificationHookConfig } from "@traycer/protocol/host/notifications/host-notifications";
import type { AccountNotificationHook } from "./account-notification-schemas";

export function notificationHookVariable(
  hook: NotificationHookConfig,
): string | null {
  if (hook.action.type !== "http") return null;
  for (const value of Object.values(hook.action.headers)) {
    const match =
      /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/u.exec(
        value,
      );
    const name = match?.[1] ?? match?.[2];
    if (name !== undefined) return `$${name}`;
  }
  return null;
}

export type CloudNotificationHook = Omit<NotificationHookConfig, "action"> & {
  readonly action: Extract<
    NotificationHookConfig["action"],
    { readonly type: "http" }
  >;
};

/**
 * A literal HTTP hook stays visible even if its legacy held flag was true: the
 * flag never stopped it running.
 */
export function accountHooksForEditor(
  hooks: readonly AccountNotificationHook[],
): CloudNotificationHook[] {
  const visible: CloudNotificationHook[] = [];
  for (const hook of hooks) {
    if (hook.action.type !== "http" || notificationHookVariable(hook) !== null)
      continue;
    visible.push({
      id: hook.id,
      name: hook.name,
      enabled: hook.enabled,
      severities: hook.severities,
      action: hook.action,
    });
  }
  return visible;
}
