import { describe, expect, it } from "vitest";
import { formatAgentMessage } from "../a2a-message-format";

describe("formatAgentMessage", () => {
  it("formats GUI agent messages that expect a reply", () => {
    expect(
      formatAgentMessage({
        receiverChannel: "gui",
        sender: {
          agentId: "agent-1",
          title: "Review Agent",
          harnessId: "codex",
        },
        reply: { expectsReply: true, responseId: "response-1" },
        body: "Please review this.",
      }),
    ).toBe(
      [
        "[traycer:agent-message] from Review Agent (agent agent-1) [codex]",
        '[traycer:agent-message] A reply is expected. Use the traycer_send_message tool to reply with responseId="response-1".',
        "",
        "Please review this.",
      ].join("\n"),
    );
  });

  it("formats GUI reply requests without optional display metadata", () => {
    expect(
      formatAgentMessage({
        receiverChannel: "gui",
        sender: {
          agentId: "agent-1",
          title: null,
          harnessId: null,
        },
        reply: { expectsReply: true, responseId: "response-1" },
        body: "Please review this.",
      }),
    ).toBe(
      [
        "[traycer:agent-message] from agent agent-1",
        '[traycer:agent-message] A reply is expected. Use the traycer_send_message tool to reply with responseId="response-1".',
        "",
        "Please review this.",
      ].join("\n"),
    );
  });

  it("formats CLI inbox messages without a reply request", () => {
    expect(
      formatAgentMessage({
        receiverChannel: "cli",
        sender: {
          agentId: "agent-1",
          title: "Review Agent",
          harnessId: "claude",
        },
        reply: { expectsReply: false },
        body: "Context only.",
      }),
    ).toBe(
      [
        "",
        "[traycer inbox] message from Review Agent (agent agent-1) [claude]",
        "",
        "Context only.",
        "[traycer inbox] ─── end of message ───",
        "[traycer inbox] if the message above looks cut off, read it in full with: traycer agent inbox",
      ].join("\n"),
    );
  });

  it("formats CLI reply requests without optional display metadata", () => {
    expect(
      formatAgentMessage({
        receiverChannel: "cli",
        sender: {
          agentId: "agent-1",
          title: null,
          harnessId: null,
        },
        reply: { expectsReply: true, responseId: "response-1" },
        body: "Please review this.",
      }),
    ).toBe(
      [
        "",
        "[traycer inbox] message from agent agent-1 — responseId response-1",
        '[traycer inbox] a reply is expected — reply with: traycer agent send --to agent-1 --response-id response-1 --message "<your reply>"',
        "",
        "Please review this.",
        "[traycer inbox] ─── end of message ───",
        "[traycer inbox] if the message above looks cut off, read it in full with: traycer agent inbox",
      ].join("\n"),
    );
  });
});
