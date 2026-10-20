/**
 * `providers.settingsFile.status` - whether the host's provider settings file
 * can be read as a whole.
 * `providers.settingsFile.reset` - set that file aside unchanged and start a
 * fresh one, on the user's explicit say-so.
 *
 * The host keeps every provider's saved choices, CLI selection, environment
 * overrides and any API key saved in Traycer in one settings document. When
 * the WHOLE document cannot be used - it could not be read, or its bytes do
 * not parse to a settings document - the host falls back to its defaults and
 * refuses every write, because a rewrite from defaults would replace every
 * saved choice and key with a fabrication. Nothing could get the user out of
 * that state from inside the app. These two methods are that way out:
 *
 *  - `status` answers `unreadable: true` only for that whole-document state.
 *    One malformed provider row is NOT it: the rest of the document still
 *    works and every other provider can still be changed.
 *  - `reset` moves the document aside byte for byte (nothing is deleted from
 *    disk) and starts an empty one. Saved choices and keys in the old file stop
 *    being used. It is refused - `outcome: "readable"`, nothing touched - when
 *    the document is readable by the time the host acts, so a stale panel can
 *    never reset a working file.
 *
 * OPTIONAL capability. Never in `RELEASED_FLOOR_METHOD_NAMES`: the floor is
 * fail-closed on the method-name union, so a name present on only one peer
 * would make the whole connection incompatible. Registered with
 * `degrade: { kind: "unsupported" }`, so a host that predates them reports the
 * methods unsupported and the panel simply offers no reset.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const providersSettingsFileStatusRequestSchema = lazySchema(() =>
  z.object({}),
);
export type ProvidersSettingsFileStatusRequest = z.infer<
  typeof providersSettingsFileStatusRequestSchema
>;

export const providersSettingsFileStatusResponseSchema = lazySchema(() =>
  z.object({
    /** True only when the whole settings document cannot be used. */
    unreadable: z.boolean(),
  }),
);
export type ProvidersSettingsFileStatusResponse = z.infer<
  typeof providersSettingsFileStatusResponseSchema
>;

export const providersSettingsFileStatusV10 = defineRpcContract({
  method: "providers.settingsFile.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSettingsFileStatusRequestSchema,
  responseSchema: providersSettingsFileStatusResponseSchema,
});

export const providersSettingsFileResetRequestSchema = lazySchema(() =>
  z.object({}),
);
export type ProvidersSettingsFileResetRequest = z.infer<
  typeof providersSettingsFileResetRequestSchema
>;

export const providersSettingsFileResetResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("reset"),
      /**
       * The name the old document now has, in the same folder. A FILE NAME,
       * never a path: the folder is under the user's home directory, and the
       * panel only needs to say what to look for.
       */
      movedAsideFileName: z.string().min(1),
      /**
       * Providers whose running processes could not be restarted on the new
       * settings. The reset itself is committed either way; a non-empty list
       * means those providers keep what they were started with until the
       * host restarts, and the panel says to restart Traycer. Plain ids, not
       * the provider-id enum, so a newer host's provider never fails an
       * older panel's parse.
       */
      providersNotRestarted: z.array(z.string().min(1)),
    }),
    // The document was readable when the host acted, so nothing was moved.
    z.object({ outcome: z.literal("readable") }),
  ]),
);
export type ProvidersSettingsFileResetResponse = z.infer<
  typeof providersSettingsFileResetResponseSchema
>;

export const providersSettingsFileResetV10 = defineRpcContract({
  method: "providers.settingsFile.reset",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSettingsFileResetRequestSchema,
  responseSchema: providersSettingsFileResetResponseSchema,
});
