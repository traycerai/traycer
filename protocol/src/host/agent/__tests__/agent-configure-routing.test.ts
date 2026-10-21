import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  agentConfigureDowngradeV71ToV10,
  agentConfigureDowngradeV71ToV60,
  agentConfigureRequestSchemaV20,
  agentConfigureRequestSchemaV71,
  agentConfigureUpgradeV70ToV71,
  agentConfigureV70,
  agentConfigureV71,
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

describe("agent.configure@7.1 routing", () => {
  it("installs 7.1 over a 7.0 that keeps its released request", () => {
    const line = hostRpcRegistry["agent.configure"][7];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(agentConfigureV70);
    expect(line.versions[1].contract).toBe(agentConfigureV71);
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
      agentConfigureRequestSchemaV71.parse({ ...tuple, routing: "hold" })
        .routing,
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

  it("refuses to downgrade a request that names a routing", () => {
    expect(
      agentConfigureDowngradeV71ToV60.downgradeRequest(
        agentConfigureRequestSchemaV71.parse({ ...tuple, routing: "hold" }),
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
    expect(
      agentConfigureDowngradeV71ToV60.downgradeRequest(
        agentConfigureRequestSchemaV71.parse({ ...tuple, routing: "policy" }),
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });

  it("downgrades a request that leaves routing alone without the key", () => {
    const result = agentConfigureDowngradeV71ToV60.downgradeRequest(
      agentConfigureRequestSchemaV71.parse({ ...tuple, routing: null }),
    );
    expect(result).toEqual({ ok: true, value: tuple });
    expect(
      agentConfigureDowngradeV71ToV10.downgradeRequest(
        agentConfigureRequestSchemaV71.parse({ ...tuple, routing: null }),
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });
});
