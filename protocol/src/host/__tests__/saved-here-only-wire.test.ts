import { describe, expect, it } from "vitest";
import { validateVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  configAgentMemoriesSetUpgradeV10ToV11,
  configAgentMemoriesSetV10,
  configAgentMemoriesSetV11,
} from "../config/contracts";
import {
  environmentAgentDefinitionsDeleteUpgradeV10ToV11,
  environmentAgentDefinitionsDeleteV10,
  environmentAgentDefinitionsDeleteV11,
  environmentAgentDefinitionsPutUpgradeV10ToV11,
  environmentAgentDefinitionsPutV10,
  environmentAgentDefinitionsPutV11,
  environmentSetupPutUpgradeV10ToV11,
  environmentSetupPutV10,
  environmentSetupPutV11,
} from "../environment-contracts";
import {
  environmentLocalWriteOutcomeSchema,
  environmentWriteOutcomeSchema,
} from "../environment-schemas";
import { hostRpcRegistry } from "../registry";

const BOUND_OUTCOME = { outcome: "pending", uploadId: "upload-1" } as const;
const LOCAL_OUTCOME = { outcome: "local_only" } as const;
const LOCAL_MEMORY_OUTCOME = { state: "local_only", enabled: true } as const;

describe("saved-here-only setting RPC minors", () => {
  it("adds only the local memory response arm at @1.1 and keeps @1.0 frozen", () => {
    const request = { enabled: true };
    expect(configAgentMemoriesSetV10.requestSchema.parse(request)).toEqual(
      request,
    );
    expect(
      configAgentMemoriesSetUpgradeV10ToV11.upgradeRequest(request),
    ).toEqual(request);

    const bound = {
      enabled: true,
      state: "queued",
      revision: null,
      environmentId: "environment-a",
      uploadId: "upload-1",
    } as const;
    expect(configAgentMemoriesSetV10.responseSchema.parse(bound)).toEqual(
      bound,
    );
    expect(configAgentMemoriesSetV11.responseSchema.parse(bound)).toEqual(
      bound,
    );
    expect(
      configAgentMemoriesSetV10.responseSchema.safeParse(LOCAL_MEMORY_OUTCOME)
        .success,
    ).toBe(false);
    expect(
      configAgentMemoriesSetV11.responseSchema.parse(LOCAL_MEMORY_OUTCOME),
    ).toEqual(LOCAL_MEMORY_OUTCOME);
    expect(
      configAgentMemoriesSetUpgradeV10ToV11.upgradeResponse(bound),
    ).toEqual(bound);
  });

  it("adds the local outcome to definitions put while preserving its @1.0 request and response", () => {
    const request = {
      name: "reviewer",
      text: "Review changes.",
      expectedRevision: null,
      executableWriteGrant: null,
    };
    expect(
      environmentAgentDefinitionsPutV10.requestSchema.parse(request),
    ).toEqual(request);
    expect(
      environmentAgentDefinitionsPutUpgradeV10ToV11.upgradeRequest(request),
    ).toEqual(request);
    expect(
      environmentAgentDefinitionsPutV10.responseSchema.parse(BOUND_OUTCOME),
    ).toEqual(BOUND_OUTCOME);
    expect(
      environmentAgentDefinitionsPutV11.responseSchema.parse(BOUND_OUTCOME),
    ).toEqual(BOUND_OUTCOME);
    expect(
      environmentAgentDefinitionsPutV10.responseSchema.safeParse(LOCAL_OUTCOME)
        .success,
    ).toBe(false);
    expect(
      environmentAgentDefinitionsPutV11.responseSchema.parse(LOCAL_OUTCOME),
    ).toEqual(LOCAL_OUTCOME);
    expect(
      environmentAgentDefinitionsPutUpgradeV10ToV11.upgradeResponse(
        BOUND_OUTCOME,
      ),
    ).toEqual(BOUND_OUTCOME);
  });

  it("adds the local outcome to definitions delete while preserving its @1.0 request and response", () => {
    const request = { name: "reviewer", expectedRevision: 7 };
    expect(
      environmentAgentDefinitionsDeleteV10.requestSchema.parse(request),
    ).toEqual(request);
    expect(
      environmentAgentDefinitionsDeleteUpgradeV10ToV11.upgradeRequest(request),
    ).toEqual(request);
    expect(
      environmentAgentDefinitionsDeleteV10.responseSchema.parse(BOUND_OUTCOME),
    ).toEqual(BOUND_OUTCOME);
    expect(
      environmentAgentDefinitionsDeleteV11.responseSchema.parse(BOUND_OUTCOME),
    ).toEqual(BOUND_OUTCOME);
    expect(
      environmentAgentDefinitionsDeleteV10.responseSchema.safeParse(
        LOCAL_OUTCOME,
      ).success,
    ).toBe(false);
    expect(
      environmentAgentDefinitionsDeleteV11.responseSchema.parse(LOCAL_OUTCOME),
    ).toEqual(LOCAL_OUTCOME);
    expect(
      environmentAgentDefinitionsDeleteUpgradeV10ToV11.upgradeResponse(
        BOUND_OUTCOME,
      ),
    ).toEqual(BOUND_OUTCOME);
  });

  it("adds the local outcome to setup put while preserving its @1.0 request and response", () => {
    const request = {
      os: "macos",
      text: "echo setup",
      expectedRevision: null,
      executableWriteGrant: null,
    } as const;
    expect(environmentSetupPutV10.requestSchema.parse(request)).toEqual(
      request,
    );
    expect(environmentSetupPutUpgradeV10ToV11.upgradeRequest(request)).toEqual(
      request,
    );
    expect(environmentSetupPutV10.responseSchema.parse(BOUND_OUTCOME)).toEqual(
      BOUND_OUTCOME,
    );
    expect(environmentSetupPutV11.responseSchema.parse(BOUND_OUTCOME)).toEqual(
      BOUND_OUTCOME,
    );
    expect(
      environmentSetupPutV10.responseSchema.safeParse(LOCAL_OUTCOME).success,
    ).toBe(false);
    expect(environmentSetupPutV11.responseSchema.parse(LOCAL_OUTCOME)).toEqual(
      LOCAL_OUTCOME,
    );
    expect(
      environmentSetupPutUpgradeV10ToV11.upgradeResponse(BOUND_OUTCOME),
    ).toEqual(BOUND_OUTCOME);
  });

  it("keeps the shared outcome unchanged and validates only the four additive registry lines", () => {
    expect(environmentWriteOutcomeSchema.safeParse(LOCAL_OUTCOME).success).toBe(
      false,
    );
    expect(environmentLocalWriteOutcomeSchema.parse(LOCAL_OUTCOME)).toEqual(
      LOCAL_OUTCOME,
    );

    const affected = {
      "config.agentMemories.set": hostRpcRegistry["config.agentMemories.set"],
      "environment.agentDefinitions.put":
        hostRpcRegistry["environment.agentDefinitions.put"],
      "environment.agentDefinitions.delete":
        hostRpcRegistry["environment.agentDefinitions.delete"],
      "environment.setup.put": hostRpcRegistry["environment.setup.put"],
    };
    expect(() => validateVersionedRpcRegistry(affected)).not.toThrow();

    expect(affected["config.agentMemories.set"][1].versions[0].contract).toBe(
      configAgentMemoriesSetV10,
    );
    expect(affected["config.agentMemories.set"][1].versions[1].contract).toBe(
      configAgentMemoriesSetV11,
    );
    expect(
      affected["config.agentMemories.set"][1].versions[1]
        .upgradeFromPreviousVersion,
    ).toBe(configAgentMemoriesSetUpgradeV10ToV11);

    for (const method of [
      "environment.agentDefinitions.put",
      "environment.agentDefinitions.delete",
      "environment.setup.put",
    ] as const) {
      const upgrade =
        method === "environment.agentDefinitions.put"
          ? environmentAgentDefinitionsPutUpgradeV10ToV11
          : method === "environment.agentDefinitions.delete"
            ? environmentAgentDefinitionsDeleteUpgradeV10ToV11
            : environmentSetupPutUpgradeV10ToV11;
      const contractV10 =
        method === "environment.agentDefinitions.put"
          ? environmentAgentDefinitionsPutV10
          : method === "environment.agentDefinitions.delete"
            ? environmentAgentDefinitionsDeleteV10
            : environmentSetupPutV10;
      const contractV11 =
        method === "environment.agentDefinitions.put"
          ? environmentAgentDefinitionsPutV11
          : method === "environment.agentDefinitions.delete"
            ? environmentAgentDefinitionsDeleteV11
            : environmentSetupPutV11;
      expect(affected[method][1].versions[0].contract).toBe(contractV10);
      expect(affected[method][1].versions[1].contract).toBe(contractV11);
      expect(affected[method][1].versions[1].upgradeFromPreviousVersion).toBe(
        upgrade,
      );
    }
  });
});
