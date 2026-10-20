import { describe, expect, it } from "vitest";
import {
  upgradeRequestToVersion,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  agentSendMessageUpgradeV10ToV11,
  agentSendMessageV10,
  agentSendMessageV11,
} from "@traycer/protocol/host/agent/contracts";

const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;

const request = {
  epicId: "epic-1",
  senderAgentId: "agent-1",
  receiverAgentId: "agent-2",
  prompt: "hello",
  expectReply: false,
  responseId: null,
};

describe("agent.sendMessage@1.1 registry", () => {
  it("validates, and registers 1.1 with its upgrade path", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
    const line = hostRpcRegistry["agent.sendMessage"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(agentSendMessageV10);
    expect(line.versions[1].contract).toBe(agentSendMessageV11);
    expect(line.versions[1].upgradeFromPreviousVersion).toBe(
      agentSendMessageUpgradeV10ToV11,
    );
  });
});

describe("agent.sendMessage@1.1 workspace", () => {
  it("upgrades a 1.0 request with workspace: null", () => {
    const parsed = agentSendMessageV10.requestSchema.parse(request);
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["agent.sendMessage"],
      V10,
      V11,
      parsed,
    );
    expect(upgraded).toEqual({ ...parsed, workspace: null });
    expect(() =>
      agentSendMessageV11.requestSchema.parse(upgraded),
    ).not.toThrow();
  });

  it("the 1.0 schema strips workspace", () => {
    const parsed = agentSendMessageV10.requestSchema.parse({
      ...request,
      workspace: "/work/repo",
    });
    expect("workspace" in parsed).toBe(false);
  });

  it("1.1 keeps a given workspace", () => {
    const parsed = agentSendMessageV11.requestSchema.parse({
      ...request,
      workspace: "/work/repo",
    });
    expect(parsed.workspace).toBe("/work/repo");
  });

  it("1.1 defaults an absent workspace to null", () => {
    expect(
      agentSendMessageV11.requestSchema.parse(request).workspace,
    ).toBeNull();
  });

  it("the response schema is shared", () => {
    expect(agentSendMessageV11.responseSchema).toBe(
      agentSendMessageV10.responseSchema,
    );
  });
});
