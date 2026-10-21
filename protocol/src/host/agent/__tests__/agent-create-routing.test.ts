import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  agentCreateDowngradeV31ToV10,
  agentCreateDowngradeV31ToV20,
  agentCreateUpgradeV30ToV31,
  agentCreateV30,
  agentCreateV31,
} from "../contracts";
import {
  createAgentRequestSchemaV30,
  createAgentRequestSchemaV31,
} from "../shared";

/**
 * `agent.create@3.1` lets a caller say, at birth, what the new agent does on a
 * usage limit or an error. `3.0` is released, so it keeps its request
 * byte-for-byte; every 3.0 caller upgrades to "leave the agent on the default".
 */

const request = {
  senderAgentId: "agent-1",
  epicId: "epic-1",
  name: null,
  surface: "gui",
  harnessId: "claude",
  model: null,
  agentMode: "regular",
  reasoningEffort: null,
  fastMode: null,
  permissionMode: "full_access",
  workspace: null,
  profileSelection: { kind: "ambient" },
} as const;

describe("agent.create@3.1 routing", () => {
  it("installs 3.1 over a 3.0 that keeps its released request", () => {
    const line = hostRpcRegistry["agent.create"][3];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(agentCreateV30);
    expect(line.versions[1].contract).toBe(agentCreateV31);
    expect(agentCreateV30.requestSchema).toBe(createAgentRequestSchemaV30);
    expect(agentCreateV30.responseSchema).toBe(agentCreateV31.responseSchema);
  });

  it("strips routing from a 3.0 request instead of reading it", () => {
    const parsed = createAgentRequestSchemaV30.parse({
      ...request,
      routing: "hold",
    });
    expect(Object.hasOwn(parsed, "routing")).toBe(false);
  });

  it("requires the key on 3.1, null meaning the default", () => {
    expect(createAgentRequestSchemaV31.safeParse(request).success).toBe(false);
    expect(
      createAgentRequestSchemaV31.parse({ ...request, routing: null }).routing,
    ).toBeNull();
    expect(
      createAgentRequestSchemaV31.parse({ ...request, routing: "hold" })
        .routing,
    ).toBe("hold");
    expect(
      createAgentRequestSchemaV31.safeParse({
        ...request,
        routing: "elsewhere",
      }).success,
    ).toBe(false);
  });

  it("upgrades a 3.0 request to the default routing", () => {
    expect(
      agentCreateUpgradeV30ToV31.upgradeRequest(
        createAgentRequestSchemaV30.parse(request),
      ),
    ).toMatchObject({ routing: null });
  });

  it("still refuses to downgrade across majors, as every older line did", () => {
    const parsed = createAgentRequestSchemaV31.parse({
      ...request,
      routing: null,
    });
    for (const bridge of [
      agentCreateDowngradeV31ToV20,
      agentCreateDowngradeV31ToV10,
    ]) {
      expect(bridge.downgradeRequest(parsed)).toMatchObject({
        ok: false,
        error: { code: "DOWNGRADE_UNSUPPORTED" },
      });
    }
  });
});
