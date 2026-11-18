import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const hostAccountSettingsRefreshRequestSchema = lazySchema(() =>
  z.object({}),
);
export type HostAccountSettingsRefreshRequest = z.infer<
  typeof hostAccountSettingsRefreshRequestSchema
>;

export const hostAccountSettingsRefreshResponseSchema = lazySchema(() =>
  z.object({}),
);
export type HostAccountSettingsRefreshResponse = z.infer<
  typeof hostAccountSettingsRefreshResponseSchema
>;

/**
 * Drops only the caller's cached auto-approve policy, never another person's; a
 * call during a running refresh joins it. A team's computer does only that part.
 * Called once per connected host after an app's save, never on a timer.
 */
export const hostAccountSettingsRefreshV10 = defineRpcContract({
  method: "host.accountSettings.refresh",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostAccountSettingsRefreshRequestSchema,
  responseSchema: hostAccountSettingsRefreshResponseSchema,
});
