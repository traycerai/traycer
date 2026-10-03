import { defineRpcContract } from "../framework/index";
import * as schemas from "./profile-sync-schemas";

export const PROFILE_SYNC_RPC_METHODS = {
  "providers.profileCopy.sync.preview": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.sync.preview",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncSelectionSchema,
            responseSchema: schemas.profileSyncPreviewSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.sync.start": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.sync.start",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncStartSchema,
            responseSchema: schemas.profileSyncBatchSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.sync.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.sync.list",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncSourceRequestSchema,
            responseSchema: schemas.profileSyncListSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.sync.saveRule": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.sync.saveRule",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncSaveRuleSchema,
            responseSchema: schemas.profileSyncRuleSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.sync.stopRule": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.sync.stopRule",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncStopRuleSchema,
            responseSchema: schemas.profileSyncListSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.sync.resolve": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.sync.resolve",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncResolveSchema,
            responseSchema: schemas.profileSyncBatchSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.profileCopy.applySync": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.profileCopy.applySync",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileSyncApplySchema,
            responseSchema: schemas.profileSyncApplyResultSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
} as const;
