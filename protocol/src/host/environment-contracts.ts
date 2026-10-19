import { defineRpcContract } from "../framework/index";
import * as schemas from "./environment-schemas";

/**
 * The environment methods: every one a NEW name at
 * `@1.0`, off `RELEASED_FLOOR_METHOD_NAMES` and registered with
 * `degrade: { kind: "unsupported" }`, as `host.sandbox.repairGuestConfiguration`
 * was. A new method name is handshake-fatal against a released peer
 * otherwise; with the degrade, a host that predates a method (or composes no
 * resolver for it) leaves it out of its optional manifest and the GUI meets
 * `E_HOST_UNSUPPORTED`. Shapes and their plan sources:
 * `environment-schemas.ts`.
 *
 * Which carry the executable-write grant: `config.env.localOverride.set`,
 * `environment.agentDefinitions.put`, `environment.setup.put` and
 * `environment.undo`, the writes that reach an execution sink.
 * `environment.setup.retry` reruns content already authorised, and Review's
 * Apply goes through the dashboard, so neither takes one here.
 */
export const ENVIRONMENT_RPC_METHODS = {
  "providers.link": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.link",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.providersLinkRequestSchema,
            responseSchema: schemas.providersLinkResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "providers.linkComplete": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "providers.linkComplete",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.providersLinkCompleteRequestSchema,
            responseSchema: schemas.providersLinkCompleteResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.env.localOverride.set": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "config.env.localOverride.set",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.configEnvLocalOverrideSetRequestSchema,
            responseSchema: schemas.configEnvLocalOverrideResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "config.env.localOverride.clear": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "config.env.localOverride.clear",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.configEnvLocalOverrideClearRequestSchema,
            responseSchema: schemas.configEnvLocalOverrideResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.localOverrides": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.localOverrides",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentLocalOverridesRequestSchema,
            responseSchema: schemas.environmentLocalOverridesResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.list",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsListRequestSchema,
            responseSchema: schemas.environmentSecretsListResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.create": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.create",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsCreateRequestSchema,
            responseSchema: schemas.environmentSecretsCreateResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.verify": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.verify",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsVerifyRequestSchema,
            responseSchema: schemas.environmentSecretsVerifyResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.replaceValue": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.replaceValue",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsReplaceValueRequestSchema,
            responseSchema:
              schemas.environmentSecretsReplaceValueResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.versions": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.versions",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsVersionsRequestSchema,
            responseSchema: schemas.environmentSecretsVersionsResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.undo": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.undo",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsUndoRequestSchema,
            responseSchema: schemas.environmentSecretsUndoResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.destroy": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.destroy",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsDestroyRequestSchema,
            responseSchema: schemas.environmentSecretsDestroyResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.rotation": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.rotation",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsRotationRequestSchema,
            responseSchema: schemas.environmentSecretsRotationResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.consent": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.secrets.consent",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSecretsConsentRequestSchema,
            responseSchema: schemas.environmentSecretsConsentResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.agentDefinitions.list": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.agentDefinitions.list",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentAgentDefinitionsListRequestSchema,
            responseSchema:
              schemas.environmentAgentDefinitionsListResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.agentDefinitions.put": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.agentDefinitions.put",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentAgentDefinitionsPutRequestSchema,
            responseSchema: schemas.environmentWriteOutcomeSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.agentDefinitions.delete": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.agentDefinitions.delete",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema:
              schemas.environmentAgentDefinitionsDeleteRequestSchema,
            responseSchema: schemas.environmentWriteOutcomeSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.setup.get": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.setup.get",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSetupGetRequestSchema,
            responseSchema: schemas.environmentSetupGetResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.setup.put": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.setup.put",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSetupPutRequestSchema,
            responseSchema: schemas.environmentWriteOutcomeSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.setup.attempts": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.setup.attempts",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSetupAttemptsRequestSchema,
            responseSchema: schemas.environmentSetupAttemptsResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.reachDiagnostics": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.reachDiagnostics",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentReachDiagnosticsRequestSchema,
            responseSchema: schemas.environmentReachDiagnosticsResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.setup.retry": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.setup.retry",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentSetupRetryRequestSchema,
            responseSchema: schemas.environmentSetupRetryResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.status": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.status",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentStatusRequestSchema,
            responseSchema: schemas.environmentStatusResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.notices": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.notices",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentNoticesRequestSchema,
            responseSchema: schemas.environmentNoticesResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.undo": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.undo",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentUndoRequestSchema,
            responseSchema: schemas.environmentUndoResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.review": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "environment.review",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.environmentReviewRequestSchema,
            responseSchema: schemas.environmentReviewResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.remoteAccess.set": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineRpcContract({
            method: "host.remoteAccess.set",
            schemaVersion: { major: 1, minor: 0 },
            requestSchema: schemas.hostRemoteAccessSetRequestSchema,
            responseSchema: schemas.hostRemoteAccessSetResponseSchema,
          }),
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
} as const;
