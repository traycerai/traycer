import { describe, expect, it } from "vitest";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { releasedMethodNames } from "@traycer/protocol/host/__tests__/__fixtures__/released-method-names";
import {
  agentTuiPrepareLaunchUpgradeV10ToV11,
  agentTuiValidateForkProfileV10,
} from "@traycer/protocol/host/agent/tui/contracts";
import {
  prepareTuiLaunchRequestSchemaV11,
  validateTuiForkProfileRequestSchema,
  validateTuiForkProfileResponseSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";

/**
 * `agent.tui.validateForkProfile` is a new ADDITIVE unary method (tech plan
 * governing mechanism 2). It must ride the optional-capabilities channel with
 * `degrade: unsupported`, not the released floor: entering the floor would be
 * handshake-fatal for every peer that shipped before this method existed.
 *
 * `prepareLaunch@1.1` is a same-major minor bump that defaults the new
 * `forkSourceTuiAgentId` field so a v1.0-shaped payload upgrades cleanly.
 */
describe("agent.tui.validateForkProfile is optional, not floor", () => {
  it("is present in hostRpcRegistry", () => {
    expect(hostRpcRegistry["agent.tui.validateForkProfile"]).toBeDefined();
    expect(
      hostRpcRegistry["agent.tui.validateForkProfile"][1].versions[0].contract
        .method,
    ).toBe(agentTuiValidateForkProfileV10.method);
  });

  it("is absent from RELEASED_FLOOR_METHOD_NAMES", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "agent.tui.validateForkProfile",
    );
  });

  it("is absent from the guarded released-method-name fixture", () => {
    expect(releasedMethodNames).not.toContain("agent.tui.validateForkProfile");
  });

  it("advertises on the optional manifest at 1.0, not the floor manifest", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    expect(split.optionalManifest["agent.tui.validateForkProfile"]).toEqual({
      major: 1,
      minor: 0,
    });
    expect(split.manifest["agent.tui.validateForkProfile"]).toBeUndefined();
  });

  it('declares degrade: { kind: "unsupported" }', () => {
    const entry = hostRpcRegistry["agent.tui.validateForkProfile"];
    expect(Object.hasOwn(entry, "degrade")).toBe(true);
    expect("degrade" in entry ? entry.degrade : undefined).toEqual({
      kind: "unsupported",
    });
  });
});

describe("prepareTuiLaunchRequestSchemaV11 forkSourceTuiAgentId default", () => {
  const baseV10Payload = {
    harnessId: "claude" as const,
    epicId: "epic-1",
    model: null,
    agentMode: "regular" as const,
    tuiAgentId: "agent-1",
    harnessSessionId: null,
  };

  it("defaults forkSourceTuiAgentId to null on a v1.0-shaped payload", () => {
    const parsed = prepareTuiLaunchRequestSchemaV11.parse(baseV10Payload);
    expect(parsed.forkSourceTuiAgentId).toBeNull();
  });

  it("preserves an explicit non-null forkSourceTuiAgentId", () => {
    const parsed = prepareTuiLaunchRequestSchemaV11.parse({
      ...baseV10Payload,
      forkSourceTuiAgentId: "source-tui-1",
    });
    expect(parsed.forkSourceTuiAgentId).toBe("source-tui-1");
  });

  it("agentTuiPrepareLaunchUpgradeV10ToV11 fills forkSourceTuiAgentId: null", () => {
    const upgraded = agentTuiPrepareLaunchUpgradeV10ToV11.upgradeRequest({
      ...baseV10Payload,
      reasoningEffort: null,
      terminalAgentArgs: null,
      forkSourceHarnessSessionId: null,
      profileId: null,
    });
    expect(upgraded.forkSourceTuiAgentId).toBeNull();
  });
});

describe("validateTuiForkProfile request/response schemas", () => {
  it("accepts a bulk targetProfileIds request", () => {
    const parsed = validateTuiForkProfileRequestSchema.safeParse({
      epicId: "epic-1",
      sourceTuiAgentId: "source-1",
      targetProfileIds: [null, "work", "personal"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty targetProfileIds array", () => {
    const parsed = validateTuiForkProfileRequestSchema.safeParse({
      epicId: "epic-1",
      sourceTuiAgentId: "source-1",
      targetProfileIds: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts mixed admitted/rejected verdicts", () => {
    const parsed = validateTuiForkProfileResponseSchema.safeParse({
      verdicts: [
        {
          targetProfileId: "work",
          admitted: true,
          subcode: null,
          message: null,
        },
        {
          targetProfileId: "personal",
          admitted: false,
          subcode: "SCOPE_MISMATCH",
          message: "SCOPE_MISMATCH: scopes differ",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
