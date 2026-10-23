import { defineRpcContract, defineUpgradePath } from "../framework/index";
import * as schemas from "./environment-schemas";

/**
 * The environment methods: every one a NEW name, introduced at `@1.0`, off
 * `RELEASED_FLOOR_METHOD_NAMES` and registered with
 * `degrade: { kind: "unsupported" }`, as
 * `host.sandbox.repairGuestConfiguration` was. A new method name is
 * handshake-fatal against a released peer otherwise; with the degrade, a host
 * that predates a method (or composes no resolver for it) leaves it out of its
 * optional manifest and the GUI meets `E_HOST_UNSUPPORTED`. Shapes:
 * `environment-schemas.ts`.
 *
 * Which carry the executable-write grant: `config.env.localOverride.set`,
 * `environment.agentDefinitions.put`, `environment.setup.put` and
 * `environment.undo`, the writes that reach an execution sink.
 * `environment.setup.retry` reruns content already authorised, and Review's
 * Apply goes through the dashboard, so neither takes one here.
 *
 * `@1.1` MINORs, each with its upgrade from `@1.0`: every
 * `environment.secrets.*` request names the environment it addresses (null
 * for the host's own) and `versions` answers a secret's removal;
 * `environment.status` answers the move's consent and planes;
 * `environment.review` answers the retrospective sheet's record. Neither
 * line has shipped, so none is a MAJOR.
 */
export const environmentSecretsListV10 = defineRpcContract({
  method: "environment.secrets.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsListRequestSchema,
  responseSchema: schemas.environmentSecretsListResponseSchema,
});

export const environmentSecretsListV11 = defineRpcContract({
  method: "environment.secrets.list",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsListRequestSchemaV11,
  responseSchema: schemas.environmentSecretsListResponseSchema,
});

export const environmentSecretsListUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsListV10,
  typeof environmentSecretsListV11
>({
  from: environmentSecretsListV10.schemaVersion,
  to: environmentSecretsListV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => response,
});

export const environmentSecretsCreateV10 = defineRpcContract({
  method: "environment.secrets.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsCreateRequestSchema,
  responseSchema: schemas.environmentSecretsCreateResponseSchema,
});

export const environmentSecretsCreateV11 = defineRpcContract({
  method: "environment.secrets.create",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsCreateRequestSchemaV11,
  responseSchema: schemas.environmentSecretsCreateResponseSchema,
});

export const environmentSecretsCreateUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsCreateV10,
  typeof environmentSecretsCreateV11
>({
  from: environmentSecretsCreateV10.schemaVersion,
  to: environmentSecretsCreateV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => response,
});

export const environmentSecretsVersionsV10 = defineRpcContract({
  method: "environment.secrets.versions",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsVersionsRequestSchema,
  responseSchema: schemas.environmentSecretsVersionsResponseSchema,
});

export const environmentSecretsVersionsV11 = defineRpcContract({
  method: "environment.secrets.versions",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsVersionsRequestSchemaV11,
  responseSchema: schemas.environmentSecretsVersionsResponseSchemaV11,
});

export const environmentSecretsVersionsUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsVersionsV10,
  typeof environmentSecretsVersionsV11
>({
  from: environmentSecretsVersionsV10.schemaVersion,
  to: environmentSecretsVersionsV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => ({ ...response, removal: null }),
});

export const environmentSecretsDestroyV10 = defineRpcContract({
  method: "environment.secrets.destroy",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsDestroyRequestSchema,
  responseSchema: schemas.environmentSecretsDestroyResponseSchema,
});

export const environmentSecretsDestroyV11 = defineRpcContract({
  method: "environment.secrets.destroy",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsDestroyRequestSchemaV11,
  responseSchema: schemas.environmentSecretsDestroyResponseSchema,
});

export const environmentSecretsDestroyUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsDestroyV10,
  typeof environmentSecretsDestroyV11
>({
  from: environmentSecretsDestroyV10.schemaVersion,
  to: environmentSecretsDestroyV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => response,
});

export const environmentSecretsRotationV10 = defineRpcContract({
  method: "environment.secrets.rotation",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsRotationRequestSchema,
  responseSchema: schemas.environmentSecretsRotationResponseSchema,
});

export const environmentSecretsRotationV11 = defineRpcContract({
  method: "environment.secrets.rotation",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsRotationRequestSchemaV11,
  responseSchema: schemas.environmentSecretsRotationResponseSchema,
});

export const environmentSecretsRotationUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsRotationV10,
  typeof environmentSecretsRotationV11
>({
  from: environmentSecretsRotationV10.schemaVersion,
  to: environmentSecretsRotationV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => response,
});

export const environmentStatusV10 = defineRpcContract({
  method: "environment.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentStatusRequestSchema,
  responseSchema: schemas.environmentStatusResponseSchema,
});

export const environmentStatusV11 = defineRpcContract({
  method: "environment.status",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentStatusRequestSchema,
  responseSchema: schemas.environmentStatusResponseSchemaV11,
});

export const environmentStatusUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentStatusV10,
  typeof environmentStatusV11
>({
  from: environmentStatusV10.schemaVersion,
  to: environmentStatusV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    consent: null,
    planes: { records: "moved", broker: "moved", room: "moved" },
    returnedFromTeam: null,
  }),
});

