import { describe, expect, it } from "vitest";
import type { AgentSender } from "@traycer/protocol/persistence/epic/schemas";
import {
  agentModelKey,
  resolveAgentReasoningLabel,
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
