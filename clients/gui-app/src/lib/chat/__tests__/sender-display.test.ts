import { describe, expect, it } from "vitest";
import type { AgentSender } from "@traycer/protocol/persistence/epic/schemas";
import type { OpenAgentSender } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import {
  agentModelKey,
  agentProviderLabel,
  knownHarnessId,
  resolveAgentReasoningLabel,
  resolveAgentSenderDisplay,
  type SenderDisplayContext,
} from "@/lib/chat/sender-display";

const SENDER: AgentSender = {
  type: "agent",
  harnessId: "codex",
  agentId: "gpt-5-codex",
  displayName: "GPT-5 Codex",
  reply: { expectsReply: false },
  inReplyTo: null,
};

function displayContext(
  modelReasoningLabels: SenderDisplayContext["modelReasoningLabels"],
): SenderDisplayContext {
  return {
    profile: null,
    collaborators: [],
    modelLabels: new Map(),
    modelReasoningLabels,
  };
}

describe("agentProviderLabel", () => {
  it("labels commandcode as Command Code and keeps the neighbours' labels", () => {
    expect(agentProviderLabel("commandcode")).toBe("Command Code");
    expect(agentProviderLabel("reasonix")).toBe("Reasonix");
    expect(agentProviderLabel("antigravity")).toBe("Antigravity");
  });

  it("labels a known harness with its friendly name", () => {
    expect(agentProviderLabel("claude")).toBe("Claude Code");
  });

  it("renders a harness this build does not know by its raw id", () => {
    expect(agentProviderLabel("zzz-future")).toBe("zzz-future");
  });
});

describe("knownHarnessId", () => {
  it("returns a harness id this build knows", () => {
    expect(knownHarnessId("claude")).toBe("claude");
  });

  it("returns null for a heard-from id this build does not know", () => {
    expect(knownHarnessId("zzz-future")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(knownHarnessId("")).toBeNull();
  });

  it("returns null for an inherited object key, not a harness", () => {
    expect(knownHarnessId("toString")).toBeNull();
  });
});

describe("resolveAgentSenderDisplay", () => {
  it("shows an unknown harness by its raw id with the sender's display name as the model", () => {
    const sender: OpenAgentSender = {
      type: "agent",
      harnessId: "zzz-future",
      agentId: "agent-1",
      displayName: "Future Agent",
      reply: { expectsReply: false },
      inReplyTo: null,
    };

    expect(
      resolveAgentSenderDisplay(sender, displayContext(new Map())),
    ).toEqual({ providerLabel: "zzz-future", modelLabel: "Future Agent" });
  });

  it("falls back to the agent id as the model when an unknown harness sender has no display name", () => {
    const sender: OpenAgentSender = {
      type: "agent",
      harnessId: "zzz-future",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    };

    expect(
      resolveAgentSenderDisplay(sender, displayContext(new Map())),
    ).toEqual({ providerLabel: "zzz-future", modelLabel: "agent-1" });
  });

  it("still labels a known harness sender with its friendly provider name", () => {
    expect(
      resolveAgentSenderDisplay(SENDER, displayContext(new Map()))
        .providerLabel,
    ).toBe("Codex");
  });
});

describe("resolveAgentReasoningLabel", () => {
  it("returns the selected model's reasoning option label", () => {
    const context = displayContext(
      new Map([
        [
          agentModelKey("codex", "gpt-5-codex"),
          new Map([["xhigh", "Extra High"]]),
        ],
      ]),
    );

    expect(resolveAgentReasoningLabel(SENDER, "xhigh", context)).toBe(
      "Extra High",
    );
  });

  it("falls back to the trimmed effort id when the catalog cannot resolve it", () => {
    expect(
      resolveAgentReasoningLabel(SENDER, " xhigh ", displayContext(new Map())),
    ).toBe("xhigh");
  });
});
