import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { accountNotificationHookSchema } from "./account-notification-schemas";

/** packages/common/src/environments/items.ts, notificationHooksValueSchema. */
export const notificationHooksValueSchema = lazySchema(() =>
  z.array(accountNotificationHookSchema).max(64),
);
