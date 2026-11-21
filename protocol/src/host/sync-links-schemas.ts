import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  PROFILE_SYNC_MAX_DEVICES,
  PROFILE_SYNC_MAX_PROFILES,
  profileSyncHostIdSchema,
} from "./profile-sync-link-schemas";

/**
 * Folders this computer still shares through a link made by released 1.5.4's
 * "Sync profiles". Both methods are optional at 1.0, off the released floor:
 * a host that does not advertise them has no linked-folder ask.
 */

/** The providers peer sync carried, spelled as the provider list spells them. */
export const syncLinksProviderIdSchema = lazySchema(() =>
  z.enum(["claude-code", "codex", "grok", "antigravity"]),
);
export type SyncLinksProviderId = z.infer<typeof syncLinksProviderIdSchema>;

/** A managed profile's id, or `"ambient"` for the Terminal account, as the provider list spells it. */
const syncLinksProfileIdSchema = lazySchema(() =>
  z.union([z.string().uuid(), z.literal("ambient")]),
);

/**
 * What the computer last reported to the host registry:
 * - `current`: a version that keeps the link syncing after the update;
 * - `needs-update`: 1.5.4 or older;
 * - `unknown`: no version reported, or the computer is not listed.
 */
export const syncLinksPeerVersionSchema = lazySchema(() =>
  z.enum(["current", "needs-update", "unknown"]),
);
export type SyncLinksPeerVersion = z.infer<typeof syncLinksPeerVersionSchema>;

export const syncLinksPeerSchema = lazySchema(() =>
  z.strictObject({
    hostId: profileSyncHostIdSchema,
    /** The host registry's name for the computer; `null` when it has none. */
    displayName: z.string().min(1).max(256).nullable(),
    version: syncLinksPeerVersionSchema,
  }),
);
export type SyncLinksPeer = z.infer<typeof syncLinksPeerSchema>;

/**
 * `renewing`: the sign-in renews itself, so only one computer can keep it
 * after a stop. `key`: an API key or a setup token, which every computer
 * keeps.
 */
export const syncLinksAccountClassSchema = lazySchema(() =>
  z.enum(["renewing", "key"]),
);
export type SyncLinksAccountClass = z.infer<typeof syncLinksAccountClassSchema>;

/**
 * `held-for-personal`: this computer is in Personal and the folder waits for
 * its linked computers to join before it moves.
 */
export const syncLinksHoldSchema = lazySchema(() =>
  z.enum(["none", "held-for-personal"]),
);
export type SyncLinksHold = z.infer<typeof syncLinksHoldSchema>;

export const syncLinksFolderSchema = lazySchema(() =>
  z.strictObject({
    providerId: syncLinksProviderIdSchema,
    profileId: syncLinksProfileIdSchema,
    /** The account row's own label on this computer. */
    label: z.string().min(1).max(128),
    accountClass: syncLinksAccountClassSchema,
    hold: syncLinksHoldSchema,
    /** This computer's direct links only, each computer once. */
    peers: z.array(syncLinksPeerSchema).min(1).max(PROFILE_SYNC_MAX_DEVICES),
  }),
);
export type SyncLinksFolder = z.infer<typeof syncLinksFolderSchema>;

export const syncLinksListRequestSchema = lazySchema(() => z.strictObject({}));
export const syncLinksListResponseSchema = lazySchema(() =>
  z.strictObject({
    /** A team computer is offered only "Stop syncing". */
    teamComputer: z.boolean(),
    folders: z.array(syncLinksFolderSchema).max(PROFILE_SYNC_MAX_PROFILES),
  }),
);
export type SyncLinksListResponse = z.infer<typeof syncLinksListResponseSchema>;

/**
 * The folders the ask showed, exactly. The host refuses the whole request,
 * changing nothing, when any of them is not listed now or is already
 * stopping.
 */
export const syncLinksStopRequestSchema = lazySchema(() =>
  z.strictObject({
    scope: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("folders"),
        folders: z
          .array(
            z.strictObject({
              providerId: syncLinksProviderIdSchema,
              profileId: syncLinksProfileIdSchema,
            }),
          )
          .min(1)
          .max(PROFILE_SYNC_MAX_PROFILES),
      }),
    ]),
  }),
);
export type SyncLinksStopRequest = z.infer<typeof syncLinksStopRequestSchema>;

export const syncLinksStopResponseSchema = lazySchema(() =>
  z.strictObject({
    accounts: z
      .array(
        z.strictObject({
          providerId: syncLinksProviderIdSchema,
          profileId: syncLinksProfileIdSchema,
          /**
           * `kept`: it keeps working here. `gave-up-copy`: it reads "Sign in
           * again" here. `waiting-for-peer`: a linked computer has not
           * answered yet, so the account keeps syncing with it until it does.
           */
          outcome: z.enum(["kept", "gave-up-copy", "waiting-for-peer"]),
        }),
      )
      .max(PROFILE_SYNC_MAX_PROFILES),
  }),
);
export type SyncLinksStopResponse = z.infer<typeof syncLinksStopResponseSchema>;

export const providersSyncLinksListV10 = defineRpcContract({
  method: "providers.syncLinks.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: syncLinksListRequestSchema,
  responseSchema: syncLinksListResponseSchema,
});

export const providersSyncLinksStopV10 = defineRpcContract({
  method: "providers.syncLinks.stop",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: syncLinksStopRequestSchema,
  responseSchema: syncLinksStopResponseSchema,
});
