/**
 * `providers.settingsFile.status` - whether the host's provider settings file
 * can be read as a whole.
 * `providers.settingsFile.reset` - set that file aside unchanged and start a
 * fresh one, on the user's explicit say-so.
 * `providers.settingsFile.resetProvider` - the same way out for ONE provider
 * whose own row cannot be read: copy the file aside, then drop only that row.
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
 *    works and every other provider can still be changed. From 1.1 it also
 *    names those providers (`unreadableProviderIds`): every write to such a
 *    provider is refused, so its key, toggle and CLI choice cannot be changed.
 *  - `reset` moves the document aside byte for byte (nothing is deleted from
 *    disk) and starts an empty one. Saved choices and keys in the old file stop
 *    being used. It is refused - `outcome: "readable"`, nothing touched - when
 *    the document is readable by the time the host acts, so a stale panel can
 *    never reset a working file.
 *  - `resetProvider` copies the whole document aside byte for byte, then
 *    rewrites it without that provider's row; every other row keeps its
 *    values. It is refused when the row reads (`readable`) or the whole
 *    document cannot be used (`document-unreadable`, the `reset` case).
 *
 * OPTIONAL capability. Never in `RELEASED_FLOOR_METHOD_NAMES`: the floor is
 * fail-closed on the method-name union, so a name present on only one peer
 * would make the whole connection incompatible. Registered with
 * `degrade: { kind: "unsupported" }`, so a host that predates them reports the
 * methods unsupported and the panel simply offers no reset.
 */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
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

export const providersSettingsFileStatusResponseSchemaV11 = lazySchema(() =>
  providersSettingsFileStatusResponseSchema.extend({
    /**
     * Providers whose own row cannot be read while the document as a whole
     * can: every write to them is refused until `resetProvider`. Empty when
     * `unreadable` is true - the whole-document reset is the way out then.
     * Plain ids, not the provider-id enum, so a newer host's provider never
     * fails an older panel's parse.
     */
    unreadableProviderIds: z.array(z.string().min(1)),
  }),
);
export type ProvidersSettingsFileStatusResponseV11 = z.infer<
  typeof providersSettingsFileStatusResponseSchemaV11
>;

export const providersSettingsFileStatusV11 = defineRpcContract({
  method: "providers.settingsFile.status",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: providersSettingsFileStatusRequestSchema,
  responseSchema: providersSettingsFileStatusResponseSchemaV11,
});

/** A 1.0 host names no provider rows: it reports only the whole document. */
export const providersSettingsFileStatusUpgradeV10ToV11 = defineUpgradePath<
  typeof providersSettingsFileStatusV10,
  typeof providersSettingsFileStatusV11
>({
  from: providersSettingsFileStatusV10.schemaVersion,
  to: providersSettingsFileStatusV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    unreadable: response.unreadable,
    unreadableProviderIds: [],
  }),
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

export const providersSettingsFileResetProviderRequestSchema = lazySchema(() =>
  z.object({
    /**
     * A plain id, not the provider-id enum: a host answers `readable` for a
     * provider it does not know, rather than an older host failing the parse.
     */
    providerId: z.string().min(1),
  }),
);
export type ProvidersSettingsFileResetProviderRequest = z.infer<
  typeof providersSettingsFileResetProviderRequestSchema
>;

/**
 * Every backup this call wrote, in order, on EVERY outcome: a backup holds the
 * whole document, keys included, so none may be left on disk unnamed. Empty
 * only when the call wrote none. File names, never paths, as with
 * `movedAsideFileName`.
 */
const backupFileNamesSchema = lazySchema(() => z.array(z.string().min(1)));

export const providersSettingsFileResetProviderResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("reset"),
      /**
       * The copy of the bytes this reset read and checked before it wrote
       * the new document. Another host sharing the folder can still write
       * between that check and the rename, so it is not necessarily a copy
       * of the bytes the rename replaced.
       */
      backupFileName: z.string().min(1),
      backupFileNames: backupFileNamesSchema,
      /** As in `providers.settingsFile.reset`: the reset is committed either way. */
      providersNotRestarted: z.array(z.string().min(1)),
    }),
    // The document is usable and this row reads, or the id is unknown.
    z.object({
      outcome: z.literal("readable"),
      backupFileNames: backupFileNamesSchema,
    }),
    // The whole document cannot be used: `providers.settingsFile.reset` is
    // the way out, and a fresh status says so.
    z.object({
      outcome: z.literal("document-unreadable"),
      backupFileNames: backupFileNamesSchema,
    }),
    // Another process kept changing the document, so nothing was written
    // over it.
    z.object({
      outcome: z.literal("changed"),
      backupFileNames: backupFileNamesSchema,
    }),
    // A failure after a backup existed. Nothing new was published.
    z.object({
      outcome: z.literal("failed"),
      backupFileNames: backupFileNamesSchema,
    }),
  ]),
);
export type ProvidersSettingsFileResetProviderResponse = z.infer<
  typeof providersSettingsFileResetProviderResponseSchema
>;

export const providersSettingsFileResetProviderV10 = defineRpcContract({
  method: "providers.settingsFile.resetProvider",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: providersSettingsFileResetProviderRequestSchema,
  responseSchema: providersSettingsFileResetProviderResponseSchema,
});
