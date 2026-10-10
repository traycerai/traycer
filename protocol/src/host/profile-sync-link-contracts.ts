import { defineRpcContract } from "../framework/index";
import * as schemas from "./profile-sync-link-schemas";

/** Profile sync: the app asks the source host for statuses and intent; the
 * three `host.*` methods carry a sign-in between two linked hosts of one
 * user and never answer an app.
 *
 * `cancelAfterDispatch`: a read of statuses or of the peer's current sign-in
 * may be discarded once sent; every verb that records, drives a sync or
 * applies a sign-in may not. */
export const PROFILE_SYNC_LINK_RPC_METHODS = {
  "providers.profileSync.overview": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileSync.overview",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncOverviewRequestSchema,
            responseSchema: schemas.profileSyncOverviewSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileSync.syncNow": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileSync.syncNow",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncNowRequestSchema,
            responseSchema: schemas.profileSyncOverviewSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileSync.setKeepInSync": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileSync.setKeepInSync",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncKeepInSyncRequestSchema,
            responseSchema: schemas.profileSyncOverviewSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileSync.acceptAccount": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileSync.acceptAccount",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncAcceptAccountRequestSchema,
            responseSchema: schemas.profileSyncOverviewSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.profileSync.apply": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.profileSync.apply",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.hostProfileSyncApplyRequestSchema,
            responseSchema: schemas.hostProfileSyncApplyResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.profileSync.offerCredential": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.profileSync.offerCredential",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.hostProfileSyncOfferRequestSchema,
            responseSchema: schemas.hostProfileSyncOfferResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.profileSync.fetchCredential": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.profileSync.fetchCredential",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.hostProfileSyncFetchRequestSchema,
            responseSchema: schemas.hostProfileSyncFetchResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
} as const;
