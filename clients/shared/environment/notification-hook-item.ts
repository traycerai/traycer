import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { accountNotificationHookSchema } from "./account-notification-schemas";

/** Mirrors authn's `notificationHooksValueSchema`. */
export const notificationHooksValueSchema = lazySchema(() =>
  z.array(accountNotificationHookSchema).max(64),
);
