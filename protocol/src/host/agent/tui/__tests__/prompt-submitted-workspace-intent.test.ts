import { describe, expect, it } from "vitest";
import {
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  tuiAgentPromptSubmittedRequestSchema,
  tuiAgentPromptSubmittedRequestSchemaV11,
} from "@traycer/protocol/host/agent/tui/unary-schemas";

const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;

const identity = {
  epicId: "epic-1",
  tuiAgentId: "agent-1",
  harnessSessionId: null,
  harnessId: "claude" as const,
  observedHarnessSessionId: null,
};

const worktreeIntent = {
  entries: [
    {
      kind: "local" as const,
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
    },
  ],
};

describe("agent.tui.promptSubmitted@1.1 workspace intent", () => {
  const registry = hostRpcRegistry["agent.tui.promptSubmitted"];

  it("is registered as latest minor 1", () => {
    expect(registry[1].latestMinor).toBe(1);
  });

  it("leaves absent worktreeIntent undefined (binding-as-stored)", () => {
    const parsed = tuiAgentPromptSubmittedRequestSchemaV11.parse(identity);
    expect(parsed.worktreeIntent).toBeUndefined();
  });

  it("accepts the rebind-mutation worktreeIntent shape", () => {
    const parsed = tuiAgentPromptSubmittedRequestSchemaV11.parse({
      ...identity,
      worktreeIntent,
    });
    expect(parsed.worktreeIntent).toEqual(worktreeIntent);
  });

  it("upgrades a 1.0 request to worktreeIntent: null", () => {
    const upgraded = upgradeRequestToVersion(registry, V10, V11, identity);
    expect(tuiAgentPromptSubmittedRequestSchemaV11.parse(upgraded)).toEqual(
      upgraded,
    );
    expect(upgraded.worktreeIntent).toBeNull();
  });

  it("response upgrade is identity", () => {
    const response = { accepted: true, pendingPromptContext: null };
    expect(upgradeResponseToVersion(registry, V10, V11, response)).toEqual(
      response,
    );
  });

  it("1.0 request schema strips worktreeIntent (old-host degrade)", () => {
    const parsed = tuiAgentPromptSubmittedRequestSchema.parse({
      ...identity,
      worktreeIntent,
    });
    expect(parsed).not.toHaveProperty("worktreeIntent");
  });
});
