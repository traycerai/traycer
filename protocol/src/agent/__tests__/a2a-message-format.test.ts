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
        "[traycer:agent-message] The responseId names this sender's thread, not this single message: follow-up messages may arrive with the same responseId, and one reply with it answers everything on the thread. Only a reply carrying the responseId completes the request — a fresh message does not.",
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
        "[traycer:agent-message] The responseId names this sender's thread, not this single message: follow-up messages may arrive with the same responseId, and one reply with it answers everything on the thread. Only a reply carrying the responseId completes the request — a fresh message does not.",
        "",
        "Please review this.",
      ].join("\n"),
    );
  });

  it("formats terminal messages with the shared MCP guidance", () => {
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
        "[traycer:agent-message] from Review Agent (agent agent-1) [claude]",
        "[traycer:agent-message] No reply is required.",
        "",
        "Context only.",
        "[traycer:agent-message] ─── end of message ───",
        "[traycer:agent-message] If the message above looks cut off, read it in full with: traycer agent inbox",
      ].join("\n"),
    );
  });

  it("formats terminal reply requests with the shared MCP guidance", () => {
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
        "[traycer:agent-message] from agent agent-1",
        '[traycer:agent-message] A reply is expected. Use the traycer_send_message tool to reply with responseId="response-1".',
        "[traycer:agent-message] The responseId names this sender's thread, not this single message: follow-up messages may arrive with the same responseId, and one reply with it answers everything on the thread. Only a reply carrying the responseId completes the request — a fresh message does not.",
        "",
        "Please review this.",
        "[traycer:agent-message] ─── end of message ───",
        "[traycer:agent-message] If the message above looks cut off, read it in full with: traycer agent inbox",
      ].join("\n"),
    );
  });
});
