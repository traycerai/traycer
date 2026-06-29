import { describe, expect, it } from "vitest";
import { contentBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { userMessageSchema } from "@traycer/protocol/persistence/epic/messages";

describe("epic message schemas", () => {
  it("defaults omitted tool-call agent message metadata to null", () => {
    const parsed = contentBlockSchema.parse({
      blockId: "block-1",
      status: "completed",
      timestamp: 1,
      type: "tool_call",
      toolName: "shell",
      input: null,
      output: null,
      error: null,
    });

    expect(parsed.type).toBe("tool_call");
    if (parsed.type !== "tool_call") {
      throw new Error("Expected tool_call block.");
    }
    expect(parsed.agentMessageSend).toBeNull();
    // `progress` is additive + defaulted, so blocks persisted before it parse.
    expect(parsed.progress).toBeNull();
    // `startedAt` is additive + nullable/defaulted, so older tool-call blocks
    // parse and simply omit completed-duration rendering.
    expect(parsed.startedAt).toBeNull();
    // `endedAt` is additive + nullable/defaulted for the same reason.
    expect(parsed.endedAt).toBeNull();
  });

  it("parses the new terminal block statuses (interrupted / superseded) on ACTION blocks", () => {
    for (const status of ["interrupted", "superseded"] as const) {
      const parsed = contentBlockSchema.parse({
        blockId: `block-${status}`,
        status,
        timestamp: 1,
        type: "tool_call",
        toolName: "shell",
        input: null,
        output: null,
        error: null,
      });
      expect(parsed.status).toBe(status);
    }
  });

  it("REJECTS the action-only terminal statuses on non-action blocks", () => {
    // The accumulator never assigns interrupted/superseded to text/reasoning/
    // todo/error/compaction/steer/approval/interview, so the schema must not
    // model them either - it should reject such a record rather than silently
    // accept one the renderer doesn't produce.
    for (const status of ["interrupted", "superseded"] as const) {
      const result = contentBlockSchema.safeParse({
        blockId: `text-${status}`,
        status,
        timestamp: 1,
        type: "text",
        text: "hi",
      });
      expect(result.success).toBe(false);
    }
  });

  it("still parses legacy blocks using the original statuses", () => {
    for (const status of ["streaming", "completed", "errored"] as const) {
      const parsed = contentBlockSchema.parse({
        blockId: `block-${status}`,
        status,
        timestamp: 1,
        type: "command",
        command: "ls",
        cwd: null,
        exitCode: null,
        stdout: null,
        stderr: null,
      });
      expect(parsed.status).toBe(status);
    }
  });

  it("defaults omitted autonomous resume output file metadata to null", () => {
    const parsed = contentBlockSchema.parse({
      blockId: "resume-1",
      status: "completed",
      timestamp: 1,
      type: "autonomous_resume",
      triggers: [
        {
          kind: "command",
          title: "sleep 5",
          status: "completed",
          summary: "done",
          blockId: "tool-1",
        },
      ],
    });

    expect(parsed.type).toBe("autonomous_resume");
    if (parsed.type !== "autonomous_resume") {
      throw new Error("Expected autonomous_resume block.");
    }
    expect(parsed.triggers[0]?.outputFile).toBeNull();
  });

  it("rejects mismatched user-message sender provenance", () => {
    const result = userMessageSchema.safeParse({
      role: "user",
      messageId: "message-1",
      sender: { type: "user", userId: "user-1" },
      message: {
        kind: "agent",
        content: { type: "doc", content: [] },
        fromAgentId: "agent-1",
        senderTitle: null,
        senderHarnessId: null,
        reply: { expectsReply: false },
      },
      timestamp: 1,
      sessionAnchor: null,
    });

    expect(result.success).toBe(false);
  });
});
