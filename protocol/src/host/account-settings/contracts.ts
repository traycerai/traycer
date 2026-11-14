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
 * Re-reads what this host serves from the account's settings after an app
 * saved them in the cloud. The host re-reads the account's notification
 * settings, and drops the calling person's cached auto-approve policy so the
 * next `autoPolicy.get` reads the cloud; it drops only the caller's own entry,
 * never another person's. A call that arrives while a refresh is running joins
 * it. Served on every host kind; on a computer owned by a team it does only
 * the auto-approve part. An app calls it once per connected host after its own
 * save, never on a timer. Not an agent capability.
 */
export const hostAccountSettingsRefreshV10 = defineRpcContract({
  method: "host.accountSettings.refresh",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostAccountSettingsRefreshRequestSchema,
  responseSchema: hostAccountSettingsRefreshResponseSchema,
});