export const environmentReviewV10 = defineRpcContract({
  method: "environment.review",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentReviewRequestSchema,
  responseSchema: schemas.environmentReviewResponseSchema,
});

export const environmentReviewV11 = defineRpcContract({
  method: "environment.review",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentReviewRequestSchema,
  responseSchema: schemas.environmentReviewResponseSchemaV11,
});

export const environmentReviewUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentReviewV10,
  typeof environmentReviewV11
>({
  from: environmentReviewV10.schemaVersion,
  to: environmentReviewV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    shownAt: null,
    acknowledgedAt: null,
    evidence: { version: null, at: null },
  }),
});

export const environmentSecretsVerifyV10 = defineRpcContract({
  method: "environment.secrets.verify",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsVerifyRequestSchema,
  responseSchema: schemas.environmentSecretsVerifyResponseSchema,
});

export const environmentSecretsVerifyV11 = defineRpcContract({
  method: "environment.secrets.verify",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsVerifyRequestSchemaV11,
  responseSchema: schemas.environmentSecretsVerifyResponseSchema,
});

export const environmentSecretsVerifyUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsVerifyV10,
  typeof environmentSecretsVerifyV11
>({
  from: environmentSecretsVerifyV10.schemaVersion,
  to: environmentSecretsVerifyV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => response,
});

export const environmentSecretsReplaceValueV10 = defineRpcContract({
  method: "environment.secrets.replaceValue",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsReplaceValueRequestSchema,
  responseSchema: schemas.environmentSecretsReplaceValueResponseSchema,
});

export const environmentSecretsReplaceValueV11 = defineRpcContract({
  method: "environment.secrets.replaceValue",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsReplaceValueRequestSchemaV11,
  responseSchema: schemas.environmentSecretsReplaceValueResponseSchema,
});

export const environmentSecretsReplaceValueUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsReplaceValueV10,
  typeof environmentSecretsReplaceValueV11
>({
  from: environmentSecretsReplaceValueV10.schemaVersion,
  to: environmentSecretsReplaceValueV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => response,
});

export const environmentSecretsUndoV10 = defineRpcContract({
  method: "environment.secrets.undo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsUndoRequestSchema,
  responseSchema: schemas.environmentSecretsUndoResponseSchema,
});

export const environmentSecretsUndoV11 = defineRpcContract({
  method: "environment.secrets.undo",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsUndoRequestSchemaV11,
  responseSchema: schemas.environmentSecretsUndoResponseSchema,
});

export const environmentSecretsUndoUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsUndoV10,
  typeof environmentSecretsUndoV11
>({
  from: environmentSecretsUndoV10.schemaVersion,
  to: environmentSecretsUndoV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => response,
});

export const environmentSecretsConsentV10 = defineRpcContract({
  method: "environment.secrets.consent",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: schemas.environmentSecretsConsentRequestSchema,
  responseSchema: schemas.environmentSecretsConsentResponseSchema,
});

export const environmentSecretsConsentV11 = defineRpcContract({
  method: "environment.secrets.consent",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: schemas.environmentSecretsConsentRequestSchemaV11,
  responseSchema: schemas.environmentSecretsConsentResponseSchema,
});

export const environmentSecretsConsentUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentSecretsConsentV10,
  typeof environmentSecretsConsentV11
>({
  from: environmentSecretsConsentV10.schemaVersion,
  to: environmentSecretsConsentV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, environmentId: null }),
  upgradeResponse: (response) => response,
});

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
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsListV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsListV11,
          upgradeFromPreviousVersion: environmentSecretsListUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.create": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsCreateV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsCreateV11,
          upgradeFromPreviousVersion: environmentSecretsCreateUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.verify": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsVerifyV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsVerifyV11,
          upgradeFromPreviousVersion: environmentSecretsVerifyUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.replaceValue": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsReplaceValueV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsReplaceValueV11,
          upgradeFromPreviousVersion:
            environmentSecretsReplaceValueUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.versions": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsVersionsV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsVersionsV11,
          upgradeFromPreviousVersion: environmentSecretsVersionsUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.undo": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsUndoV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsUndoV11,
          upgradeFromPreviousVersion: environmentSecretsUndoUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.destroy": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsDestroyV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsDestroyV11,
          upgradeFromPreviousVersion: environmentSecretsDestroyUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.rotation": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsRotationV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsRotationV11,
          upgradeFromPreviousVersion: environmentSecretsRotationUpgradeV10ToV11,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
  "environment.secrets.consent": {
    degrade: { kind: "unsupported" },
    1: {
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentSecretsConsentV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentSecretsConsentV11,
          upgradeFromPreviousVersion: environmentSecretsConsentUpgradeV10ToV11,
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
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentStatusV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentStatusV11,
          upgradeFromPreviousVersion: environmentStatusUpgradeV10ToV11,
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
      latestMinor: 1,
      versions: {
        0: {
          contract: environmentReviewV10,
          upgradeFromPreviousVersion: null,
        },
        1: {
          contract: environmentReviewV11,
          upgradeFromPreviousVersion: environmentReviewUpgradeV10ToV11,
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
