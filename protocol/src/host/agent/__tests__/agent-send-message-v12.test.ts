import { describe, expect, it } from "vitest";
import {
  upgradeRequestToVersion,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  agentSendMessageUpgradeV11ToV12,
  agentSendMessageV11,
  agentSendMessageV12,
} from "@traycer/protocol/host/agent/contracts";

const V11 = { major: 1, minor: 1 } as const;
const V12 = { major: 1, minor: 2 } as const;

const request = {
  epicId: "epic-1",
  senderAgentId: "agent-1",
  receiverAgentId: "agent-2",
  prompt: "hello",
  expectReply: false,
  responseId: null,
  workspace: null,
};

describe("agent.sendMessage@1.2 registry", () => {
  it("validates, and registers 1.2 as the latest minor with its upgrade path", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
    const line = hostRpcRegistry["agent.sendMessage"][1];
    expect(line.latestMinor).toBe(2);
    expect(line.versions[2].contract).toBe(agentSendMessageV12);
    expect(line.versions[2].upgradeFromPreviousVersion).toBe(
      agentSendMessageUpgradeV11ToV12,
    );
  });
});

describe("agent.sendMessage@1.2 attachments", () => {
  it("upgrades a 1.1 request with no attachments", () => {
    const parsed = agentSendMessageV11.requestSchema.parse(request);
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["agent.sendMessage"],
      V11,
      V12,
      parsed,
    );
    expect(upgraded).toEqual({ ...parsed, attachments: [] });
    expect(() =>
      agentSendMessageV12.requestSchema.parse(upgraded),
    ).not.toThrow();
  });

  it("the 1.1 schema, which an older host parses with, strips attachments", () => {
    const olderHostSchema =
      hostRpcRegistry["agent.sendMessage"][1].versions[1].contract
        .requestSchema;
    const parsed = olderHostSchema.parse({
      ...request,
      attachments: ["shot.png"],
    });
    expect("attachments" in parsed).toBe(false);
  });

  it("1.2 keeps the given file names in order and defaults an absent list to empty", () => {
    expect(
      agentSendMessageV12.requestSchema.parse({
        ...request,
        attachments: ["b.png", "a.jpg"],
      }).attachments,
    ).toEqual(["b.png", "a.jpg"]);
    expect(
      agentSendMessageV12.requestSchema.parse(request).attachments,
    ).toEqual([]);
  });

  it("the response schema is shared", () => {
    expect(agentSendMessageV12.responseSchema).toBe(
      agentSendMessageV11.responseSchema,
    );
  });
});
