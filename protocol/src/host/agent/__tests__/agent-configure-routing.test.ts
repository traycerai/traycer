import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  agentConfigureDowngradeV72ToV10,
  agentConfigureDowngradeV72ToV60,
  agentConfigureResponseSchemaV71,
  agentConfigureRequestSchemaV20,
  agentConfigureRequestSchemaV71,
  agentConfigureRequestSchemaV72,
  agentConfigureUpgradeV70ToV71,
  agentConfigureV70,
  agentConfigureV71,
  agentConfigureV72,
  agentConfigureUpgradeV71ToV72,
} from "../profiles";

/**
 * `agent.configure@7.1` lets a caller say what the agent does on a usage limit
 * or an error. `7.0` is released (`host-v1.5.1`), so it keeps its request
 * byte-for-byte and every older caller upgrades to "leave routing as it is".
 */

const tuple = {
  epicId: "epic-1",
  senderAgentId: "agent-1",
  agentId: "agent-2",
  harnessId: "claude",
  model: "opus-4.7",
  profileSelection: { kind: "profile", profileId: "profile-1" },
  reasoningEffort: "high",
  fastMode: false,
  permissionMode: "full_access",
} as const;

describe("agent.configure routing and service tier versions", () => {
  it("installs 7.1 over a 7.0 that keeps its released request", () => {
    const line = hostRpcRegistry["agent.configure"][7];
    expect(line.latestMinor).toBe(2);
    expect(line.versions[0].contract).toBe(agentConfigureV70);
    expect(line.versions[1].contract).toBe(agentConfigureV71);
    expect(line.versions[2].contract).toBe(agentConfigureV72);
    expect(agentConfigureV70.requestSchema).toBe(
      agentConfigureRequestSchemaV20,
    );
    expect(agentConfigureV70.responseSchema).toBe(
      agentConfigureV71.responseSchema,
    );
  });

  it("strips routing from a 7.0 request instead of reading it", () => {
    const parsed = agentConfigureRequestSchemaV20.parse({
      ...tuple,
      routing: "hold",
    });
    expect(Object.hasOwn(parsed, "routing")).toBe(false);
  });

  it("requires the key on 7.1, null meaning leave it as it is", () => {
    expect(agentConfigureRequestSchemaV71.safeParse(tuple).success).toBe(false);
    expect(
      agentConfigureRequestSchemaV71.parse({ ...tuple, routing: null }).routing,
    ).toBeNull();
    expect(
      agentConfigureRequestSchemaV72.parse({
        ...tuple,
        routing: "hold",
        serviceTier: null,
      }).routing,
    ).toBe("hold");
    expect(
      agentConfigureRequestSchemaV71.safeParse({ ...tuple, routing: "wait" })
        .success,
    ).toBe(false);
  });

  it("upgrades a 7.0 request to leave routing alone", () => {
    const upgraded = agentConfigureUpgradeV70ToV71.upgradeRequest(
      agentConfigureRequestSchemaV20.parse(tuple),
    );
    expect(upgraded.routing).toBeNull();
    expect(agentConfigureRequestSchemaV71.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("keeps 7.1 frozen and upgrades old responses with no service tier", () => {
    expect(
      agentConfigureRequestSchemaV71.parse({
        ...tuple,
        serviceTier: "priority",
        routing: null,
      }),
    ).not.toHaveProperty("serviceTier");
    expect(
      agentConfigureRequestSchemaV72.parse({
        ...tuple,
        serviceTier: "priority",
        routing: null,
      }).serviceTier,
    ).toBe("priority");
    const response = agentConfigureResponseSchemaV71.parse({
      settings: {
        harnessId: "claude",
        model: "opus-4.7",
        profileSelection: { kind: "profile", profileId: "profile-1" },
        reasoningEffort: "high",
        fastMode: false,
        permissionMode: "full_access",
        agentMode: "regular",
      },
      warnings: [],
    });
    expect(
      agentConfigureUpgradeV71ToV72.upgradeResponse(response).settings
        .serviceTier,
    ).toBeNull();
  });

  it("refuses to downgrade a request that names a routing", () => {
    expect(
      agentConfigureDowngradeV72ToV60.downgradeRequest(
        agentConfigureRequestSchemaV72.parse({
          ...tuple,
          routing: "hold",
          serviceTier: null,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
    expect(
      agentConfigureDowngradeV72ToV60.downgradeRequest(
        agentConfigureRequestSchemaV72.parse({
          ...tuple,
          routing: "policy",
          serviceTier: null,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });

  it("downgrades when serviceTier is null but refuses a named tier", () => {
    const request = agentConfigureRequestSchemaV72.parse({
      ...tuple,
      routing: null,
      serviceTier: null,
    });
    const result = agentConfigureDowngradeV72ToV60.downgradeRequest(request);
    expect(result).toEqual({ ok: true, value: tuple });
    expect(
      agentConfigureDowngradeV72ToV60.downgradeRequest(
        agentConfigureRequestSchemaV72.parse({
          ...tuple,
          routing: null,
          serviceTier: "priority",
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
    expect(
      agentConfigureDowngradeV72ToV10.downgradeRequest(request),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });
});
