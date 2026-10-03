import { defineRpcContract } from "../framework/index";
import type { ConnectionManifest } from "../framework/ws-protocol";
import { advertisedMajors } from "../framework/compat-helpers";
import * as schemas from "./profile-copy-schemas";

/** Schema presence is not runtime admission. No incomplete handler may be
 * registered: deriveHostManifest advertises only attached implementations.
 * These names stay off the released floor, with no unsafe fallback.
 */
export const PROFILE_COPY_RPC_METHODS = {
  // `cancelAfterDispatch`: reads and waits may be discarded once sent; every
  // verb that records, reserves or drives an attempt may not.
  "providers.profileCopy.preview": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.preview",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyPreviewRequestSchema,
            responseSchema: schemas.profileCopyPreviewResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.start": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.start",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyStartRequestSchema,
            responseSchema: schemas.profileCopyOperationResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.status": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.status",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyOperationRequestSchema,
            responseSchema: schemas.profileCopyOperationResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.cancel": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.cancel",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyOperationRequestSchema,
            responseSchema: schemas.profileCopyOperationResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.incoming": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.incoming",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyIncomingRequestSchema,
            responseSchema: schemas.profileCopyIncomingResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.draftStatus": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.draftStatus",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyDraftRequestSchema,
            responseSchema: schemas.profileCopyDraftResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.cancelDraft": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.cancelDraft",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyRevisionRequestSchema,
            responseSchema: schemas.profileCopyDraftResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.setPreference": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.setPreference",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyPreferenceRequestSchema,
            responseSchema: schemas.profileCopyDraftResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.verify": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.verify",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyRevisionRequestSchema,
            responseSchema: schemas.profileCopyDraftResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.confirmVerification": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.confirmVerification",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyVerificationDecisionRequestSchema,
            responseSchema: schemas.profileCopyDraftResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.confirmIdentity": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.confirmIdentity",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyIdentityDecisionRequestSchema,
            responseSchema: schemas.profileCopyDraftResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.retry": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.retry",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyRetryRequestSchema,
            responseSchema: schemas.profileCopyDraftResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.login.start": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.login.start",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyRevisionRequestSchema,
            responseSchema: schemas.profileCopyLoginResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.login.await": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.login.await",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyLoginControlRequestSchema,
            responseSchema: schemas.profileCopyLoginResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.login.touch": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.login.touch",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyLoginControlRequestSchema,
            responseSchema: schemas.profileCopyLoginResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.login.submitCode": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.login.submitCode",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopySubmitCodeRequestSchema,
            responseSchema: schemas.profileCopyLoginResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.profileCopy.login.cancel": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.profileCopy.login.cancel",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyLoginControlRequestSchema,
            responseSchema: schemas.profileCopyLoginResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.profileCopy.preflight": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.profileCopy.preflight",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.hostProfileCopyPreflightRequestSchema,
            responseSchema: schemas.hostProfileCopyPreflightResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.profileCopy.import": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.profileCopy.import",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.hostProfileCopyImportRequestSchema,
            responseSchema: schemas.hostProfileCopyReceiptResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.profileCopy.receipt": {
    cancelAfterDispatch: true,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.profileCopy.receipt",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyDraftRequestSchema,
            responseSchema: schemas.hostProfileCopyReceiptResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.profileCopy.cancel": {
    cancelAfterDispatch: false,
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.profileCopy.cancel",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.profileCopyDraftRequestSchema,
            responseSchema: schemas.hostProfileCopyReceiptResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
} as const;

export type ProfileCopyMethod = keyof typeof PROFILE_COPY_RPC_METHODS;

export const PROFILE_COPY_INTERNAL_METHODS = [
  "host.profileCopy.preflight",
  "host.profileCopy.import",
  "host.profileCopy.receipt",
  "host.profileCopy.cancel",
] as const;

/** A wire-only gate. Consult live route/adapter admission separately and recheck
 * at start. Caller supplies each peer's actually served, handshake manifest;
 * never substitute the shared installed registry. No credential dispatch is
 * possible through this helper. Missing or incompatible methods mean update.
 */
export function profileCopyMethodSupport(
  sourceManifest: ConnectionManifest | null,
  destinationManifest: ConnectionManifest | null,
  sourceMethods: readonly ProfileCopyMethod[],
  destinationMethods: readonly ProfileCopyMethod[],
): "supported" | "update-required" {
  for (const [manifest, methods] of [
    [sourceManifest, sourceMethods],
    [destinationManifest, destinationMethods],
  ] as const) {
    for (const method of methods) {
      const entry = manifest?.[method];
      if (entry === undefined || !advertisedMajors(entry).includes(1)) {
        return "update-required";
      }
    }
  }
  return "supported";
}
